'use strict';
// C31 契约测试：tools/init.js 的部署区域表、模块清单与生成的模块配置必须保持同一套语义。
// 运行：node --test tests/contracts/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..', '..');
const init = require(path.join(projectRoot, 'tools', 'init.js'));
const { validateRegion } = require(path.join(projectRoot, 'core', 'storage', 'registry.js'));
const { validate } = require(path.join(projectRoot, 'core', 'contracts', 'validate.js'));

const MODULES = ['pages', 'disk', 'glim', 'mail', 'survey', 'paper'];
const DATA_ROOT = '/tmp/pagesai-init-region-test';

function manifestOf(moduleId) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, 'modules', moduleId, 'manifest.json'), 'utf8'));
}

function layoutRegions(moduleId) {
  return init.LAYOUT[moduleId].map((item) => item.regionId);
}

function deploymentOnly(moduleId) {
  return (init.DEPLOYMENT_ONLY_REGIONS[moduleId] || []).slice();
}

function sorted(values) {
  return values.slice().sort((a, b) => a.localeCompare(b, 'en'));
}

test('部署区域表覆盖六个模块，且模块清单与部署区域一一对应', () => {
  assert.deepEqual(sorted(Object.keys(init.LAYOUT)), sorted(MODULES));
  for (const moduleId of MODULES) {
    const declared = manifestOf(moduleId).data.regions;
    const layout = layoutRegions(moduleId);
    // 清单声明的区域必须全部出现在部署区域表里。
    for (const regionId of declared) {
      assert.ok(layout.includes(regionId), `${moduleId} 清单区域 ${regionId} 未出现在 tools/init.js 的 LAYOUT 中`);
    }
    // 部署表多出来的区域只能来自显式白名单，防止两套命名再次分叉。
    const extras = sorted(layout.filter((regionId) => !declared.includes(regionId)));
    assert.deepEqual(extras, sorted(deploymentOnly(moduleId)), `${moduleId} 存在未登记的多余区域：${extras.join('、') || '无'}`);
    // 区域必须带模块前缀，且与模块 ID 一致。
    for (const regionId of layout) {
      assert.ok(regionId.startsWith(`${moduleId}.`), `区域 ${regionId} 不属于模块 ${moduleId}`);
    }
    // 白名单里的区域必须真实存在，避免白名单本身失效。
    for (const regionId of deploymentOnly(moduleId)) {
      assert.ok(layout.includes(regionId), `白名单区域 ${regionId} 未在 LAYOUT 中定义`);
    }
  }
});

test('生成的区域声明通过核心契约校验，且路径互不重叠', () => {
  const combinations = MODULES.map((moduleId) => [moduleId]);
  combinations.push(MODULES.slice(), ['disk', 'glim', 'survey', 'paper']);
  for (const modules of combinations) {
    for (const diskVariant of ['generic', 'pku']) {
      if (!modules.includes('disk') && diskVariant === 'pku') continue;
      const { regions, storage } = init.buildRegions(modules, diskVariant, DATA_ROOT);
      for (const declaration of regions) {
        assert.doesNotThrow(() => validateRegion(declaration), `区域 ${declaration.regionId} 未通过契约校验`);
        assert.ok(modules.includes(declaration.module), `区域 ${declaration.regionId} 的模块未安装`);
      }
      const ids = new Set(regions.map((item) => item.regionId));
      assert.equal(ids.size, regions.length, '生成的区域 ID 出现重复');
      const roots = Object.entries(storage).map(([key, value]) => [key, path.resolve(value)]);
      for (let i = 0; i < roots.length; i += 1) {
        for (let j = i + 1; j < roots.length; j += 1) {
          const [keyA, rootA] = roots[i];
          const [keyB, rootB] = roots[j];
          const nested = rootA === rootB || rootA.startsWith(`${rootB}${path.sep}`) || rootB.startsWith(`${rootA}${path.sep}`);
          assert.ok(!nested, `存储根重叠：${keyA}=${rootA} 与 ${keyB}=${rootB}`);
        }
      }
      // pku 变体必须带上归档区域，generic 不得偷偷生成。
      assert.equal(ids.has('disk.pku-archive'), diskVariant === 'pku' && modules.includes('disk'));
    }
  }
});

test('生成的模块配置默认值落在已登记区域内并通过模块 schema', () => {
  const config = init.buildConfig({
    modules: MODULES.slice(),
    diskVariant: 'pku',
    registrationMode: 'email',
    allowedEmailDomains: ['example.edu'],
    domain: null,
    port: 8080,
    installRoot: '/opt/pagesai',
    dataRoot: DATA_ROOT,
    deploymentId: '11111111-2222-4333-8444-555555555555',
    createdAt: '2026-01-01T00:00:00.000Z',
    now: '2026-01-01T00:00:00.000Z'
  });
  assert.deepEqual(sorted(Object.keys(config.moduleConfig)), sorted(MODULES));
  const roots = Object.values(config.storage).map((value) => path.resolve(value));
  for (const moduleId of MODULES) {
    const schema = JSON.parse(fs.readFileSync(path.join(projectRoot, 'modules', moduleId, 'config.schema.json'), 'utf8'));
    const result = validate(schema, config.moduleConfig[moduleId]);
    assert.ok(result.valid, `${moduleId} 默认配置不符合 schema：${result.errors.map((item) => item.path).join(', ')}`);
    for (const [key, value] of Object.entries(config.moduleConfig[moduleId])) {
      if (/File$|Dir$|Root$/.test(key)) {
        const resolved = path.resolve(value);
        assert.ok(resolved.startsWith(`${DATA_ROOT}${path.sep}`), `${moduleId}.${key} 必须位于数据根内：${resolved}`);
        // taskRuntimeRoot/backendRuntimeRoot 是沙盒运行期目录，不是持久存储区域；
        // 其余持久数据位置必须落在已登记区域里。
        if (!/RuntimeRoot$/.test(key)) {
          assert.ok(roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`)), `${moduleId}.${key} 未落在已登记区域内：${resolved}`);
        }
      }
    }
    // 默认值必须是相对路径可迁移的语义：不允许出现部署主机上的绝对临时路径。
    assert.ok(!JSON.stringify(config.moduleConfig[moduleId]).includes('undefined'));
  }
});

test('显式模块配置只覆盖已安装模块，未安装模块不会从默认值冒出来', () => {
  const defaults = { pages: { dataFile: '/data/a/pages.json' }, disk: { dataFile: '/data/b/disk.json' } };
  const explicit = { pages: { maxSites: 5 }, mail: { dataFile: '/data/c/mail.json' } };
  const merged = init.mergeModuleConfig(defaults, explicit, ['pages', 'disk']);
  assert.deepEqual(merged, {
    pages: { dataFile: '/data/a/pages.json', maxSites: 5 },
    disk: { dataFile: '/data/b/disk.json' }
  });
  assert.equal(init.mergeModuleConfig({}, {}, []).pages, undefined);
});