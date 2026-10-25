'use strict';
// C09 MongoDB + 固定文件根的一致性备份、校验与隔离恢复。
// Mongo 只导出元数据；区域文件按原始字节复制，绝不 JSON/base64 包装内容。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { once } = require('node:events');
const { pipeline } = require('node:stream/promises');
const { CoreError, codes } = require('../errors');
const { STORAGE_SCHEMA_VERSION } = require('./mongo-metadata');

const BACKUP_FORMAT_VERSION = 1;
const CONFIG_SCHEMA_VERSION = 1;

function backupError(message, details = null) { return new CoreError(codes.BACKUP_INVALID, message, { status: 409, details }); }
function restoreError(message, details = null) { return new CoreError(codes.RESTORE_INVALID, message, { status: 409, details }); }
function inside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
function safeRelative(value) {
  if (typeof value !== 'string' || path.isAbsolute(value) || value.includes('\0') || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw backupError('备份包含非法相对路径');
  }
  return value;
}
function shaText(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
async function shaFile(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), async function* (source) {
    for await (const chunk of source) { hash.update(chunk); yield chunk; }
  }, new (require('node:stream').Writable)({ write(chunk, encoding, callback) { callback(); } }));
  return hash.digest('hex');
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw backupError(`备份元数据不可读：${error.message}`); }
}
function collect(root) {
  const entries = [];
  if (!fs.existsSync(root)) throw backupError(`文件根不存在：${root}`);
  function walk(directory, prefix) {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw backupError(`文件根包含符号链接，拒绝备份：${absolute}`);
      if (stat.isDirectory()) { entries.push({ relative, absolute, directory: true }); walk(absolute, relative); }
      else if (stat.isFile()) entries.push({ relative, absolute, directory: false, size: stat.size, mode: stat.mode & 0o777 });
      else throw backupError(`文件根包含特殊文件：${absolute}`);
    }
  }
  walk(root, '');
  return entries;
}
function treeHash(entries, hashes) {
  const lines = entries.map((entry) => entry.directory
    ? `${entry.relative}\0D`
    : `${entry.relative}\0F\0${hashes.get(entry.relative)}\0${entry.size}`).sort();
  return shaText(`${lines.join('\n')}\n`);
}
async function copyFileVerified(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o750 });
  await pipeline(fs.createReadStream(source), fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }));
  const [sourceHash, targetHash] = await Promise.all([shaFile(source), shaFile(target)]);
  if (sourceHash !== targetHash) throw backupError(`复制后 SHA-256 不一致：${source}`);
  return targetHash;
}
async function exportCollection(collection, target) {
  const output = fs.createWriteStream(target, { flags: 'wx', mode: 0o600 });
  let count = 0;
  const cursor = collection.find({}).sort({ _id: 1 });
  try {
    for await (const document of cursor) {
      const line = `${require('bson').EJSON.stringify(document)}\n`;
      if (!output.write(line)) await once(output, 'drain');
      count += 1;
    }
  } finally { output.end(); await once(output, 'close'); }
  return { name: collection.collectionName, file: `mongodb/${collection.collectionName}.jsonl`, count, sha256: await shaFile(target) };
}
async function* jsonLines(file) {
  const input = fs.createReadStream(file);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) if (line.trim()) yield require('bson').EJSON.parse(line);
  } finally { lines.close(); input.destroy(); }
}

function validateConfig(config, deploymentId, errorFactory = backupError) {
  if (!config || config.product !== 'pagesai' || config.schemaVersion !== CONFIG_SCHEMA_VERSION) throw errorFactory('配置产品或 schemaVersion 不受支持');
  if (config.deploymentId !== deploymentId) throw errorFactory('配置 deploymentId 与部署不匹配');
  if (!config.database || config.database.engine !== 'mongodb') throw errorFactory('真实备份只支持 mongodb 配置');
  if (!path.isAbsolute(config.dataRoot || '') || !config.storage || !Array.isArray(config.regions)) throw errorFactory('配置缺少绝对数据根、存储映射或区域清单');
  return config;
}

function regionSpecs(config, regions) {
  const byId = new Map(regions.map((region) => [region.regionId, region]));
  const configuredIds = new Set(config.regions.map((region) => region.regionId));
  if (byId.size !== regions.length || configuredIds.size !== config.regions.length || byId.size !== configuredIds.size || regions.some((region) => !configuredIds.has(region.regionId))) {
    throw backupError('配置区域与 Mongo 持久区域清单不一致');
  }
  return config.regions.map((declaration) => {
    const region = byId.get(declaration.regionId);
    if (!region) throw backupError(`配置区域 ${declaration.regionId} 未在 Mongo 登记`);
    const configured = config.storage[declaration.physicalRoot.configKey];
    if (!configured || path.resolve(configured) !== path.resolve(region.rootAbs)) throw backupError(`区域 ${declaration.regionId} 的配置根与 Mongo 登记根不一致`);
    return { declaration, regionId: declaration.regionId, rootAbs: path.resolve(region.rootAbs), configKey: declaration.physicalRoot.configKey };
  });
}

async function verifySourceDeployment(client, dbName, config) {
  if (config.database.name && config.database.name !== dbName) throw backupError('配置数据库名与备份源不一致');
  const metadata = client.db(dbName).collection('runtime_metadata');
  const [storage, identity] = await Promise.all([
    metadata.findOne({ _id: 'storage' }),
    metadata.findOne({ _id: 'runtime' })
  ]);
  if (!storage || storage.deploymentId !== config.deploymentId || storage.schemaVersion !== STORAGE_SCHEMA_VERSION) {
    throw backupError('Mongo 存储模式版本或 deploymentId 与配置不匹配');
  }
  if (identity && identity.deploymentId !== config.deploymentId) throw backupError('Mongo 身份 deploymentId 与配置不匹配');
}

async function createBackup({ client, dbName, config, regions, outDir, quiesce, label = null }) {
  if (!client || !dbName) throw backupError('备份需要显式 Mongo client 与 dbName');
  validateConfig(config, config && config.deploymentId);
  await verifySourceDeployment(client, dbName, config);
  if (typeof quiesce !== 'function') throw backupError('一致性备份必须提供 quiesce 写暂停/恢复函数');
  if (!path.isAbsolute(outDir)) throw backupError('备份输出目录必须是绝对路径');
  const finalDir = path.resolve(outDir);
  if (fs.existsSync(finalDir)) throw backupError('备份输出目录已存在');
  const specs = regionSpecs(config, regions);
  for (const spec of specs) {
    if (inside(spec.rootAbs, finalDir) || inside(finalDir, spec.rootAbs)) throw backupError('备份目录与文件根不能相互包含');
  }
  for (let i = 0; i < specs.length; i++) for (let j = i + 1; j < specs.length; j++) {
    if (inside(specs[i].rootAbs, specs[j].rootAbs) || inside(specs[j].rootAbs, specs[i].rootAbs)) throw backupError('文件根重叠，拒绝备份');
  }
  const staging = `${finalDir}.staging-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const backupId = `pagesai-${new Date().toISOString().replace(/[-:.]/g, '')}-${crypto.randomBytes(3).toString('hex')}`;
  let resumed = false;
  try {
    await quiesce(true);
    resumed = true;
    fs.mkdirSync(path.join(staging, 'mongodb'), { recursive: true, mode: 0o700 });
    const collections = await client.db(dbName).listCollections({}, { nameOnly: false }).toArray();
    const exported = [];
    for (const info of collections.sort((a, b) => a.name.localeCompare(b.name))) {
      if (info.type !== 'collection' || info.name.startsWith('system.')) continue;
      exported.push(await exportCollection(client.db(dbName).collection(info.name), path.join(staging, 'mongodb', `${info.name}.jsonl`)));
    }
    const rootResults = [];
    const checksums = new Map();
    for (const collection of exported) checksums.set(collection.file, collection.sha256);
    for (const spec of specs) {
      const entries = collect(spec.rootAbs);
      const hashes = new Map();
      const destination = path.join(staging, 'data', spec.regionId);
      fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
      for (const entry of entries) {
        if (entry.directory) fs.mkdirSync(path.join(destination, entry.relative), { recursive: true, mode: 0o750 });
        else {
          const hash = await copyFileVerified(entry.absolute, path.join(destination, entry.relative));
          hashes.set(entry.relative, hash);
          checksums.set(`data/${spec.regionId}/${entry.relative}`, hash);
        }
      }
      rootResults.push({
        regionId: spec.regionId, configKey: spec.configKey, relativeDir: `data/${spec.regionId}`,
        sourceRoot: spec.rootAbs, files: entries.filter((entry) => !entry.directory).length,
        bytes: entries.reduce((sum, entry) => sum + (entry.size || 0), 0), treeHash: treeHash(entries, hashes)
      });
    }
    const configSnapshot = JSON.parse(JSON.stringify(config));
    writeJson(path.join(staging, 'config.snapshot.json'), configSnapshot);
    checksums.set('config.snapshot.json', await shaFile(path.join(staging, 'config.snapshot.json')));
    const manifest = {
      product: 'pagesai', formatVersion: BACKUP_FORMAT_VERSION, storageSchemaVersion: STORAGE_SCHEMA_VERSION,
      configSchemaVersion: config.schemaVersion, backupId, label, createdAt: new Date().toISOString(),
      deploymentId: config.deploymentId, consistency: { writesQuiesced: true, note: '调用方在同一 quiesce 临界区暂停全部 Mongo 与文件写入' },
      source: { dbName, dataRoot: config.dataRoot },
      database: { engine: 'mongodb', collections: exported },
      roots: rootResults,
      counts: { collections: exported.length, documents: exported.reduce((sum, item) => sum + item.count, 0), files: rootResults.reduce((sum, item) => sum + item.files, 0), bytes: rootResults.reduce((sum, item) => sum + item.bytes, 0) }
    };
    writeJson(path.join(staging, 'manifest.json'), manifest);
    const checksumText = [...checksums.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([file, hash]) => `${hash}  ${file}`).join('\n');
    fs.writeFileSync(path.join(staging, 'files.sha256'), `${checksumText}\n`, { mode: 0o600 });
    fs.renameSync(staging, finalDir);
    return { backupDir: finalDir, manifest };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  } finally {
    if (resumed) await quiesce(false);
  }
}

async function verifyBackup(backupDir, { verifyContent = true } = {}) {
  const manifest = readJson(path.join(backupDir, 'manifest.json'));
  if (manifest.product !== 'pagesai' || manifest.formatVersion !== BACKUP_FORMAT_VERSION || manifest.storageSchemaVersion !== STORAGE_SCHEMA_VERSION || manifest.configSchemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw backupError('备份格式、存储模式或配置版本不受支持');
  }
  if (!manifest.consistency || manifest.consistency.writesQuiesced !== true) throw backupError('备份没有一致性写暂停证明');
  const config = readJson(path.join(backupDir, 'config.snapshot.json'));
  validateConfig(config, manifest.deploymentId);
  const expected = new Map();
  for (const line of fs.readFileSync(path.join(backupDir, 'files.sha256'), 'utf8').split('\n')) {
    if (!line) continue;
    const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
    if (!match) throw backupError('files.sha256 行格式非法');
    expected.set(safeRelative(match[2]), match[1]);
  }
  let checkedFiles = 0;
  for (const [relative, hash] of expected) {
    const file = path.join(backupDir, relative);
    if (!fs.existsSync(file) || await shaFile(file) !== hash) throw backupError(`备份文件哈希不匹配：${relative}`);
    checkedFiles += 1;
  }
  const listed = new Set(expected.keys());
  for (const root of manifest.roots) {
    const entries = collect(path.join(backupDir, root.relativeDir));
    const hashes = new Map();
    for (const entry of entries) {
      if (entry.directory) continue;
      const relative = `${root.relativeDir}/${entry.relative}`;
      if (!listed.has(relative)) throw backupError(`区域含未登记文件：${relative}`);
      hashes.set(entry.relative, expected.get(relative));
    }
    const actual = treeHash(entries, hashes);
    if (actual !== root.treeHash) throw backupError(`区域树哈希不匹配：${root.regionId}`);
  }
  let checkedReferences = 0;
  if (verifyContent) {
    const roots = new Map(manifest.roots.map((root) => [root.regionId, root]));
    for (const name of ['storage_files', 'storage_file_revisions']) {
      const file = path.join(backupDir, 'mongodb', `${name}.jsonl`);
      if (!fs.existsSync(file)) continue;
      for await (const document of jsonLines(file)) {
        if (document.tombstone) continue;
        const root = roots.get(document.regionId);
        if (!root) throw backupError('文件元数据引用未登记区域');
        safeRelative(document.contentPath);
        const physical = path.join(backupDir, root.relativeDir, document.contentPath);
        if (!inside(path.join(backupDir, root.relativeDir), physical) || !fs.existsSync(physical)) throw backupError(`文件引用缺失：${document.fileId}`);
        const stat = fs.statSync(physical);
        if (stat.size !== document.size || await shaFile(physical) !== document.contentHash) throw backupError(`文件引用哈希不一致：${document.fileId}`);
        checkedReferences += 1;
      }
    }
  }
  return { ok: true, manifest, config, checkedFiles, checkedReferences };
}

function relocatedConfig(snapshot, targetDataRoot) {
  const config = JSON.parse(JSON.stringify(snapshot));
  const oldRoot = path.resolve(snapshot.dataRoot);
  config.dataRoot = path.resolve(targetDataRoot);
  config.storage = {};
  for (const [key, source] of Object.entries(snapshot.storage)) {
    if (!inside(oldRoot, source) || path.resolve(source) === oldRoot) throw restoreError(`区域 ${key} 不在原数据根内，不能自动隔离重定位`);
    config.storage[key] = path.join(config.dataRoot, path.relative(oldRoot, source));
  }
  if (snapshot.database && snapshot.database.stateDir) {
    if (!inside(oldRoot, snapshot.database.stateDir)) throw restoreError('状态目录不在原数据根内');
    config.database.stateDir = path.join(config.dataRoot, path.relative(oldRoot, snapshot.database.stateDir));
  }
  return config;
}

function validateRestoreConfig(snapshot, config, targetDataRoot, specs) {
  validateConfig(config, snapshot.deploymentId, restoreError);
  if (path.resolve(config.dataRoot) !== path.resolve(targetDataRoot)) throw restoreError('恢复配置 dataRoot 与隔离目标不一致');
  for (const spec of specs) {
    const target = config.storage[spec.configKey];
    if (!target || !inside(targetDataRoot, target) || path.resolve(target) === path.resolve(targetDataRoot)) throw restoreError(`恢复区域 ${spec.regionId} 未指向隔离数据根内`);
    const declaration = config.regions.find((item) => item.regionId === spec.regionId);
    if (!declaration || declaration.physicalRoot.configKey !== spec.configKey) throw restoreError(`恢复配置区域引用不一致：${spec.regionId}`);
  }
  for (let i = 0; i < specs.length; i++) for (let j = i + 1; j < specs.length; j++) {
    const a = config.storage[specs[i].configKey];
    const b = config.storage[specs[j].configKey];
    if (inside(a, b) || inside(b, a)) throw restoreError('恢复区域物理根重叠');
  }
}

async function restoreBackup({ backupDir, client, targetDbName, targetDataRoot, config = null, isolated = false }) {
  if (isolated !== true) throw restoreError('此实现只允许显式 isolated=true 的隔离恢复，禁止覆盖在线部署');
  if (!client || !targetDbName) throw restoreError('恢复需要显式 Mongo client 与 targetDbName');
  if (!path.isAbsolute(targetDataRoot) || path.resolve(targetDataRoot) === path.parse(targetDataRoot).root) throw restoreError('隔离恢复目标必须是安全的绝对目录');
  const verified = await verifyBackup(backupDir);
  const manifest = verified.manifest;
  const snapshot = verified.config;
  if (targetDbName === manifest.source.dbName) throw restoreError('隔离恢复不能写回源数据库');
  if (path.resolve(targetDataRoot) === path.resolve(manifest.source.dataRoot) || inside(manifest.source.dataRoot, targetDataRoot) || inside(targetDataRoot, manifest.source.dataRoot)) throw restoreError('隔离恢复不能写回或包含源数据根');
  if (inside(backupDir, targetDataRoot) || inside(targetDataRoot, backupDir)) throw restoreError('恢复目标与备份目录不能相互包含');
  for (const root of manifest.roots) if (inside(root.sourceRoot, targetDataRoot) || inside(targetDataRoot, root.sourceRoot)) throw restoreError('恢复目标与源文件根重叠');
  const specs = regionSpecs(snapshot, manifest.roots.map((root) => ({ regionId: root.regionId, rootAbs: root.sourceRoot })));
  const restoredConfig = config ? JSON.parse(JSON.stringify(config)) : relocatedConfig(snapshot, targetDataRoot);
  validateRestoreConfig(snapshot, restoredConfig, targetDataRoot, specs);
  const existingCollections = await client.db(targetDbName).listCollections({}, { nameOnly: true }).toArray();
  if (existingCollections.length > 0) throw restoreError('目标 Mongo 数据库非空，拒绝覆盖');
  if (fs.existsSync(targetDataRoot) && fs.readdirSync(targetDataRoot).length > 0) throw restoreError('目标文件根非空，拒绝覆盖');
  const staging = `${targetDataRoot}.restore-staging-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  let databasePopulated = false;
  try {
    fs.mkdirSync(path.dirname(targetDataRoot), { recursive: true, mode: 0o750 });
    fs.mkdirSync(staging, { recursive: false, mode: 0o700 });
    for (const root of manifest.roots) {
      const configKey = root.configKey;
      const targetRoot = restoredConfig.storage[configKey];
      const relativeTarget = path.relative(targetDataRoot, targetRoot);
      const destination = path.join(staging, relativeTarget);
      const entries = collect(path.join(backupDir, root.relativeDir));
      fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
      for (const entry of entries) {
        if (entry.directory) fs.mkdirSync(path.join(destination, entry.relative), { recursive: true, mode: 0o750 });
        else await copyFileVerified(entry.absolute, path.join(destination, entry.relative));
      }
    }
    const rootById = new Map(manifest.roots.map((root) => [root.regionId, restoredConfig.storage[root.configKey]]));
    // 从第一次可能写入起，任何失败都必须清理这个已确认为空的隔离数据库。
    databasePopulated = true;
    for (const collection of manifest.database.collections) {
      const target = client.db(targetDbName).collection(collection.name);
      const documents = [];
      for await (const document of jsonLines(path.join(backupDir, collection.file))) {
        if (collection.name === 'storage_regions') document.rootAbs = rootById.get(document.regionId);
        documents.push(document);
        if (documents.length === 500) { await target.insertMany(documents.splice(0), { ordered: true }); }
      }
      if (documents.length) await target.insertMany(documents, { ordered: true });
      if (await target.countDocuments() !== collection.count) throw restoreError(`恢复集合文档数不一致：${collection.name}`);
    }
    // 恢复后的数据库引用必须已重定位，并再次核对真实文件哈希。
    const restoredFiles = client.db(targetDbName).collection('storage_file_revisions');
    const cursor = restoredFiles.find({ tombstone: { $ne: true } });
    for await (const document of cursor) {
      const root = rootById.get(document.regionId);
      const physical = path.join(staging, path.relative(targetDataRoot, root), document.contentPath);
      if (!inside(staging, physical) || !fs.existsSync(physical) || fs.statSync(physical).size !== document.size || await shaFile(physical) !== document.contentHash) {
        throw restoreError(`恢复后文件引用或哈希不一致：${document.fileId}`);
      }
    }
    if (fs.existsSync(targetDataRoot)) fs.rmdirSync(targetDataRoot);
    fs.renameSync(staging, targetDataRoot);
    return { ok: true, isolated: true, targetDbName, targetDataRoot, config: restoredConfig, manifest };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (databasePopulated) await client.db(targetDbName).dropDatabase();
    throw error;
  }
}

async function diagnoseStorage({ content, regionIds, deep = true }) {
  const recovery = await content.recover();
  const regions = [];
  for (const regionId of regionIds) regions.push({ regionId, ...(await content.reconcile({ regionId, deep })) });
  return { ok: recovery.failed.length === 0 && regions.every((region) => region.missing.length === 0 && region.mismatched.length === 0), recovery, regions };
}

module.exports = { BACKUP_FORMAT_VERSION, createBackup, verifyBackup, restoreBackup, relocatedConfig, diagnoseStorage, treeHash };
