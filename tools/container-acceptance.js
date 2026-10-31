#!/usr/bin/env node
'use strict';
// Runs only on an isolated Docker builder. No production paths/config/services.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const model = require('../deploy/presets/model');
const root = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || 'container-evidence');
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
const report = { schemaVersion: 1, presets: [], images: {} };
const run = (args, env = {}, timeout = 600000) => execFileSync('docker', args, { cwd: root, env: { ...process.env, ...env }, timeout, stdio: ['ignore','pipe','pipe'], maxBuffer: 32 * 1024 * 1024 }).toString();
const pause = ms => new Promise(r => setTimeout(r, ms));
async function request(route, body, token) {
  let response;
  try {
    response = await fetch('http://127.0.0.1:8080' + route, { method: body ? 'POST' : 'GET', headers: { ...(body ? { 'Content-Type':'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
  } catch (error) {
    throw new Error(`${body ? 'POST' : 'GET'} ${route}: ${error.message}; cause=${error.cause?.code || error.cause?.message || 'unknown'}`);
  }
  const value = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
  return { status: response.status, value };
}
const expect = (condition, label) => { if (!condition) throw Error(label); };
async function main() {
  for (const base of ['node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205', 'mongo:7@sha256:c53852c00c23ca9f23fc39690350ffa9a80e3642fe8f96879726d8da0abe80a7']) run(['pull',base]);
  for (const name of ['app','gateway','mongo']) {
    run(['build','-f',`deploy/docker/Dockerfile.${name}`,'-t',`pagesai/${name}:local`,'.']);
    report.images[name] = JSON.parse(run(['image','inspect',`pagesai/${name}:local`]))[0].Id;
  }
  for (const base of ['node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205', 'mongo:7@sha256:c53852c00c23ca9f23fc39690350ffa9a80e3642fe8f96879726d8da0abe80a7']) {
    const image = JSON.parse(run(['image','inspect',base]))[0]; report.images[base] = { id:image.Id, repoDigests:image.RepoDigests };
  }
  for (const [preset, modules] of Object.entries(model.PRESETS)) {
    const env = { PAGESAI_MONGO_PASSWORD: crypto.randomBytes(32).toString('hex'), PAGESAI_BOOTSTRAP_TOKEN: crypto.randomBytes(32).toString('hex') };
    const project = 'pagesai-check-' + preset.replace(/\.yml$/,'');
    const args = ['compose','-p',project,'-f','deploy/presets/'+preset];
    try {
      run([...args,'--profile','setup','run','--rm','--no-deps','init'],env);
      run([...args,'up','-d','--no-build','--wait','--wait-timeout','180'],env,240000);
      expect((await request('/readyz')).status === 200, preset+' readiness');
      const password = crypto.randomBytes(24).toString('hex');
      const bootstrap = await request('/api/admin/bootstrap',{username:'release_admin',password,bootstrapToken:env.PAGESAI_BOOTSTRAP_TOKEN});
      expect(bootstrap.status===201,preset+' bootstrap must perform transaction-backed write');
      let login = await request('/api/auth/login',{username:'release_admin',password});
      expect(login.status===200 && login.value.token,preset+' login');
      expect((await request('/api/admin/users',null,login.value.token)).status===200,preset+' admin');
      for (const id of ['pages','disk','glim','mail','survey','paper']) {
        const result=await request('/'+id,null,login.value.token);
        expect(result.status===(modules.includes(id)?200:404),preset+' '+id+' module isolation');
      }
      run([...args,'restart','app'],env);
      let ready=false;
      for(let i=0;i<60;i++){try{if((await request('/readyz')).status===200){ready=true;break;}}catch{}await pause(1000);}
      expect(ready,preset+' ready after restart');
      login=await request('/api/auth/login',{username:'release_admin',password});
      expect(login.status===200,preset+' identity persisted across restart');
      report.presets.push({preset,modules,ready:true,transactionWrite:true,moduleIsolation:true,restartPersistence:true});
      fs.writeFileSync(path.join(out,'containers.json'),JSON.stringify(report,null,2)+'\n');
      console.log('PASS '+preset);
    } catch(error) {
      try{fs.writeFileSync(path.join(out,project+'.log'),run([...args,'logs','--no-color','--tail','120'],env));}catch{}
      fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({preset,message:error.message,stack:error.stack},null,2));
      throw Error(preset+' failed: '+error.message);
    } finally { run([...args,'down','-v','--remove-orphans'],env); }
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
