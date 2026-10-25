#!/usr/bin/env node
'use strict';
/**
 * 逐包依赖与素材许可采集（C35）
 *
 * 目标：在不联网、不安装依赖、不读取任何凭据的前提下，把"随制品分发了什么、
 * 每项的许可证是否可确认"落成可复查的清单。根 LICENSE 的选择仍由 owner 决定，
 * 本工具只准备材料，不创建许可正文、不替 owner 选许可证。
 *
 * 扫描范围：
 *   - package.json + package-lock.json（npm；含直接/传递依赖）
 *   - Cargo.toml + Cargo.lock（Rust；crate 许可在离线环境下通常不可得，标"待确认"）
 *   - requirements*.txt（Python；文件不存在时记 0）
 *   - 仓库内二进制/媒体素材，以及 vendor/第三方/@license 脚本样式文件
 *   - 根 LICENSE 是否存在及可识别的许可家族
 *
 * 输出：
 *   - JSON：机器可读逐项清单（默认 docs/licenses/dependency-licenses.json）
 *   - Markdown：人类可读摘要（默认 docs/licenses/dependency-licenses.md）
 *   两者都不含时间戳，相同输入重复采集逐字节一致。
 *
 * 用法：
 *   node tools/license-scan.js
 *   node tools/license-scan.js --out-json /tmp/l.json --out-md /tmp/l.md --json
 *   node tools/license-scan.js --check
 *
 * 退出码：0 成功/一致；1 读取失败或 --check 不一致；2 参数错误。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_ROOT = PROJECT_ROOT;
const DEFAULT_JSON = path.join(PROJECT_ROOT, 'docs/licenses/dependency-licenses.json');
const DEFAULT_MD = path.join(PROJECT_ROOT, 'docs/licenses/dependency-licenses.md');
const PENDING = '待确认';
const SCHEMA_VERSION = 1;

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'target',
  'dist',
  'build',
  'coverage',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'Maildir'
]);

const MEDIA_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.icns',
  '.svg',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.pdf',
  '.mp4',
  '.webm',
  '.mp3'
]);

const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.css']);

class ScanError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'ScanError';
    this.exitCode = exitCode;
  }
}

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function compareUtf8(a, b) {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function displayRoot(absRoot) {
  if (absRoot === PROJECT_ROOT) return '.';
  const rel = path.relative(PROJECT_ROOT, absRoot);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return toPosix(rel);
  return path.basename(absRoot);
}

function relDisplay(root, absPath) {
  const rel = path.relative(root, absPath);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return toPosix(rel);
  return path.basename(absPath);
}

function readIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new ScanError(`读取失败：${filePath}（${error.code || error.message}）`);
  }
}

function readJsonIfExists(filePath) {
  const text = readIfExists(filePath);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ScanError(`JSON 解析失败：${filePath}（${error.message}）`);
  }
}

function normalizeLicense(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (Array.isArray(value)) {
    const parts = value.map(normalizeLicense).filter(Boolean);
    return parts.length > 0 ? parts.join(' OR ') : null;
  }
  if (typeof value === 'object' && typeof value.type === 'string') return value.type.trim() || null;
  return null;
}

// 只认明确的 SPDX 标识；LicenseRef-/UNLICENSED/SEE LICENSE 等一律视为未确认。
function resolveDeclaredLicense(raw) {
  if (!raw) return { license: PENDING, declaredLicense: null, status: 'pending', reason: '未声明许可证' };
  const trimmed = raw.trim();
  if (/^(?:UNLICENSED|NONE|NOASSERTION)$/i.test(trimmed)) {
    return { license: PENDING, declaredLicense: trimmed, status: 'pending', reason: `声明为 ${trimmed}，不能作为授权依据` };
  }
  if (/^LicenseRef-/i.test(trimmed) || /^SEE LICENSE IN/i.test(trimmed)) {
    return { license: PENDING, declaredLicense: trimmed, status: 'pending', reason: `声明为 ${trimmed}，需替换为 SPDX 标识` };
  }
  const expression = trimmed.replace(/\s*\/\s*/g, ' OR ');
  const tokens = expression.match(/[()]|[A-Za-z0-9.+-]+/g) || [];
  let index = 0;
  const identifier = () => { const t = tokens[index++]; if (!t || ['AND','OR','WITH','(',')'].includes(t)) throw Error('invalid'); };
  const term = (depth = 0) => {
    if (depth > 32) throw Error('deep');
    if (tokens[index] === '(') { index++; expr(depth + 1); if (tokens[index++] !== ')') throw Error('balance'); }
    else { identifier(); if (tokens[index] === 'WITH') { index++; identifier(); } }
  };
  const expr = depth => { term(depth); while (['AND','OR'].includes(tokens[index])) { index++; term(depth); } };
  try {
    if (tokens.join('') !== expression.replace(/\s/g, '')) throw Error('characters');
    expr(0); if (index !== tokens.length) throw Error('trailing');
    return { license: expression, declaredLicense: trimmed, status: 'confirmed', reason: '来自声明的 SPDX 表达式' };
  } catch {}
  return { license: PENDING, declaredLicense: trimmed, status: 'pending', reason: `无法解析的许可声明：${trimmed}` };
}

function makeItem(fields) {
  return {
    ecosystem: fields.ecosystem,
    name: fields.name,
    version: fields.version || PENDING,
    relationship: fields.relationship || 'transitive',
    source: fields.source || PENDING,
    license: fields.license || PENDING,
    declaredLicense: fields.declaredLicense === undefined ? null : fields.declaredLicense,
    licenseSource: fields.licenseSource || 'none',
    status: fields.status || (fields.license && fields.license !== PENDING ? 'confirmed' : 'pending'),
    distributedInArtifact: fields.distributedInArtifact || 'unknown',
    distributionNote: fields.distributionNote || '',
    notes: fields.notes || ''
  };
}

// ---------------------------------------------------------------------------
// npm
// ---------------------------------------------------------------------------
function collectNpm(root, items) {
  const pkgPath = path.join(root, 'package.json');
  const pkg = readJsonIfExists(pkgPath);
  if (!pkg) return { packageJson: false, lockfile: false, packages: 0 };

  const rootLicense = resolveDeclaredLicense(normalizeLicense(pkg.license));
  items.push(
    makeItem({
      ecosystem: 'project',
      name: pkg.name || '(root)',
      version: pkg.version || PENDING,
      relationship: 'root',
      source: 'package.json',
      license: rootLicense.license,
      declaredLicense: rootLicense.declaredLicense,
      licenseSource: 'package.json (license)',
      status: rootLicense.status,
      distributedInArtifact: 'yes',
      distributionNote: '根 package.json 随源码分发；根许可最终由 LICENSE 决定',
      notes: rootLicense.reason
    })
  );

  const direct = new Map();
  for (const [section, relationship] of [
    ['dependencies', 'direct'],
    ['devDependencies', 'direct-dev'],
    ['optionalDependencies', 'direct-optional'],
    ['peerDependencies', 'direct-peer']
  ]) {
    for (const name of Object.keys(pkg[section] || {})) {
      direct.set(name, { relationship, range: String(pkg[section][name]) });
    }
  }

  const lockPath = fs.existsSync(path.join(root, 'package-lock.json'))
    ? path.join(root, 'package-lock.json')
    : fs.existsSync(path.join(root, 'npm-shrinkwrap.json'))
      ? path.join(root, 'npm-shrinkwrap.json')
      : null;
  const lock = lockPath ? readJsonIfExists(lockPath) : null;
  const seen = new Set();
  let count = 0;

  const pushPackage = (name, meta, isDev, extraNote) => {
    const key = `${name}@${meta.version || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    count += 1;
    const directInfo = direct.get(name);
    const declared = resolveDeclaredLicense(normalizeLicense(meta.license));
    let source = relDisplay(root, lockPath);
    let resolvedHost = null;
    if (meta.resolved) {
      try {
        resolvedHost = new URL(meta.resolved).hostname;
      } catch {
        resolvedHost = null;
      }
      if (resolvedHost) source = `${source} (${resolvedHost})`;
    }
    const relationship = directInfo ? directInfo.relationship : isDev ? 'transitive-dev' : 'transitive';
    items.push(
      makeItem({
        ecosystem: 'npm',
        name,
        version: meta.version || PENDING,
        relationship,
        source,
        license: declared.license,
        declaredLicense: declared.declaredLicense,
        licenseSource: declared.license === PENDING ? 'none' : 'package-lock.json (license)',
        status: declared.status,
        distributedInArtifact: 'no',
        distributionNote: '未 vendored；由使用者安装，不随源码制品分发',
        notes: [declared.reason, extraNote].filter(Boolean).join('；')
      })
    );
  };

  if (lock && lock.packages && typeof lock.packages === 'object') {
    for (const [key, meta] of Object.entries(lock.packages)) {
      if (key === '' || !meta || typeof meta !== 'object') continue;
      const marker = 'node_modules/';
      const name = key.includes(marker) ? key.slice(key.lastIndexOf(marker) + marker.length) : key;
      pushPackage(name, meta, meta.dev === true, meta.optional ? '可选依赖' : '');
    }
  } else if (lock && lock.dependencies && typeof lock.dependencies === 'object') {
    const walk = (deps, isDev) => {
      for (const [name, meta] of Object.entries(deps)) {
        if (!meta || typeof meta !== 'object') continue;
        pushPackage(name, meta, isDev, '');
        if (meta.dependencies) walk(meta.dependencies, isDev);
      }
    };
    walk(lock.dependencies, false);
  }

  for (const [name, info] of direct) {
    const found = items.some((item) => item.ecosystem === 'npm' && item.name === name);
    if (found) continue;
    items.push(
      makeItem({
        ecosystem: 'npm',
        name,
        version: PENDING,
        relationship: info.relationship,
        source: 'package.json',
        license: PENDING,
        declaredLicense: null,
        licenseSource: 'none',
        status: 'pending',
        distributedInArtifact: 'no',
        distributionNote: '未 vendored；由使用者安装，不随源码制品分发',
        notes: `package.json 声明范围 ${info.range}，但锁文件未解析到该包`
      })
    );
    count += 1;
  }

  return { packageJson: true, lockfile: Boolean(lockPath), packages: count };
}

// ---------------------------------------------------------------------------
// Cargo
// ---------------------------------------------------------------------------
function tomlSectionLines(text, sectionName) {
  const lines = text.split(/\r?\n/);
  const result = [];
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      inSection = trimmed === `[${sectionName}]`;
      continue;
    }
    if (inSection) result.push(trimmed);
  }
  return result;
}

function parseCargoManifest(text) {
  const packageLines = tomlSectionLines(text, 'package');
  const readKey = (key) => {
    const prefix = `${key} =`;
    for (const line of packageLines) {
      if (!line.startsWith(prefix)) continue;
      const raw = line.slice(prefix.length).trim();
      const match = /^"([^"]*)"$/.exec(raw);
      return match ? match[1] : raw;
    }
    return null;
  };
  const deps = new Set();
  for (const section of ['dependencies', 'build-dependencies', 'dev-dependencies']) {
    for (const line of tomlSectionLines(text, section)) {
      const match = /^([A-Za-z0-9_-]+)\s*=/.exec(line);
      if (match) deps.add(match[1]);
    }
  }
  return {
    name: readKey('name'),
    version: readKey('version'),
    license: readKey('license'),
    publish: readKey('publish'),
    deps
  };
}

function parseCargoLock(text) {
  const packages = [];
  let current = null;
  let inPackage = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '[[package]]') {
      if (current) packages.push(current);
      current = { name: null, version: null, source: null, checksum: null };
      inPackage = true;
      continue;
    }
    if (trimmed.startsWith('[') && trimmed.endsWith(']') && trimmed !== '[[package]]') {
      if (current) packages.push(current);
      current = null;
      inPackage = false;
      continue;
    }
    if (!inPackage || !current) continue;
    const match = /^([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"$/.exec(trimmed);
    if (match) current[match[1]] = match[2];
  }
  if (current) packages.push(current);
  return packages.filter((pkg) => pkg.name && pkg.version);
}

function collectCargo(root, items) {
  const manifests = [];
  const stack = [''];
  while (stack.length > 0) {
    const relDir = stack.pop();
    const absDir = relDir === '' ? root : path.join(root, ...relDir.split('/'));
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => compareUtf8(a.name, b.name));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(relDir === '' ? entry.name : `${relDir}/${entry.name}`);
      } else if (entry.isFile() && entry.name === 'Cargo.toml') {
        manifests.push(relDir === '' ? 'Cargo.toml' : `${relDir}/Cargo.toml`);
      }
    }
  }
  manifests.sort(compareUtf8);

  // 先解析全部 workspace manifest，避免把 path 依赖误报成第三方 crate。
  const parsedManifests = [];
  const workspaceNames = new Set();
  for (const manifestRel of manifests) {
    const text = readIfExists(path.join(root, ...manifestRel.split('/')));
    if (text === null) continue;
    const manifest = parseCargoManifest(text);
    parsedManifests.push({ manifestRel, manifest });
    if (manifest.name) workspaceNames.add(manifest.name);
  }

  const evidencePath = path.join(root, 'docs/licenses/cargo-evidence.json');
  const evidence = readJsonIfExists(evidencePath);
  const receipts = new Map((evidence?.schemaVersion === 1 ? evidence.packages : []).map(item => [item.name + '@' + item.version, item]));
  const seen = new Set();
  let crateCount = 0;
  for (const { manifestRel, manifest } of parsedManifests) {
    if (manifest.name) {
      const declared = resolveDeclaredLicense(manifest.license);
      items.push(
        makeItem({
          ecosystem: 'cargo',
          name: manifest.name,
          version: manifest.version || PENDING,
          relationship: 'workspace',
          source: manifestRel,
          license: declared.license,
          declaredLicense: declared.declaredLicense,
          licenseSource: declared.license === PENDING ? 'none' : 'Cargo.toml (license)',
          status: declared.status,
          distributedInArtifact: 'yes',
          distributionNote: 'workspace 源码随仓库分发',
          notes: declared.reason
        })
      );
    }

    const lockRel = manifestRel.replace(/Cargo\.toml$/, 'Cargo.lock');
    const lockAbs = path.join(root, ...lockRel.split('/'));
    const lockText = readIfExists(lockAbs);
    if (lockText === null) continue;
    for (const pkg of parseCargoLock(lockText)) {
      if (manifest.name && pkg.name === manifest.name && pkg.version === manifest.version && !pkg.source) continue;
      // path 依赖指向 workspace 内其他 crate：已作为 workspace 项登记，不重复计为第三方。
      if (!pkg.source && workspaceNames.has(pkg.name)) continue;
      const key = `${pkg.name}@${pkg.version}@${pkg.source || 'path'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      crateCount += 1;
      const isDirect = manifest.deps.has(pkg.name);
      const receipt = receipts.get(pkg.name + '@' + pkg.version);
      const trusted = receipt && receipt.checksum === pkg.checksum && Array.isArray(receipt.licenseFiles)
        && receipt.licenseFiles.length > 0 && receipt.licenseFiles.every(file => {
          if (!/^docs\/licenses\/cargo\/[A-Za-z0-9_.+\/-]+$/.test(file.path) || file.path.split('/').includes('..')) return false;
          const abs = path.join(root, file.path);
          return fs.existsSync(abs) && sha256Buffer(fs.readFileSync(abs)) === file.sha256;
        });
      const licensed = trusted ? resolveDeclaredLicense(receipt.license) : null;

      let sourceLabel;
      if (!pkg.source) sourceLabel = `path (${lockRel})`;
      else if (/^registry\+https:\/\/github\.com\/rust-lang\/crates\.io-index$/.test(pkg.source)) sourceLabel = 'crates.io';
      else sourceLabel = pkg.source.replace(/^registry\+/, 'registry ');
      items.push(
        makeItem({
          ecosystem: 'cargo',
          name: pkg.name,
          version: pkg.version,
          relationship: isDirect ? 'direct' : 'transitive',
          source: sourceLabel,
          license: licensed?.license || PENDING,
          declaredLicense: licensed?.declaredLicense || null,
          licenseSource: trusted ? 'cargo metadata + Cargo.lock checksum + attached license texts' : 'none',
          status: licensed?.status || 'pending',
          distributedInArtifact: 'no',
          distributionNote: '源码包不 vendored；编译客户端二进制时会静态链接',
          notes: trusted ? `锁文件校验和与许可文本哈希已核对；来自 ${lockRel}` : `Cargo.lock 只记录版本与校验和，离线环境无法确认许可；来自 ${lockRel}`
        })
      );
    }
  }
  return { manifests: manifests.length, crates: crateCount };
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------
function collectPython(root, items) {
  const files = [];
  const stack = [''];
  while (stack.length > 0) {
    const relDir = stack.pop();
    const absDir = relDir === '' ? root : path.join(root, ...relDir.split('/'));
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => compareUtf8(a.name, b.name));
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(relDir === '' ? entry.name : `${relDir}/${entry.name}`);
      } else if (entry.isFile() && /^requirements.*\.txt$/i.test(entry.name)) {
        files.push(relDir === '' ? entry.name : `${relDir}/${entry.name}`);
      }
    }
  }
  files.sort(compareUtf8);
  let count = 0;
  for (const fileRel of files) {
    const text = readIfExists(path.join(root, ...fileRel.split('/')));
    if (text === null) continue;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.split('#')[0].trim();
      if (line === '' || line.startsWith('-')) continue;
      const spec = line.split(';')[0].trim();
      const match = /^([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?\s*(.*)$/.exec(spec);
      if (!match) continue;
      count += 1;
      const versionSpec = match[2].trim() || PENDING;
      items.push(
        makeItem({
          ecosystem: 'python',
          name: match[1],
          version: versionSpec,
          relationship: 'direct',
          source: fileRel,
          license: PENDING,
          declaredLicense: null,
          licenseSource: 'none',
          status: 'pending',
          distributedInArtifact: 'no',
          distributionNote: '由使用者安装，不随源码制品分发',
          notes: 'requirements 文件不携带许可字段，需在独立构建区用 pip-licenses 采集'
        })
      );
    }
  }
  return { files: files.length, packages: count };
}

// ---------------------------------------------------------------------------
// 素材
// ---------------------------------------------------------------------------
function detectLicenseMarker(buffer, relPath) {
  const text = buffer.toString('latin1');
  const spdx = /SPDX-License-Identifier:\s*([A-Za-z0-9.+-]+)/i.exec(text);
  if (spdx) return { license: spdx[1], evidence: 'SPDX-License-Identifier', marker: spdx[0] };
  const at = /@license\s+([^\r\n*]{1,120})/i.exec(text);
  if (at) {
    const declared = at[1].trim();
    const resolved = resolveDeclaredLicense(declared);
    return { license: resolved.license, evidence: '@license 标记', marker: declared };
  }
  if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(text)) {
    return { license: PENDING, evidence: 'AGPL 正文片段', marker: 'AGPL 正文需逐项确认版本' };
  }
  if (/Apache License,?\s+Version 2\.0/i.test(text)) {
    return { license: 'Apache-2.0', evidence: 'Apache-2.0 正文片段', marker: 'Apache License 2.0' };
  }
  if (/Permission is hereby granted, free of charge/i.test(text)) {
    return { license: PENDING, evidence: 'MIT 风格正文片段', marker: 'MIT 正文需确认版权行' };
  }
  if (/Copyright/i.test(text)) {
    return { license: PENDING, evidence: '版权行（未含许可条款）', marker: 'Copyright' };
  }
  return { license: PENDING, evidence: 'none', marker: null };
}

function collectAssets(root, items) {
  const assets = [];
  const stack = [''];
  while (stack.length > 0) {
    const relDir = stack.pop();
    const absDir = relDir === '' ? root : path.join(root, ...relDir.split('/'));
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => compareUtf8(a.name, b.name));
    for (const entry of entries) {
      const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (relPath === 'docs/m0') continue;
        stack.push(relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      const isMedia = MEDIA_EXTENSIONS.has(ext);
      const isScript = SCRIPT_EXTENSIONS.has(ext);
      if (!isMedia && !isScript) continue;
      const absFile = path.join(absDir, entry.name);
      let buffer;
      try {
        buffer = fs.readFileSync(absFile);
      } catch {
        continue;
      }
      const head = buffer.subarray(0, 64 * 1024);
      const tail = buffer.length > 64 * 1024 ? buffer.subarray(-64 * 1024) : Buffer.alloc(0);
      const combined = Buffer.concat([head, tail]);
      const vendorLike =
        /(^|\/)(vendor|third[-_]party|licenses?)(\/|$)/i.test(relPath) ||
        /\.min\.(?:js|css|mjs)$/i.test(entry.name) ||
        /(?:^|\/)(?:pdf(?:\.worker)?(?:\.legacy)?\.min\.mjs|katex(?:\.min)?\.(?:js|css))$/i.test(relPath);
      let marker = detectLicenseMarker(combined, relPath);
      const assetReceipt = readJsonIfExists(path.join(root, 'docs/licenses/asset-evidence.json'))?.files?.find(item => item.path === relPath && item.sha256 === sha256Buffer(buffer));
      if (assetReceipt) marker = { license: assetReceipt.license, evidence: 'owner-approved asset declaration + SHA-256', marker: assetReceipt.license };
      if (isScript) {
        // 普通第一方脚本不逐文件登记；只收 vendor/min/显式 @license/SPDX 的脚本，
        // 且排除工具与测试自身（它们的注释里会出现 SPDX/@license 字样）。
        if (/^(?:tools|tests)\//.test(relPath) && !vendorLike) continue;
        if (!vendorLike && marker.evidence === 'none') continue;
      }
      assets.push(
        makeItem({
          ecosystem: 'asset',
          name: entry.name,
          version: PENDING,
          relationship: 'vendored',
          source: relPath,
          license: marker.license,
          declaredLicense: marker.marker,
          licenseSource: marker.evidence,
          status: marker.license === PENDING ? 'pending' : 'confirmed',
          distributedInArtifact: 'yes',
          distributionNote: '文件位于仓库内，会进入公开导出版',
          notes:
            marker.evidence === 'none'
              ? `素材/静态资源；未发现许可标记。sha256=${sha256Buffer(buffer)}，${buffer.length} 字节`
              : `证据：${marker.evidence}；sha256=${sha256Buffer(buffer)}，${buffer.length} 字节`
        })
      );
    }
  }
  assets.sort((a, b) => compareUtf8(a.source, b.source));
  items.push(...assets);
  return { assets: assets.length };
}

// ---------------------------------------------------------------------------
// 根 LICENSE
// ---------------------------------------------------------------------------
function detectLicenseFamily(text) {
  if (/MIT License/i.test(text) || /Permission is hereby granted, free of charge/i.test(text)) return 'MIT';
  if (/Apache License,?\s+Version 2\.0/i.test(text)) return 'Apache-2.0';
  if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(text)) return 'AGPL-3.0';
  if (/GNU GENERAL PUBLIC LICENSE/i.test(text)) return 'GPL';
  if (/Mozilla Public License/i.test(text)) return 'MPL-2.0';
  if (/BSD 2-Clause|Redistribution and use in source and binary forms/i.test(text)) return 'BSD';
  if (/ISC License/i.test(text)) return 'ISC';
  return null;
}

function inspectRootLicense(root) {
  const abs = path.join(root, 'LICENSE');
  const text = readIfExists(abs);
  if (text === null) {
    return {
      path: 'LICENSE',
      present: false,
      family: null,
      status: '待 owner 决定',
      candidates: ['MIT', 'Apache-2.0', 'AGPL-3.0-only'],
      decisionDoc: 'LICENSE-DECISION.md',
      note: '未创建许可正文；候选差异与待确认事项见 LICENSE-DECISION.md，最终由 owner 决定'
    };
  }
  const family = detectLicenseFamily(text);
  return {
    path: 'LICENSE',
    present: true,
    family,
    status: family ? '已存在' : '待确认',
    candidates: [],
    decisionDoc: 'LICENSE-DECISION.md',
    note: family ? '已能识别许可家族；仍建议法务复核' : 'LICENSE 存在但无法识别许可家族'
  };
}

// ---------------------------------------------------------------------------
// 汇总与输出
// ---------------------------------------------------------------------------
function buildReport(root) {
  const items = [];
  const npm = collectNpm(root, items);
  const cargo = collectCargo(root, items);
  const python = collectPython(root, items);
  const asset = collectAssets(root, items);
  const rootLicense = inspectRootLicense(root);

  // 去重：素材按路径；依赖按 ecosystem+name+version（同一 crate 可能出现在多个锁文件里）。
  const deduped = new Map();
  for (const item of items) {
    const key =
      item.ecosystem === 'asset'
        ? `asset|${item.source}`
        : [item.ecosystem, item.name, item.version].join('|');
    const existing = deduped.get(key);
    if (!existing) {
      deduped.set(key, item);
      continue;
    }
    if (existing.source !== item.source && !existing.source.includes(item.source)) {
      existing.source = `${existing.source}；${item.source}`;
    }
    if (existing.notes && item.notes && !existing.notes.includes(item.notes)) {
      existing.notes = `${existing.notes}；另见 ${item.notes}`;
    }
  }
  const finalItems = [...deduped.values()].sort((a, b) => {
    if (a.ecosystem !== b.ecosystem) return compareUtf8(a.ecosystem, b.ecosystem);
    if (a.name !== b.name) return compareUtf8(a.name, b.name);
    if (a.version !== b.version) return compareUtf8(a.version, b.version);
    return compareUtf8(a.source, b.source);
  });

  const byEcosystem = {};
  const byDistribution = { yes: 0, no: 0, unknown: 0 };
  let confirmed = 0;
  let pending = 0;
  for (const item of finalItems) {
    const bucket = byEcosystem[item.ecosystem] || { total: 0, confirmed: 0, pending: 0 };
    bucket.total += 1;
    if (item.status === 'confirmed') {
      bucket.confirmed += 1;
      confirmed += 1;
    } else {
      bucket.pending += 1;
      pending += 1;
    }
    byEcosystem[item.ecosystem] = bucket;
    byDistribution[item.distributedInArtifact] = (byDistribution[item.distributedInArtifact] || 0) + 1;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    generator: 'tools/license-scan.js',
    root: displayRoot(root),
    policy: {
      network: 'disabled',
      installsDependencies: false,
      unknownLicenseValue: PENDING,
      rootLicenseDecision: 'owner'
    },
    summary: {
      total: finalItems.length,
      confirmed,
      pending,
      byEcosystem,
      byDistribution,
      npm,
      cargo,
      python,
      asset
    },
    rootLicense,
    items: finalItems
  };
}

function mdEscape(value) {
  return String(value === undefined || value === null ? '' : value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# 依赖与素材许可清单');
  lines.push('');
  lines.push('> 本文件由 `tools/license-scan.js` 生成，请勿手工编辑；重新生成命令见文末。');
  lines.push('> 本清单只做**事实采集**，不构成法律意见，也不替 owner 选择根许可证。');
  lines.push('');
  lines.push('## 1. 根许可证状态');
  lines.push('');
  lines.push(`- 根 \`LICENSE\`：${report.rootLicense.present ? '存在' : '**不存在**'}`);
  lines.push(`- 可识别家族：${report.rootLicense.family || '未识别'}`);
  lines.push(`- 状态：**${report.rootLicense.status}**`);
  if (report.rootLicense.candidates.length > 0) {
    lines.push(`- 候选（未选定）：${report.rootLicense.candidates.join(' / ')}`);
  }
  lines.push(`- 说明：${report.rootLicense.note}`);
  lines.push(`- 决策记录：[\`${report.rootLicense.decisionDoc}\`](../${report.rootLicense.decisionDoc})`);
  lines.push('');
  lines.push('## 2. 汇总');
  lines.push('');
  lines.push('| 类目 | 总数 | 已确认 | 待确认 |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const [name, bucket] of Object.entries(report.summary.byEcosystem)) {
    lines.push(`| ${name} | ${bucket.total} | ${bucket.confirmed} | ${bucket.pending} |`);
  }
  lines.push(`| **合计** | **${report.summary.total}** | **${report.summary.confirmed}** | **${report.summary.pending}** |`);
  lines.push('');
  lines.push(
    `随制品分发：是 ${report.summary.byDistribution.yes || 0}；否 ${report.summary.byDistribution.no || 0}；未知 ${
      report.summary.byDistribution.unknown || 0
    }。`
  );
  lines.push('');
  lines.push(`“${PENDING}”表示离线扫描无法从锁文件/文件头确认许可，**不是**推定无许可，也不是推定有许可。`);
  lines.push('');

  const sections = [
    ['npm', '3. npm 依赖（package.json / package-lock.json）'],
    ['cargo', '4. Rust crate（Cargo.toml / Cargo.lock）'],
    ['python', '5. Python 依赖（requirements*.txt）'],
    ['asset', '6. 素材与静态资源'],
    ['project', '7. 仓库根项目']
  ];
  let sectionNo = 8;
  for (const [ecosystem, title] of sections) {
    const rows = report.items.filter((item) => item.ecosystem === ecosystem);
    lines.push(`## ${title}`);
    lines.push('');
    if (rows.length === 0) {
      lines.push('本类目本次扫描为 0 项。');
      lines.push('');
      continue;
    }
    lines.push('| 名称 | 版本 | 关系 | 来源 | 许可证 | 状态 | 随制品分发 | 备注 |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const item of rows) {
      lines.push(
        `| ${mdEscape(item.name)} | ${mdEscape(item.version)} | ${mdEscape(item.relationship)} | ${mdEscape(
          item.source
        )} | ${mdEscape(item.license)} | ${item.status === 'confirmed' ? '已确认' : '待确认'} | ${mdEscape(
          item.distributedInArtifact
        )} | ${mdEscape(item.notes || item.distributionNote)} |`
      );
    }
    lines.push('');
    sectionNo += 1;
  }

  lines.push(`## ${sectionNo}. 待确认项与处理建议`);
  lines.push('');
  const pendingItems = report.items.filter((item) => item.status !== 'confirmed');
  lines.push(`共 ${pendingItems.length} 项标记为“${PENDING}”。按类目分布：`);
  lines.push('');
  const pendingByEco = {};
  for (const item of pendingItems) pendingByEco[item.ecosystem] = (pendingByEco[item.ecosystem] || 0) + 1;
  for (const [eco, count] of Object.entries(pendingByEco).sort((a, b) => compareUtf8(a[0], b[0]))) {
    lines.push(`- ${eco}：${count} 项`);
  }
  lines.push('');
  lines.push('处理建议（不改变“待确认”事实，只说明如何关闭）：');
  lines.push('');
  lines.push('1. Rust crate：在独立构建区执行 `cargo deny check licenses`，把每个 crate 的 SPDX 回填到本清单；不要凭印象填写。');
  lines.push('2. npm：锁文件的 `license` 字段已采集；仍应在独立构建区用 `pnpm licenses list --prod` 复核传递依赖。');
  lines.push('3. Python：当前无 `requirements*.txt`；落盘后在独立构建区用 `pip-licenses --format=csv --with-urls` 采集。');
  lines.push('4. 素材：逐个人工确认来源与授权；确认前保持“待确认”，不要写入具体许可名。');
  lines.push('5. 根许可证：由 owner 在 `LICENSE-DECISION.md` §5 记录决定；本工具不创建 `LICENSE` 正文。');
  lines.push('');

  lines.push(`## ${sectionNo + 1}. 已知限制`);
  lines.push('');
  lines.push('- 只读、离线：不访问网络、不安装依赖、不读取任何 `.env`、凭据、数据库、Maildir 或用户数据。');
  lines.push('- `Cargo.lock` 不含许可字段；离线时无法从 crates.io 元数据确认，因此 crate 一律标“待确认”。');
  lines.push('- npm 的许可来自锁文件声明，可能与实际包内 `LICENSE` 不一致；发布前仍需在独立构建区复核。');
  lines.push('- 素材识别只依赖文件内可见的 SPDX/@license/版权行；未发现标记时保持“待确认”，不推断。');
  lines.push('- 本清单不是法律意见，也不替代 `THIRD_PARTY_NOTICES.md` 的分发义务。');
  lines.push('');
  lines.push(`## ${sectionNo + 2}. 重新生成与校验`);
  lines.push('');
  lines.push('```bash');
  lines.push('cd source/site/public-release/pagesai');
  lines.push('node tools/license-scan.js');
  lines.push('node tools/license-scan.js --check');
  lines.push('```');
  lines.push('');
  lines.push('`--check` 会比较当前扫描结果与已落盘的 JSON/Markdown；不一致时退出码为 1。');
  lines.push('');
  return `${lines.join('\n')}`;
}

function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tempPath, content, { mode: 0o644 });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // 忽略清理失败
    }
    throw new ScanError(`写入失败：${filePath}（${error.code || error.message}）`);
  }
}

const USAGE = `依赖与素材许可采集（C35）

用法：
  node tools/license-scan.js [--root DIR] [--out-json FILE] [--out-md FILE] [--json]
  node tools/license-scan.js --check

选项：
  --root DIR        扫描根目录，默认是本工具上一级（公开版根目录）
  --out-json FILE   JSON 输出路径，默认 docs/licenses/dependency-licenses.json
  --out-md FILE     Markdown 输出路径，默认 docs/licenses/dependency-licenses.md
  --check           不写文件，比较当前扫描结果与已落盘报告；不一致退出码 1
  --dry-run         只扫描并在 stdout 打印摘要，不写文件
  --json            在 stdout 输出单行摘要 JSON
  -h, --help        显示本帮助

说明：
  - 只读、离线，不安装依赖，不读取 .env/凭据/数据库/Maildir/用户数据。
  - 无法确认的许可统一写“${PENDING}”，不臆造 SPDX 标识。
  - 根 LICENSE 缺失时只报告候选，最终由 owner 决定。

退出码：0 成功/一致；1 读取失败或 --check 不一致；2 参数错误。
`;

function parseArgs(argv) {
  const options = {
    root: DEFAULT_ROOT,
    outJson: DEFAULT_JSON,
    outMd: DEFAULT_MD,
    check: false,
    dryRun: false,
    json: false,
    help: false
  };
  const takeValue = (index, flag) => {
    const value = argv[index + 1];
    if (value === undefined || value === '' || value.startsWith('--')) {
      throw new ScanError(`${flag} 缺少参数值`, 2);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--root':
        options.root = takeValue(i, arg);
        i += 1;
        break;
      case '--out-json':
        options.outJson = takeValue(i, arg);
        i += 1;
        break;
      case '--out-md':
        options.outMd = takeValue(i, arg);
        i += 1;
        break;
      case '--check':
        options.check = true;
        break;
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--json':
        options.json = true;
        break;
      case '-h':
      case '--help':
        options.help = true;
        break;
      default:
        throw new ScanError(`未知参数：${arg}\n\n${USAGE}`, 2);
    }
  }
  if (options.help) return options;
  if (options.check && options.dryRun) throw new ScanError('--check 不能与 --dry-run 同时使用', 2);
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const rootAbs = path.resolve(options.root);
  if (!fs.existsSync(rootAbs) || !fs.statSync(rootAbs).isDirectory()) {
    throw new ScanError(`扫描根目录不存在：${options.root}`);
  }
  const report = buildReport(rootAbs);
  const jsonText = `${JSON.stringify(report, null, 2)}\n`;
  const mdText = renderMarkdown(report);

  if (options.check) {
    const problems = [];
    const checkFile = (filePath, expected) => {
      const abs = path.resolve(filePath);
      let actual;
      try {
        actual = fs.readFileSync(abs, 'utf8');
      } catch (error) {
        problems.push(`无法读取 ${filePath}（${error.code || error.message}）`);
        return;
      }
      if (actual !== expected) problems.push(`${filePath} 与当前扫描结果不一致`);
    };
    checkFile(options.outJson, jsonText);
    checkFile(options.outMd, mdText);
    const summary = {
      ok: problems.length === 0,
      root: report.root,
      total: report.summary.total,
      confirmed: report.summary.confirmed,
      pending: report.summary.pending,
      problems
    };
    if (options.json) process.stdout.write(`${JSON.stringify(summary)}\n`);
    else {
      console.log('依赖与素材许可清单校验（C35）');
      console.log(`根目录      : ${report.root}`);
      console.log(`条目        : ${summary.total}（已确认 ${summary.confirmed}，待确认 ${summary.pending}）`);
      console.log(`校验结果    : ${summary.ok ? '一致' : '不一致'}`);
      for (const problem of problems) console.log(`  - ${problem}`);
    }
    return summary.ok ? 0 : 1;
  }

  if (!options.dryRun) {
    writeAtomic(path.resolve(options.outJson), jsonText);
    writeAtomic(path.resolve(options.outMd), mdText);
  }

  const summary = {
    ok: true,
    dryRun: options.dryRun,
    root: report.root,
    rootLicense: report.rootLicense,
    total: report.summary.total,
    confirmed: report.summary.confirmed,
    pending: report.summary.pending,
    byEcosystem: report.summary.byEcosystem,
    byDistribution: report.summary.byDistribution,
    outputs: options.dryRun
      ? null
      : { json: relDisplay(rootAbs, path.resolve(options.outJson)), md: relDisplay(rootAbs, path.resolve(options.outMd)) }
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return 0;
  }
  console.log('依赖与素材许可采集（C35）');
  console.log(`根目录      : ${report.root}`);
  console.log(`根 LICENSE  : ${report.rootLicense.present ? report.rootLicense.family || '存在但未识别' : '不存在'}（${report.rootLicense.status}）`);
  console.log(`条目        : ${summary.total}（已确认 ${summary.confirmed}，待确认 ${summary.pending}）`);
  for (const [eco, bucket] of Object.entries(report.summary.byEcosystem)) {
    console.log(`  - ${eco}: ${bucket.total}（已确认 ${bucket.confirmed}，待确认 ${bucket.pending}）`);
  }
  console.log(
    `随制品分发  : 是 ${summary.byDistribution.yes || 0}；否 ${summary.byDistribution.no || 0}；未知 ${
      summary.byDistribution.unknown || 0
    }`
  );
  if (!options.dryRun) {
    console.log(`JSON        : ${summary.outputs.json}`);
    console.log(`Markdown    : ${summary.outputs.md}`);
  }
  console.log('结论        : 采集完成；根许可证仍待 owner 决定。');
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof ScanError) {
      process.stderr.write(`[license-scan] ${error.message}\n`);
      process.exitCode = error.exitCode;
    } else {
      process.stderr.write(`[license-scan] 未预期错误：${error && error.stack ? error.stack : error}\n`);
      process.exitCode = 1;
    }
  }
}

module.exports = {
  PENDING,
  buildReport,
  renderMarkdown,
  resolveDeclaredLicense,
  parseCargoLock,
  main
};
