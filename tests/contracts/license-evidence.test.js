'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {buildReport,resolveDeclaredLicense}=require('../../tools/license-scan');
test('SPDX expressions preserve choices, conjunctions and balanced groups',()=>{
 for(const expression of ['(MIT OR Apache-2.0) AND Unicode-3.0','Apache-2.0 WITH LLVM-exception OR MIT','MIT/Apache-2.0'])assert.equal(resolveDeclaredLicense(expression).status,'confirmed');
 for(const expression of ['(MIT OR Apache-2.0','MIT OR','MIT; run','LicenseRef-Pending'])assert.equal(resolveDeclaredLicense(expression).status,'pending');
});
test('crate license receipts require matching lock checksum and attached text hashes',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pagesai-license-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'docs/licenses/cargo/dependency-1.0.0'),{recursive:true});
 fs.writeFileSync(path.join(root,'Cargo.toml'),'[package]\nname="fixture"\nversion="1.0.0"\nlicense="MIT"\n[dependencies]\ndependency="1"\n');
 fs.writeFileSync(path.join(root,'Cargo.lock'),'[[package]]\nname="dependency"\nversion="1.0.0"\nsource="registry+https://github.com/rust-lang/crates.io-index"\nchecksum="abc"\n');
 const rel='docs/licenses/cargo/dependency-1.0.0/LICENSE';fs.writeFileSync(path.join(root,rel),'fixture license text');
 const receipt={schemaVersion:1,packages:[{name:'dependency',version:'1.0.0',checksum:'abc',license:'MIT',licenseFiles:[{path:rel,sha256:crypto.createHash('sha256').update('fixture license text').digest('hex')}]}]};
 const evidence=path.join(root,'docs/licenses/cargo-evidence.json');fs.writeFileSync(evidence,JSON.stringify(receipt));
 const item=()=>buildReport(root).items.find(x=>x.name==='dependency');
 assert.equal(item().status,'confirmed');
 fs.appendFileSync(path.join(root,rel),'changed');assert.equal(item().status,'pending');
 fs.writeFileSync(path.join(root,rel),'fixture license text');receipt.packages[0].checksum='wrong';fs.writeFileSync(evidence,JSON.stringify(receipt));assert.equal(item().status,'pending');
});
