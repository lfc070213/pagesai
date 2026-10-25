'use strict';
// 测试辅助：直接调用路由 handler（构造 fake ctx），不启动 HTTP。
// 每个 boot() 使用独立临时目录，测试结束后删除。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const paper = require('../server/index.js');

const silentLogger = { info() {}, warn() {}, error() {} };
const DEFAULT_USER = { id: 'user-a', username: 'user-a', role: 'user' };

function findRoute(method, routePath) {
  const route = paper.routes.find((item) => item.method === method && item.path === routePath);
  if (!route) throw new Error(`找不到路由 ${method} ${routePath}`);
  return route;
}

async function startPaper(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagesai-paper-test-'));
  const config = Object.assign(
    { dataFile: path.join(dir, 'paper.json'), uploadsDir: path.join(dir, 'uploads') },
    overrides.config || {}
  );
  await paper.start({ config, logger: overrides.logger || silentLogger });

  async function call(method, routePath, options = {}) {
    const route = findRoute(method, routePath);
    const actualPath = options.path || routePath;
    const url = new URL(actualPath, 'http://localhost');
    const ctx = {
      req: {},
      res: {},
      url,
      params: options.params || {},
      query: options.query || Object.fromEntries(url.searchParams.entries()),
      body: options.body || {},
      user: options.user === undefined ? DEFAULT_USER : options.user
    };
    return route.handler(ctx);
  }

  async function restart() {
    await paper.start({ config, logger: silentLogger });
  }

  async function close() {
    await paper.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  return { call, close, restart, dir, config };
}

async function uploadText(call, text, options = {}) {
  return call('POST', '/api/paper/docs', {
    user: options.user,
    body: {
      filename: options.filename || 'paper.txt',
      contentBase64: Buffer.from(text, 'utf8').toString('base64')
    }
  });
}

async function uploadBuffer(call, buffer, filename, options = {}) {
  return call('POST', '/api/paper/docs', {
    user: options.user,
    body: { filename, contentBase64: buffer.toString('base64') }
  });
}

// 内容流：既接受完整的 PDF 操作符串，也接受一句纯文本（自动包成 BT…Tj…ET）。
function toContent(text) {
  const value = String(text);
  if (/\bBT\b/.test(value) || /\bTj\b/.test(value) || /\bTJ\b/.test(value)) return value;
  const escaped = value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  return `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
}

// 生成一个只含文本层的最小 PDF（可选 Flate 压缩内容流）。
// 结构：1 Catalog / 2 Pages / 3.. Page & Contents / 最后 Font。
function buildPdf(content, options = {}) {
  const compress = options.compress !== false;
  const pages = (Array.isArray(content) ? content : [content])
    .map((item) => (options.wrapText === false ? String(item) : toContent(item)));
  const objects = [];
  objects.push({ num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' });
  const kids = pages.map((_, index) => `${3 + index * 2} 0 R`).join(' ');
  objects.push({ num: 2, body: `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>` });

  const fontNum = 3 + pages.length * 2;
  pages.forEach((text, index) => {
    const pageNum = 3 + index * 2;
    const contentNum = pageNum + 1;
    objects.push({
      num: pageNum,
      body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNum} 0 R >>`
    });
    const raw = Buffer.from(text, 'latin1');
    const stream = compress ? zlib.deflateSync(raw) : raw;
    objects.push({
      num: contentNum,
      stream,
      dict: `<< /Length ${stream.length}${compress ? ' /Filter /FlateDecode' : ''} >>`
    });
  });
  objects.push({ num: fontNum, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' });
  objects.sort((a, b) => a.num - b.num);

  const chunks = [];
  const offsets = {};
  let offset = 0;
  const push = (buffer) => { chunks.push(buffer); offset += buffer.length; };
  push(Buffer.from('%PDF-1.4\n', 'latin1'));
  for (const object of objects) {
    offsets[object.num] = offset;
    push(Buffer.from(`${object.num} 0 obj\n`, 'latin1'));
    if (object.stream) {
      push(Buffer.from(`${object.dict}\nstream\n`, 'latin1'));
      push(object.stream);
      push(Buffer.from('\nendstream\nendobj\n', 'latin1'));
    } else {
      push(Buffer.from(`${object.body}\nendobj\n`, 'latin1'));
    }
  }
  const xrefOffset = offset;
  push(Buffer.from(`xref\n0 ${fontNum + 1}\n0000000000 65535 f \n`, 'latin1'));
  for (let num = 1; num <= fontNum; num += 1) {
    push(Buffer.from(`${String(offsets[num] || 0).padStart(10, '0')} 00000 n \n`, 'latin1'));
  }
  push(Buffer.from(`trailer\n<< /Size ${fontNum + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(chunks);
}

function countFiles(dir) {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) count += countFiles(path.join(dir, entry.name));
    else count += 1;
  }
  return count;
}

module.exports = {
  DEFAULT_USER,
  buildPdf,
  countFiles,
  paper,
  startPaper,
  uploadBuffer,
  uploadText
};
