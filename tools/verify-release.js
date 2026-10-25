#!/usr/bin/env node
'use strict';
/**
 * 发布证明自检（P7 / M6）
 *
 * 职责：把"能不能发布"从口头结论变成一条可复跑的命令。检查项：
 *   1. 必需文档存在（README / SECURITY / CONTRIBUTING / CHANGELOG / 许可决策 / 第三方声明 / 发布检查单）
 *   2. 根 LICENSE 存在、可识别许可家族、不是占位文本（缺失即 B1 阻断）
 *   3. THIRD_PARTY_NOTICES 覆盖 PDF.js / Apache-2.0 / KaTeX / MIT / Node / Python / Rust，
 *      且仓库里真实存在的 vendored 文件必须逐个登记
 *   4. 禁用制品：node_modules、虚拟环境、.env*、*.pem/*.p12/*.pfx、数据库、转储、备份包、Maildir、符号链接
 *   5. 密钥扫描：私钥头、主流云/代码托管令牌前缀、超长 sk- 串
 *   6. 地址扫描：RFC1918、100.64/10（Tailscale 常用段）、*.ts.net、本机绝对路径；
 *      扫描器自身的模式定义与测试夹具降级为警告
 *   7. 迁移台账：解析 tools/upgrade.js 的内置迁移定义（ID 唯一/四位以上/递增/签名唯一），
 *      与 docs/release-checklist.md 的台账表逐条核对；若给出 --ledger，再校验运行时台账的格式与签名哈希
 *   8. 契约 schema 存在且是合法 JSON（M1/M2 的证据前提）
 *   9. 发布检查单结构：M0–M6 六段齐备、引用本工具、含发布判定
 *  10. 编排预设镜像 digest 不得仍是占位符（否则预设不可用）
 *
 * 约束：只使用 Node 内置模块；只读，不写任何文件；不访问网络。
 * 退出码：0 = 通过（无阻断）；1 = 存在阻断项（不可发布）；2 = 参数错误。
 *
 * 用法：
 *   node tools/verify-release.js
 *   node tools/verify-release.js --json
 *   node tools/verify-release.js --artifact /tmp/pagesai-export      # 只对导出产物做制品/地址扫描
 *   node tools/verify-release.js --ledger /srv/pagesai/state/migrations.json
 *   node tools/verify-release.js --exclude docs/m0                   # 声明内部证据不随发布物分发
 *
 * 说明：
 *  - 默认扫描"发布根目录"（本仓库）。若发布物是白名单导出的子集，请用 --artifact 指向该目录，
 *    并确认产物内不含 docs/m0/ 这类内部审计证据。
 *  - --exclude 只影响制品/密钥/地址扫描，不影响必需文档、LICENSE、第三方声明与迁移台账。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const LEDGER_FORMAT_VERSION = 1;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_FINDINGS_PRINTED = 8;

const REQUIRED_DOCS = [
  { rel: 'README.md', minBytes: 200, label: '项目说明' },
  { rel: 'LICENSE-DECISION.md', minBytes: 200, label: '许可证决策记录' },
  { rel: 'THIRD_PARTY_NOTICES.md', minBytes: 200, label: '第三方组件声明' },
  { rel: 'SECURITY.md', minBytes: 200, label: '安全政策' },
  { rel: 'CONTRIBUTING.md', minBytes: 200, label: '贡献指南' },
  { rel: 'CHANGELOG.md', minBytes: 200, label: '变更记录' },
  { rel: 'docs/release-checklist.md', minBytes: 200, label: '发布检查单（M0–M6）' }
];

const NOTICE_TOKENS = [
  { token: 'PDF.js', why: 'vendored PDF 渲染器（Apache-2.0）' },
  { token: 'Apache-2.0', why: 'PDF.js 的许可文本' },
  { token: 'KaTeX', why: '公式渲染（MIT）' },
  { token: 'MIT', why: 'KaTeX 的许可文本' },
  { token: 'Node', why: 'Node 依赖类目' },
  { token: 'Python', why: 'Python 依赖类目' },
  { token: 'Rust', why: 'Rust crate 类目' }
];

const FORBIDDEN_DIRS = new Set([
  'node_modules',
  '.git',
  'Maildir',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  '.mypy_cache',
  '.pytest_cache',
  'target',
  'dist',
  'build'
]);
// 注意：dist/build/target 只在发布物里禁止；开发构建产物不应入库。
const FORBIDDEN_FILE_RULES = [
  { id: 'env', re: /^\.env(?:$|\.)/i, desc: '环境变量文件 .env*' },
  { id: 'pem', re: /\.pem$/i, desc: '证书/私钥 .pem' },
  { id: 'p12', re: /\.p12$/i, desc: '证书/私钥 .p12' },
  { id: 'pfx', re: /\.pfx$/i, desc: '证书/私钥 .pfx' },
  { id: 'key', re: /\.key$/i, desc: '密钥文件 .key' },
  { id: 'sqlite', re: /\.sqlite(?:3)?(?:-(?:wal|shm|journal))?$/i, desc: 'SQLite 数据库' },
  { id: 'dump', re: /\.dump$/i, desc: '数据库转储 .dump' },
  { id: 'sqlgz', re: /\.sql\.gz$/i, desc: '压缩数据库转储 .sql.gz' },
  { id: 'archive', re: /\.(?:tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|zip|7z|rar)$/i, desc: '归档/发布包' },
  { id: 'backup', re: /\.(?:bak|backup|orig)$/i, desc: '备份副本' },
  { id: 'dsstore', re: /^\.DS_Store$/, desc: 'macOS 元数据' },
  { id: 'log', re: /\.log$/i, desc: '日志文件' },
  { id: 'mailldir', re: /^(?:dovecot|postfix)/i, desc: '邮件服务状态文件' }
];

const SECRET_RULES = [
  { id: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, desc: '私钥起始标记' },
  { id: 'aws-akid', re: /\bAKIA[0-9A-Z]{16}\b/, desc: '云厂商访问密钥 ID' },
  { id: 'aliyun', re: /\bLTAI[0-9A-Za-z]{12,}\b/, desc: '云厂商 AccessKey' },
  {
    id: 'code-host-token',
    re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    desc: '代码托管/协作平台令牌'
  },
  { id: 'openai-style', re: /\bsk-[A-Za-z0-9]{20,}\b/, desc: '模型服务密钥样式（sk-）' },
  { id: 'google-api', re: /\bAIza[0-9A-Za-z_-]{20,}\b/, desc: 'Google API Key 样式' }
];

// 地址规则：severity 为 block 时，命中即阻断（测试夹具与扫描器自身降级）
const ADDRESS_RULES = [
  {
    id: 'rfc1918-10',
    re: /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    desc: 'RFC1918 私网地址（10/8）'
  },
  {
    id: 'rfc1918-192',
    re: /\b192\.168\.\d{1,3}\.\d{1,3}\b/g,
    desc: 'RFC1918 私网地址（192.168/16）'
  },
  {
    id: 'rfc1918-172',
    re: /\b172\.(?:1[6-9]|2[0-9]|3[01])\.\d{1,3}\.\d{1,3}\b/g,
    desc: 'RFC1918 私网地址（172.16/12）'
  },
  {
    id: 'cgnat',
    re: /\b100\.(?:6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.\d{1,3}\.\d{1,3}\b/g,
    desc: '100.64/10 地址（Tailscale 等组网常用段）'
  },
  {
    id: 'tailnet-host',
    re: /\b(?:[A-Za-z0-9-]+\.)+ts\.net\b/gi,
    desc: 'Tailnet 主机名（*.ts.net）'
  }
];

const HOME_PATH_RULES = [
  { id: 'users-home', re: /\/Users\/[A-Za-z][A-Za-z0-9._-]*/g, desc: '本机用户绝对路径（/Users/<name>）' },
  { id: 'linux-home', re: /\/home\/[a-z][a-z0-9._-]*\//g, desc: '服务器用户绝对路径（/home/<user>/）' }
];

const OWNER_RULES = [
  {
    id: 'hardcoded-owner',
    re: /(?:OWNER|owner|DEV_USER|devUser)\s*[:=]\s*['"]myc['"]/g,
    desc: '写死的私人 owner 身份'
  }
];

// 允许的地址（回环与文档示例用段），不算泄露
function isAllowedAddress(text) {
  if (/^127\./.test(text) || text === '0.0.0.0' || text === '::1') return true;
  if (text === '100.64.0.0') return true; // 网段基址写法（100.64.0.0/10），不是某台主机
  if (/^192\.0\.2\./.test(text)) return true; // RFC 5737 TEST-NET-1
  if (/^198\.51\.100\./.test(text)) return true; // RFC 5737 TEST-NET-2
  if (/^203\.0\.113\./.test(text)) return true; // RFC 5737 TEST-NET-3
  if (/^198\.18\./.test(text)) return true; // RFC 2544 基准测试段
  return false;
}

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
const USAGE = [
  'PagesAI 发布证明自检（tools/verify-release.js）',
  '',
  '用法：',
  '  node tools/verify-release.js [选项]',
  '',
  '选项：',
  '  --root DIR       发布根目录（默认：本脚本上级目录）',
  '  --artifact DIR   只对该目录做制品/密钥/地址扫描（默认与发布根相同）',
  '  --ledger FILE    运行时迁移台账（<stateDir>/migrations.json），给了就校验格式与签名哈希',
  '  --exclude PREFIX 声明该路径前缀不随发布物分发（可重复，仅影响扫描类检查）',
  '  --json           以单行 JSON 输出（便于自动化断言）',
  '  -h, --help       显示本帮助',
  '',
  '退出码：0 = 通过；1 = 存在阻断项（不可发布）；2 = 参数错误。',
  '',
  '示例：',
  '  node tools/verify-release.js',
  '  node tools/verify-release.js --artifact /tmp/pagesai-export --json',
  '  node tools/verify-release.js --ledger /srv/pagesai/state/migrations.json',
  ''
].join('\n');

function parseArgs(argv) {
  const options = { root: PROJECT_ROOT, artifact: null, ledger: null, excludes: [], json: false, help: false };
  const needValue = (i, flag) => {
    const value = argv[i + 1];
    if (value === undefined || value === '' || value.startsWith('--')) {
      throw new UsageError(`${flag} 需要一个值`);
    }
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--root') {
      options.root = path.resolve(needValue(i, arg));
      i += 1;
    } else if (arg === '--artifact') {
      options.artifact = path.resolve(needValue(i, arg));
      i += 1;
    } else if (arg === '--ledger') {
      options.ledger = path.resolve(needValue(i, arg));
      i += 1;
    } else if (arg === '--exclude') {
      const value = needValue(i, arg).replace(/^\.\//, '').replace(/\/+$/, '');
      if (value === '') throw new UsageError('--exclude 不能是根目录');
      options.excludes.push(value);
      i += 1;
    } else {
      throw new UsageError(`未知参数：${arg}`);
    }
  }
  return options;
}

class UsageError extends Error {}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function readTextIfPossible(absPath) {
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) return null;
  let buffer;
  try {
    buffer = fs.readFileSync(absPath);
  } catch {
    return null;
  }
  if (buffer.includes(0)) return null; // 二进制
  return buffer.toString('utf8');
}

function walk(root, { excludes = [] } = {}) {
  const files = [];
  const dirs = [];
  const links = [];
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop();
    const abs = rel === '' ? root : path.join(root, rel);
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (excludes.some((prefix) => childRel === prefix || childRel.startsWith(`${prefix}/`))) continue;
      if (entry.isSymbolicLink()) {
        links.push(childRel);
        continue;
      }
      if (entry.isDirectory()) {
        dirs.push(childRel);
        if (FORBIDDEN_DIRS.has(entry.name)) {
          files.push({ rel: childRel, dir: true, forbiddenDir: entry.name });
          continue; // 不深入被禁目录，避免把整棵依赖树扫一遍
        }
        stack.push(childRel);
      } else if (entry.isFile()) {
        files.push({ rel: childRel, dir: false });
      }
    }
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { files, dirs, links };
}

function tierOf(rel) {
  if (/(^|\/)(tests?|fixtures?)\//.test(rel)) return 'fixture';
  if (rel === 'tools/check-imports.js' || rel === 'tools/verify-release.js') return 'scanner';
  return 'product';
}

function isInternalEvidence(rel) {
  return rel === 'docs/m0' || rel.startsWith('docs/m0/');
}

function truncate(text, max = 160) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

// ---------------------------------------------------------------------------
// 检查实现
// ---------------------------------------------------------------------------
function newCheck(id, title) {
  return { id, title, level: 'OK', issues: [], notes: [] };
}

function block(check, issue) {
  check.level = 'BLOCK';
  check.issues.push({ level: 'BLOCK', ...issue });
}

function warn(check, issue) {
  if (check.level === 'OK') check.level = 'WARN';
  check.issues.push({ level: 'WARN', ...issue });
}

function note(check, text) {
  check.notes.push(text);
}

function checkRequiredDocs(root, checks) {
  const check = newCheck('required-docs', '必需文档');
  for (const doc of REQUIRED_DOCS) {
    const abs = path.join(root, doc.rel);
    let text = null;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      block(check, { file: doc.rel, message: `缺少${doc.label}（${doc.rel}）` });
      continue;
    }
    if (text.length < doc.minBytes) {
      block(check, { file: doc.rel, message: `${doc.label} 内容过短（${text.length} 字节 < ${doc.minBytes}），疑似占位` });
    }
  }
  checks.push(check);
}

function detectLicenseFamily(text) {
  if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(text)) return 'AGPL-3.0';
  if (/Apache License[\s\S]{0,40}Version 2\.0/i.test(text)) return 'Apache-2.0';
  if (/Permission is hereby granted, free of charge/i.test(text)) return 'MIT';
  if (/GNU GENERAL PUBLIC LICENSE/i.test(text)) return 'GPL';
  if (/Mozilla Public License/i.test(text)) return 'MPL-2.0';
  if (/BSD 3-Clause|Redistribution and use in source and binary forms/i.test(text)) return 'BSD';
  return null;
}

function checkLicense(root, checks) {
  const check = newCheck('license-root', '根 LICENSE');
  const licensePath = path.join(root, 'LICENSE');
  let text = null;
  try {
    text = fs.readFileSync(licensePath, 'utf8');
  } catch {
    block(check, {
      file: 'LICENSE',
      message: '根 LICENSE 缺失：公开推送即"保留所有权利"（B1 / K7 / 决策 D1），属发布阻断'
    });
  }
  if (text !== null) {
    if (text.trim().length < 300) {
      block(check, { file: 'LICENSE', message: `LICENSE 只有 ${text.trim().length} 个字符，不像完整许可正文` });
    }
    if (/\bTODO\b|\bFIXME\b|待填写|待定|PLACEHOLDER|示例许可文本/i.test(text)) {
      block(check, { file: 'LICENSE', message: 'LICENSE 含占位/待填标记，不能作为公开发布的许可' });
    }
    const family = detectLicenseFamily(text);
    if (family) note(check, `识别到许可家族：${family}`);
    else warn(check, { file: 'LICENSE', message: '无法识别许可家族（既不是 MIT/Apache-2.0/AGPL/GPL/MPL/BSD 的常见写法）' });
  }

  // 与决策记录的状态行交叉核对
  const decisionPath = path.join(root, 'LICENSE-DECISION.md');
  let decision = null;
  try {
    decision = fs.readFileSync(decisionPath, 'utf8');
  } catch {
    /* required-docs 已报告缺失 */
  }
  if (decision) {
    const statusMatch = decision.match(/状态[：:]\s*\**\s*([^\n*]+)/);
    const status = statusMatch ? statusMatch[1].trim() : '(未找到状态行)';
    note(check, `LICENSE-DECISION.md 状态：${truncate(status, 60)}`);
    const undecided = /未决|待定|待负责人|未选择/.test(status);
    if (text === null && !undecided) {
      warn(check, {
        file: 'LICENSE-DECISION.md',
        message: '决策记录声称已定许可，但根 LICENSE 不存在（口径不一致）'
      });
    }
    if (text !== null && undecided) {
      warn(check, {
        file: 'LICENSE-DECISION.md',
        message: '根 LICENSE 已存在，但决策记录仍标"未决"：需回填选定许可与决策记录表'
      });
    }
  }
  checks.push(check);
}

function checkThirdPartyNotices(root, inventory, checks) {
  const check = newCheck('third-party-notices', '第三方组件声明');
  const noticePath = path.join(root, 'THIRD_PARTY_NOTICES.md');
  let text = null;
  try {
    text = fs.readFileSync(noticePath, 'utf8');
  } catch {
    block(check, { file: 'THIRD_PARTY_NOTICES.md', message: '缺少第三方组件声明（B2）' });
    checks.push(check);
    return;
  }
  const missing = NOTICE_TOKENS.filter((item) => !text.includes(item.token));
  for (const item of missing) {
    block(check, { file: 'THIRD_PARTY_NOTICES.md', message: `未覆盖 ${item.token}（${item.why}）` });
  }
  if (!/待补/.test(text)) {
    warn(check, {
      file: 'THIRD_PARTY_NOTICES.md',
      message: '没有任何"待补"条目：请确认所有依赖确已采集完成（未采集却写"已完成"属虚假声明）'
    });
  }

  // 真实存在的 vendored 资产必须逐个登记
  const vendored = inventory.files
    .filter((entry) => !entry.dir)
    .filter((entry) => /(?:^|\/)(?:pdf(?:\.worker)?(?:\.legacy)?(?:\.min)?\.mjs|katex(?:\.min)?\.(?:js|css)|[^/]*katex[^/]*\.(?:woff2?|ttf))$/i.test(entry.rel));
  if (vendored.length === 0) {
    note(check, '未发现 vendored 的 PDF.js/KaTeX 文件：声明里只能是"待补"（当前结论）');
  } else {
    for (const file of vendored) {
      const base = path.basename(file.rel);
      if (!text.includes(base) && !text.includes(file.rel)) {
        block(check, { file: 'THIRD_PARTY_NOTICES.md', message: `vendored 文件 ${file.rel} 未在声明中登记` });
      }
    }
  }

  // 许可正文承接：若真有 PDF.js，必须能指出 Apache-2.0 正文位置
  if (vendored.length > 0 && !/(LICENSE-Apache-2\.0|Apache-2\.0 正文|apache-2\.0\.txt)/i.test(text)) {
    block(check, {
      file: 'THIRD_PARTY_NOTICES.md',
      message: '存在 vendored PDF.js，但未指明 Apache-2.0 正文随附位置（Apache-2.0 §4 要求）'
    });
  }
  checks.push(check);
}

function checkForbiddenArtifacts(scanRoot, scanLabel, inventory, checks) {
  const check = newCheck('forbidden-artifacts', `禁用制品（${scanLabel}）`);
  for (const entry of inventory.files) {
    if (entry.dir && entry.forbiddenDir) {
      block(check, { file: entry.rel, message: `禁止入库的目录：${entry.forbiddenDir}` });
      continue;
    }
    if (entry.dir) continue;
    const base = path.basename(entry.rel);
    for (const rule of FORBIDDEN_FILE_RULES) {
      if (rule.re.test(base)) {
        block(check, { file: entry.rel, message: `禁止入库：${rule.desc}` });
        break;
      }
    }
  }
  for (const link of inventory.links) {
    block(check, { file: link, message: '符号链接：发布物不得包含符号链接（可能指向树外内容）' });
  }
  if (inventory.files.length === 0) {
    block(check, { file: scanRoot, message: '扫描目录为空或不存在的发布物' });
  }
  checks.push(check);
}

function checkSecrets(scanRoot, inventory, checks) {
  const check = newCheck('secrets-scan', '密钥与令牌扫描');
  for (const entry of inventory.files) {
    if (entry.dir) continue;
    const abs = path.join(scanRoot, entry.rel);
    const text = readTextIfPossible(abs);
    if (text === null) continue;
    const tier = tierOf(entry.rel);
    for (const rule of SECRET_RULES) {
      const re = new RegExp(rule.re.source, rule.re.flags.includes('g') ? rule.re.flags : `${rule.re.flags}g`);
      let match;
      while ((match = re.exec(text)) !== null) {
        const line = text.slice(0, match.index).split('\n').length;
        const issue = {
          file: entry.rel,
          line,
          message: `命中${rule.desc}：${truncate(match[0], 24)}`,
          tier
        };
        if (tier === 'product') block(check, issue);
        else warn(check, { ...issue, message: `${issue.message}（${tier === 'fixture' ? '测试夹具，需人工确认是假值' : '扫描器模式定义'}）` });
      }
    }
  }
  checks.push(check);
}

function checkAddresses(scanRoot, scanLabel, inventory, checks) {
  const check = newCheck('address-scan', `私网地址与本机路径扫描（${scanLabel}）`);
  const scanned = { product: 0, fixture: 0, scanner: 0, hits: 0, files: 0 };

  for (const entry of inventory.files) {
    if (entry.dir) continue;
    const abs = path.join(scanRoot, entry.rel);
    const text = readTextIfPossible(abs);
    if (text === null) continue;
    scanned[tierOf(entry.rel)] += 1;
    const tier = tierOf(entry.rel);
    const lines = text.split(/\r?\n/);
    const hits = [];

    for (const rule of ADDRESS_RULES) {
      for (let i = 0; i < lines.length; i += 1) {
        const re = new RegExp(rule.re.source, rule.re.flags);
        let match;
        while ((match = re.exec(lines[i])) !== null) {
          if (isAllowedAddress(match[0])) continue;
          hits.push({ kind: 'address', ruleId: rule.id, desc: rule.desc, line: i + 1, token: match[0] });
        }
      }
    }
    for (const rule of HOME_PATH_RULES) {
      for (let i = 0; i < lines.length; i += 1) {
        const re = new RegExp(rule.re.source, rule.re.flags);
        let match;
        while ((match = re.exec(lines[i])) !== null) {
          // 占位写法（如 /Users/<name>）不算命中
          if (/[<>]/.test(match[0])) continue;
          hits.push({ kind: 'home', ruleId: rule.id, desc: rule.desc, line: i + 1, token: match[0] });
        }
      }
    }
    for (const rule of OWNER_RULES) {
      const re = new RegExp(rule.re.source, rule.re.flags);
      let match;
      while ((match = re.exec(text)) !== null) {
        const line = text.slice(0, match.index).split('\n').length;
        hits.push({ kind: 'owner', ruleId: rule.id, desc: rule.desc, line, token: match[0] });
      }
    }

    if (hits.length === 0) continue;
    scanned.hits += hits.length;
    scanned.files += 1;

    // 同文件同类命中聚合成一条，避免输出被几十行同类地址淹没
    const groups = new Map();
    for (const hit of hits) {
      const key = `${hit.kind}\u0000${hit.desc}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(hit);
    }
    for (const group of groups.values()) {
      const first = group[0];
      const examples = group.slice(0, 3).map((hit) => `第${hit.line}行 ${truncate(hit.token, 32)}`);
      const more = group.length > examples.length ? ` 等 ${group.length} 处` : '';
      const message = `${first.desc} 共 ${group.length} 处（${examples.join('；')}${more}）`;
      const issue = { file: entry.rel, line: first.line, message, count: group.length };

      if (tier === 'fixture') {
        warn(check, { ...issue, message: `${message}：测试夹具，需人工确认是假值` });
      } else if (tier === 'scanner') {
        warn(check, { ...issue, message: `${message}：扫描器自身的模式定义` });
      } else if (first.kind === 'home' && first.ruleId !== 'users-home') {
        // 服务器路径可能出现在"拒绝复用的旧数据根"清单里，降级为警告，由负责人确认
        warn(check, { ...issue, message: `${message}：需确认是否应改为占位或环境变量` });
      } else if (isInternalEvidence(entry.rel)) {
        block(check, {
          ...issue,
          message: `${message}：内部审计证据 docs/m0 不得随发布物分发（移出发布根、脱敏，或用 --exclude docs/m0 声明）`
        });
      } else {
        block(check, {
          ...issue,
          message: first.kind === 'home' ? `${message}：真实本机用户路径，发布物不得包含（B8）` : message
        });
      }
    }
  }

  note(check, `已扫描文本文件 ${scanned.product + scanned.fixture + scanned.scanner} 个（产品 ${scanned.product} / 夹具 ${scanned.fixture} / 扫描器 ${scanned.scanner}）`);
  if (scanned.hits > 0) note(check, `命中 ${scanned.hits} 处，分布在 ${scanned.files} 个文件`);
  checks.push(check);
}

function parseMigrations(upgradeSource) {
  const startMarker = 'const MIGRATIONS = Object.freeze([';
  const start = upgradeSource.indexOf(startMarker);
  if (start < 0) return { ok: false, reason: '未找到 MIGRATIONS 定义', migrations: [] };
  const end = upgradeSource.indexOf(']);', start);
  if (end < 0) return { ok: false, reason: 'MIGRATIONS 定义未闭合', migrations: [] };
  const blockSource = upgradeSource.slice(start, end);
  const re = /\{\s*id:\s*'([^']+)',\s*module:\s*'([^']+)',\s*name:\s*'([^']+)',\s*signature:\s*'([^']+)'/g;
  const migrations = [];
  let match;
  while ((match = re.exec(blockSource)) !== null) {
    migrations.push({ id: match[1], module: match[2], name: match[3], signature: match[4] });
  }
  return { ok: true, migrations };
}

function migrationSignatureHash(migration) {
  return sha256(`${migration.id}|${migration.module}|${migration.signature}`);
}

function checkMigrationLedger(root, ledgerPath, checks) {
  const check = newCheck('migration-ledger', '迁移台账');

  const upgradePath = path.join(root, 'tools/upgrade.js');
  let upgradeSource = null;
  try {
    upgradeSource = fs.readFileSync(upgradePath, 'utf8');
  } catch {
    block(check, { file: 'tools/upgrade.js', message: '缺少升级工具：无法核对迁移台账定义' });
    checks.push(check);
    return;
  }

  const formatMatch = upgradeSource.match(/const LEDGER_FORMAT_VERSION\s*=\s*(\d+)\s*;/);
  if (!formatMatch) {
    block(check, { file: 'tools/upgrade.js', message: '未找到 LEDGER_FORMAT_VERSION 常量' });
  } else {
    const version = Number.parseInt(formatMatch[1], 10);
    if (version !== LEDGER_FORMAT_VERSION) {
      block(check, {
        file: 'tools/upgrade.js',
        message: `台账格式版本为 ${version}，本工具按 formatVersion=${LEDGER_FORMAT_VERSION} 校验：需同步工具与文档`
      });
    } else {
      note(check, `台账格式版本 formatVersion=${version}`);
    }
  }

  const parsed = parseMigrations(upgradeSource);
  if (!parsed.ok) {
    block(check, { file: 'tools/upgrade.js', message: parsed.reason });
    checks.push(check);
    return;
  }
  const migrations = parsed.migrations;
  if (migrations.length === 0) {
    block(check, { file: 'tools/upgrade.js', message: '内置迁移为空：升级工具没有可执行迁移' });
  }

  const seenIds = new Map();
  const seenSignatures = new Map();
  let previousId = null;
  for (const migration of migrations) {
    if (!/^\d{4,}$/.test(migration.id)) {
      block(check, { file: 'tools/upgrade.js', message: `迁移 ID ${migration.id} 不是 4 位以上数字（契约 data.migrations.id 规则）` });
    }
    if (seenIds.has(migration.id)) {
      block(check, { file: 'tools/upgrade.js', message: `迁移 ID 重复：${migration.id}` });
    }
    seenIds.set(migration.id, migration);
    if (seenSignatures.has(migration.signature)) {
      block(check, {
        file: 'tools/upgrade.js',
        message: `迁移签名重复：${migration.signature}（${seenSignatures.get(migration.signature)} 与 ${migration.id}）`
      });
    }
    seenSignatures.set(migration.signature, migration.id);
    if (previousId !== null && migration.id <= previousId) {
      block(check, { file: 'tools/upgrade.js', message: `迁移顺序不递增：${previousId} → ${migration.id}` });
    }
    previousId = migration.id;
  }

  // 与发布检查单的台账表逐条核对
  const checklistPath = path.join(root, 'docs/release-checklist.md');
  let checklist = null;
  try {
    checklist = fs.readFileSync(checklistPath, 'utf8');
  } catch {
    /* required-docs 已报告 */
  }
  if (checklist === null) {
    block(check, { file: 'docs/release-checklist.md', message: '缺少发布检查单：无法把迁移台账与发布记录对上' });
  } else {
    for (const migration of migrations) {
      const documented = checklist
        .split(/\r?\n/)
        .some((line) => line.includes(migration.id) && line.includes(migration.signature));
      if (!documented) {
        block(check, {
          file: 'docs/release-checklist.md',
          message: `迁移 ${migration.id}（${migration.signature}）未登记在台账表中：新增迁移必须同步发布检查单`
        });
      }
    }
    if (!/formatVersion/.test(checklist)) {
      warn(check, { file: 'docs/release-checklist.md', message: '检查单未提及台账 formatVersion，建议写明' });
    }
  }

  // 运行时台账（可选）
  if (ledgerPath) {
    let raw = null;
    try {
      raw = fs.readFileSync(ledgerPath, 'utf8');
    } catch (error) {
      block(check, { file: ledgerPath, message: `运行时台账不可读：${error.code || error.message}` });
    }
    if (raw !== null) {
      let ledger = null;
      try {
        ledger = JSON.parse(raw);
      } catch {
        block(check, { file: ledgerPath, message: '运行时台账不是合法 JSON' });
      }
      if (ledger) {
        if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
          block(check, { file: ledgerPath, message: '运行时台账应为 JSON 对象' });
        } else {
          if (ledger.formatVersion !== LEDGER_FORMAT_VERSION) {
            block(check, {
              file: ledgerPath,
              message: `运行时台账 formatVersion=${ledger.formatVersion}，与工具的 ${LEDGER_FORMAT_VERSION} 不一致`
            });
          }
          if (!Array.isArray(ledger.applied)) {
            block(check, { file: ledgerPath, message: '运行时台账缺少 applied 数组' });
          } else {
            const appliedIds = new Set();
            for (const entry of ledger.applied) {
              if (!entry || typeof entry !== 'object') {
                block(check, { file: ledgerPath, message: 'applied 中存在非对象条目' });
                continue;
              }
              const known = seenIds.get(String(entry.id));
              if (!known) {
                block(check, {
                  file: ledgerPath,
                  message: `运行时台账含本工具不认识的迁移 ${entry.id}：数据来自更新版本，禁止用旧工具继续`
                });
                continue;
              }
              if (appliedIds.has(known.id)) {
                block(check, { file: ledgerPath, message: `运行时台账重复记录迁移 ${known.id}` });
              }
              appliedIds.add(known.id);
              if (entry.module !== known.module) {
                block(check, {
                  file: ledgerPath,
                  message: `迁移 ${known.id} 的模块不一致（台账 ${entry.module} / 定义 ${known.module}）`
                });
              }
              if (entry.signatureSha256 !== migrationSignatureHash(known)) {
                block(check, {
                  file: ledgerPath,
                  message: `迁移 ${known.id} 的签名哈希不匹配：签名一旦发布不得修改（台账 ${truncate(entry.signatureSha256, 16)}…）`
                });
              }
            }
            note(check, `运行时台账已应用 ${appliedIds.size} 项（${ledgerPath}）`);
          }
        }
      }
    }
  } else {
    note(check, '未提供 --ledger：只校验内置定义与发布检查单，不校验某次部署的实际台账');
  }

  checks.push(check);
}

function checkContracts(root, checks) {
  const check = newCheck('contracts-present', '契约 schema');
  const required = [
    'contracts/module-manifest.schema.json',
    'contracts/storage-region.schema.json',
    'contracts/file-change.schema.json'
  ];
  for (const rel of required) {
    const abs = path.join(root, rel);
    let text = null;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      block(check, { file: rel, message: '缺少契约 schema（M1/M2 的证据前提）' });
      continue;
    }
    try {
      JSON.parse(text);
    } catch (error) {
      block(check, { file: rel, message: `不是合法 JSON：${error.message}` });
    }
  }
  checks.push(check);
}

function checkReleaseChecklist(root, checks) {
  const check = newCheck('release-checklist', '发布检查单结构');
  const rel = 'docs/release-checklist.md';
  let text = null;
  try {
    text = fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    block(check, { file: rel, message: '缺少发布检查单' });
    checks.push(check);
    return;
  }
  for (const milestone of ['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6']) {
    const re = new RegExp(`(^|\\n)#{1,4}\\s*[^\\n]*\\b${milestone}\\b`);
    if (!re.test(text)) block(check, { file: rel, message: `缺少 ${milestone} 段落（M0–M6 必须逐段列放行条件）` });
  }
  if (!text.includes('tools/verify-release.js')) {
    block(check, { file: rel, message: '检查单未引用 tools/verify-release.js：发布证明必须可复跑' });
  }
  if (!/发布判定|放行判定/.test(text)) {
    block(check, { file: rel, message: '检查单缺少"发布判定"结论段' });
  }
  const blocked = (text.match(/\|\s*X\s*\|/g) || []).length;
  note(check, `检查单中标记为 X 的行：${blocked} 行（存在 X 即不得宣称可发布）`);
  checks.push(check);
}

function checkImageDigests(root, inventory, checks) {
  const check = newCheck('image-digests', '编排预设镜像 digest');
  const presetFiles = inventory.files.filter((entry) => !entry.dir && entry.rel.startsWith('deploy/presets/') && entry.rel.endsWith('.yml'));
  if (presetFiles.length === 0) {
    note(check, '未发现 deploy/presets/*.yml，跳过');
    checks.push(check);
    return;
  }
  let total = 0;
  const affected = [];
  for (const entry of presetFiles) {
    const text = readTextIfPossible(path.join(root, entry.rel));
    if (text === null) continue;
    const hits = text.match(/TAG-TODO-DIGEST/gi);
    if (hits) {
      total += hits.length;
      affected.push(`${path.basename(entry.rel)}(${hits.length})`);
    }
  }
  if (total > 0) {
    block(check, {
      file: 'deploy/presets/',
      message: `${presetFiles.length} 个预设中 ${affected.length} 个仍有占位镜像 digest（共 ${total} 处 TAG-TODO-DIGEST）：${truncate(affected.join('、'), 160)}`
    });
  }
  checks.push(check);
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------
function summarize(checks) {
  const summary = { block: 0, warn: 0, ok: 0 };
  for (const check of checks) {
    for (const issue of check.issues) {
      if (issue.level === 'BLOCK') summary.block += 1;
      else if (issue.level === 'WARN') summary.warn += 1;
    }
    if (check.issues.length === 0) summary.ok += 1;
  }
  return summary;
}

function printHuman(report) {
  const { root, artifact, excludes, checks, summary, generatedAt } = report;
  console.log('PagesAI 发布证明自检（tools/verify-release.js）');
  console.log(`发布根目录 : ${root}`);
  console.log(`扫描目录   : ${artifact === root ? '同发布根目录' : artifact}`);
  console.log(`生成时间   : ${generatedAt}`);
  if (excludes.length > 0) console.log(`已声明排除 : ${excludes.join('、')}（不随发布物分发）`);
  console.log('');
  for (const check of checks) {
    const tag = check.level === 'BLOCK' ? 'BLOCK' : check.level === 'WARN' ? ' WARN' : '   OK';
    console.log(`[${tag}] ${check.id.padEnd(20, ' ')} ${check.title}`);
    for (const text of check.notes) console.log(`         · ${text}`);
    const shown = check.issues.slice(0, MAX_FINDINGS_PRINTED);
    for (const issue of shown) {
      const where = issue.line ? `${issue.file}:${issue.line}` : issue.file;
      console.log(`         - ${where}  ${issue.message}`);
    }
    if (check.issues.length > shown.length) {
      console.log(`         … 另有 ${check.issues.length - shown.length} 项（用 --json 查看全部）`);
    }
  }
  console.log('');
  console.log('== 结论 ==');
  if (summary.block === 0) {
    console.log(`通过：0 项阻断、${summary.warn} 项警告、${summary.ok} 项干净。可进入人工签字流程。`);
  } else {
    console.log(`不可发布：${summary.block} 项阻断、${summary.warn} 项警告、${summary.ok} 项干净。`);
    console.log('阻断清单：');
    const blockers = [];
    for (const check of checks) {
      for (const issue of check.issues) {
        if (issue.level !== 'BLOCK') continue;
        const where = issue.line ? `${issue.file}:${issue.line}` : issue.file;
        blockers.push(` - [${check.id}] ${where} ${issue.message}`);
      }
    }
    for (const line of blockers.slice(0, 20)) console.log(line);
    if (blockers.length > 20) console.log(` … 另有 ${blockers.length - 20} 项阻断（用 --json 查看全部）`);
  }
}

function printJson(report) {
  const payload = {
    tool: 'tools/verify-release.js',
    generatedAt: report.generatedAt,
    root: report.root,
    artifact: report.artifact,
    excludes: report.excludes,
    ok: report.summary.block === 0,
    exitCode: report.summary.block === 0 ? 0 : 1,
    summary: report.summary,
    blockers: report.checks.flatMap((check) =>
      check.issues
        .filter((issue) => issue.level === 'BLOCK')
        .map((issue) => ({ check: check.id, file: issue.file, line: issue.line || null, message: issue.message }))
    ),
    checks: report.checks.map((check) => ({
      id: check.id,
      title: check.title,
      level: check.level,
      notes: check.notes,
      issues: check.issues
    }))
  };
  console.log(JSON.stringify(payload));
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!fs.existsSync(options.root) || !fs.statSync(options.root).isDirectory()) {
    throw new UsageError(`发布根目录不存在或不是目录：${options.root}`);
  }
  if (options.artifact && (!fs.existsSync(options.artifact) || !fs.statSync(options.artifact).isDirectory())) {
    throw new UsageError(`--artifact 目录不存在或不是目录：${options.artifact}`);
  }

  const scanRoot = options.artifact || options.root;
  const scanLabel = options.artifact && options.artifact !== options.root ? '导出产物' : '发布根目录';
  const inventory = walk(scanRoot, { excludes: options.excludes });

  const checks = [];
  checkRequiredDocs(options.root, checks);
  checkLicense(options.root, checks);
  checkThirdPartyNotices(options.root, inventory, checks);
  checkForbiddenArtifacts(scanRoot, scanLabel, inventory, checks);
  checkSecrets(scanRoot, inventory, checks);
  checkAddresses(scanRoot, scanLabel, inventory, checks);
  checkMigrationLedger(options.root, options.ledger, checks);
  checkContracts(options.root, checks);
  checkReleaseChecklist(options.root, checks);
  checkImageDigests(options.root, inventory, checks);

  const report = {
    generatedAt: new Date().toISOString(),
    root: options.root,
    artifact: scanRoot,
    excludes: options.excludes,
    checks,
    summary: summarize(checks)
  };

  if (options.json) printJson(report);
  else printHuman(report);
  return report.summary.block === 0 ? 0 : 1;
}

try {
  process.exitCode = main();
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`错误：${error.message}\n\n${USAGE}`);
    process.exitCode = 2;
  } else {
    console.error(`未预期错误：${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
  }
}