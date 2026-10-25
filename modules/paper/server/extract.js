'use strict';
// 零依赖文本提取。
//
// 范围（最小闭环，超出即越界）：
//  - 纯文本：UTF-8 解码 + 二进制/空内容检查；
//  - 简单 PDF：只读「文本层」。解析间接对象、FlateDecode 内容流、页面树，
//    识别 Tj / TJ / ' / " 与 Td/TD/T*/Tm 换行；不做 OCR，不引第三方。
//
// 明确不支持（遇到就让调用方返回 422 paper.extract_failed，绝不伪造正文）：
//  - 加密 PDF、扫描件（无文本层）、对象流压缩（ObjStm）交叉引用、
//    LZW/ASCII85 等内容流滤镜、CID/Identity-H 字体的真实字形映射。

const zlib = require('node:zlib');

class ExtractError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExtractError';
  }
}

// ---------------------------------------------------------------------------
// 纯文本
// ---------------------------------------------------------------------------

function extractText(buffer) {
  const raw = buffer.toString('utf8').replace(/^\uFEFF/, '');
  if (raw.includes('\u0000')) throw new ExtractError('纯文本包含二进制空字节，无法作为论文正文');
  const replacement = (raw.match(/\uFFFD/g) || []).length;
  if (replacement > Math.max(1, Math.floor(raw.length * 0.01))) {
    throw new ExtractError('文件不是有效的 UTF-8 纯文本');
  }
  const text = raw.trim();
  if (!text) throw new ExtractError('文本内容为空');
  return [{ page: 1, text }];
}

// ---------------------------------------------------------------------------
// PDF：对象与内容流
// ---------------------------------------------------------------------------

const MAX_INFLATE_BYTES = 64 * 1024 * 1024;

function inflateBytes(bytes) {
  // 限制解压后大小，避免恶意/损坏 PDF 的压缩流造成内存膨胀。
  try {
    return zlib.inflateSync(bytes, { maxOutputLength: MAX_INFLATE_BYTES });
  } catch {
    try {
      return zlib.inflateRawSync(bytes, { maxOutputLength: MAX_INFLATE_BYTES });
    } catch {
      return null;
    }
  }
}

function decodeStreamBody(dict, data) {
  const bytes = Buffer.from(data, 'latin1');
  if (/\/FlateDecode\b/.test(dict)) {
    const inflated = inflateBytes(bytes);
    return inflated ? inflated.toString('latin1') : null;
  }
  // 其他滤镜（LZW/ASCII85/ASCIIHex/JPX…）不支持，返回 null 由上层视为「无文本」。
  if (/\/Filter\b/.test(dict)) return null;
  return bytes.toString('latin1');
}

function objectStreamData(body) {
  const keyword = body.indexOf('stream');
  if (keyword === -1) return null;
  const dict = body.slice(0, keyword);
  let start = keyword + 'stream'.length;
  // stream 关键字之后必须紧跟 CRLF 或 LF
  if (body[start] === '\r') start += 1;
  if (body[start] === '\n') start += 1;
  const end = body.indexOf('endstream', start);
  if (end === -1) return null;
  let data = body.slice(start, end);
  data = data.replace(/\r?\n$/, '');
  return { dict, data };
}

function parseObjects(raw) {
  const objects = new Map();
  const header = /(\d+)\s+(\d+)\s+obj\b/g;
  let match = header.exec(raw);
  while (match) {
    const num = Number(match[1]);
    const bodyStart = match.index + match[0].length;
    const end = raw.indexOf('endobj', bodyStart);
    if (end === -1) break;
    const body = raw.slice(bodyStart, end);
    if (!objects.has(num)) objects.set(num, { num, body });
    // 跳过整个对象（含二进制流），避免把流里的假 "N 0 obj" 当对象头。
    header.lastIndex = end + 'endobj'.length;
    match = header.exec(raw);
  }
  return objects;
}

function refsOf(text) {
  const refs = [];
  const re = /(\d+)\s+(\d+)\s+R\b/g;
  let match = re.exec(text);
  while (match) {
    refs.push(Number(match[1]));
    match = re.exec(text);
  }
  return refs;
}

function collectKids(num, objects, out, depth) {
  if (depth > 32) return;
  const object = objects.get(num);
  if (!object) return;
  const isPages = /\/Type\s*\/Pages\b/.test(object.body);
  const isPage = /\/Type\s*\/Page(?![s])/.test(object.body);
  if (isPages) {
    const kids = /\/Kids\s*\[([\s\S]*?)\]/.exec(object.body);
    if (kids) {
      for (const ref of refsOf(kids[1])) collectKids(ref, objects, out, depth + 1);
    }
    return;
  }
  if (isPage) out.push(num);
}

function pageNumbersInOrder(objects) {
  for (const object of objects.values()) {
    if (/\/Type\s*\/Pages\b/.test(object.body) && !/\/Parent\b/.test(object.body)) {
      const out = [];
      collectKids(object.num, objects, out, 0);
      if (out.length) return out;
    }
  }
  const pages = [...objects.values()].filter((object) => /\/Type\s*\/Page(?![s])/.test(object.body));
  pages.sort((a, b) => a.num - b.num);
  return pages.map((object) => object.num);
}

function contentRefsOf(body) {
  const single = /\/Contents\s+(\d+)\s+\d+\s+R\b/.exec(body);
  if (single) return [Number(single[1])];
  const array = /\/Contents\s*\[([\s\S]*?)\]/.exec(body);
  if (array) return refsOf(array[1]);
  return [];
}

// ---------------------------------------------------------------------------
// PDF：内容流文本操作符
// ---------------------------------------------------------------------------

function bytesToText(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return out;
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return Buffer.from(bytes.slice(2)).toString('utf16le');
  }
  return Buffer.from(bytes).toString('latin1');
}

function decodeHex(text) {
  const hex = text.replace(/[^0-9A-Fa-f]/g, '');
  const bytes = [];
  for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
  if (hex.length % 2 === 1) bytes.push(parseInt(hex.slice(-1) + '0', 16));
  return bytesToText(bytes);
}

// 读取 (...) 字面量字符串，处理转义、八进制、嵌套括号与换行。
function readLiteral(source, start) {
  const bytes = [];
  let i = start + 1;
  let depth = 1;
  while (i < source.length) {
    const char = source[i];
    if (char === '\\') {
      const next = source[i + 1];
      if (next === undefined) { i += 1; break; }
      if (next === 'n') { bytes.push(10); i += 2; continue; }
      if (next === 'r') { bytes.push(13); i += 2; continue; }
      if (next === 't') { bytes.push(9); i += 2; continue; }
      if (next === 'b') { bytes.push(8); i += 2; continue; }
      if (next === 'f') { bytes.push(12); i += 2; continue; }
      if (next === '(' || next === ')' || next === '\\') { bytes.push(next.charCodeAt(0) & 0xff); i += 2; continue; }
      if (next === '\r') { i += 2; if (source[i] === '\n') i += 1; continue; }
      if (next === '\n') { i += 2; continue; }
      if (/[0-7]/.test(next)) {
        let oct = '';
        let cursor = i + 1;
        while (cursor < source.length && oct.length < 3 && /[0-7]/.test(source[cursor])) {
          oct += source[cursor];
          cursor += 1;
        }
        bytes.push(parseInt(oct, 8) & 0xff);
        i = cursor;
        continue;
      }
      bytes.push(next.charCodeAt(0) & 0xff);
      i += 2;
      continue;
    }
    if (char === '(') { depth += 1; bytes.push(40); i += 1; continue; }
    if (char === ')') {
      depth -= 1;
      if (depth === 0) { i += 1; break; }
      bytes.push(41);
      i += 1;
      continue;
    }
    if (char === '\r') {
      if (source[i + 1] === '\n') i += 2;
      else i += 1;
      bytes.push(10);
      continue;
    }
    if (char === '\n') { bytes.push(10); i += 1; continue; }
    bytes.push(char.charCodeAt(0) & 0xff);
    i += 1;
  }
  return { text: bytesToText(bytes), next: i };
}

const DELIMITER = /[\s()<>\[\]{}/%]/;

function tokenizeContent(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (char === '%') {
      while (i < source.length && source[i] !== '\n' && source[i] !== '\r') i += 1;
      continue;
    }
    if (/\s/.test(char)) { i += 1; continue; }
    if (char === '(') {
      const literal = readLiteral(source, i);
      tokens.push({ type: 'string', text: literal.text });
      i = literal.next;
      continue;
    }
    if (char === '<') {
      if (source[i + 1] === '<') { i += 2; continue; }
      const end = source.indexOf('>', i + 1);
      if (end === -1) break;
      tokens.push({ type: 'string', text: decodeHex(source.slice(i + 1, end)) });
      i = end + 1;
      continue;
    }
    if (char === '>') { i += 1; continue; }
    if (char === '[') { tokens.push({ type: '[' }); i += 1; continue; }
    if (char === ']') { tokens.push({ type: ']' }); i += 1; continue; }
    if (char === '/') {
      let cursor = i + 1;
      while (cursor < source.length && !DELIMITER.test(source[cursor])) cursor += 1;
      tokens.push({ type: 'name', value: source.slice(i + 1, cursor) });
      i = cursor;
      continue;
    }
    if (char === '+' || char === '-' || char === '.' || (char >= '0' && char <= '9')) {
      let cursor = i + 1;
      while (cursor < source.length && /[0-9.+\-eE]/.test(source[cursor])) cursor += 1;
      const value = Number(source.slice(i, cursor));
      tokens.push({ type: 'number', value: Number.isFinite(value) ? value : 0 });
      i = cursor;
      continue;
    }
    let cursor = i;
    while (cursor < source.length && !DELIMITER.test(source[cursor])) cursor += 1;
    if (cursor === i) { i += 1; continue; }
    tokens.push({ type: 'op', value: source.slice(i, cursor) });
    i = cursor;
  }
  return tokens;
}

function lastString(operands) {
  for (let i = operands.length - 1; i >= 0; i -= 1) {
    if (operands[i] && operands[i].type === 'string') return operands[i];
  }
  return null;
}

function lastArray(operands) {
  for (let i = operands.length - 1; i >= 0; i -= 1) {
    if (operands[i] && operands[i].type === 'array') return operands[i];
  }
  return null;
}

function extractContentText(content) {
  const tokens = tokenizeContent(content);
  let inText = false;
  let out = '';
  let array = null;
  let operands = [];

  const append = (value) => { out += value; };
  const newline = () => { if (out && !out.endsWith('\n')) out += '\n'; };

  for (const token of tokens) {
    if (token.type === 'op') {
      const op = token.value;
      if (op === 'BT') { inText = true; operands = []; array = null; continue; }
      if (op === 'ET') { if (inText) newline(); inText = false; operands = []; array = null; continue; }
      if (!inText) { operands = []; array = null; continue; }
      if (op === 'Tj' || op === "'" || op === '"') {
        const value = lastString(operands);
        if (op !== 'Tj') newline();
        if (value) append(value.text);
        newline();
        operands = [];
        continue;
      }
      if (op === 'TJ') {
        const value = lastArray(operands);
        if (value) {
          for (const item of value.items) {
            if (item.type === 'string') append(item.text);
            // 大负值字距通常代表词间空格
            else if (item.type === 'number' && item.value <= -100) append(' ');
          }
          newline();
        }
        operands = [];
        continue;
      }
      if (op === 'Td' || op === 'TD' || op === 'T*' || op === 'Tm') { newline(); operands = []; continue; }
      operands = [];
      continue;
    }
    if (token.type === '[') { array = []; continue; }
    if (token.type === ']') {
      if (array) { operands.push({ type: 'array', items: array }); array = null; }
      continue;
    }
    if (array) array.push(token);
    else operands.push(token);
  }
  return out;
}

// ---------------------------------------------------------------------------
// PDF 入口
// ---------------------------------------------------------------------------

/**
 * @param {Buffer} buffer
 * @returns {{page:number,text:string}[]}
 * @throws {ExtractError} 无文本层 / 加密 / 非法 PDF
 */
function extractPdf(buffer) {
  if (buffer.length < 8) throw new ExtractError('PDF 文件过小，不是合法 PDF');
  const head = buffer.slice(0, 1024).toString('latin1');
  if (head.indexOf('%PDF-') === -1) throw new ExtractError('不是合法的 PDF 文件（缺少 %PDF- 文件头）');

  const raw = buffer.toString('latin1');
  if (/\/Encrypt\s*(?:<<|\d+\s+\d+\s+R)/.test(raw)) {
    throw new ExtractError('PDF 已加密，无法读取文本层');
  }

  const objects = parseObjects(raw);
  if (objects.size === 0) throw new ExtractError('PDF 结构无法解析：未找到任何间接对象');

  const pages = [];
  const order = pageNumbersInOrder(objects);
  order.forEach((pageNum, index) => {
    const page = objects.get(pageNum);
    if (!page) return;
    const chunks = [];
    for (const ref of contentRefsOf(page.body)) {
      const contentObject = objects.get(ref);
      if (!contentObject) continue;
      const stream = objectStreamData(contentObject.body);
      if (!stream) continue;
      const decoded = decodeStreamBody(stream.dict, stream.data);
      if (decoded) chunks.push(decoded);
    }
    if (!chunks.length) return;
    const text = extractContentText(chunks.join('\n')).replace(/[ \t]+\n/g, '\n').trim();
    if (text) pages.push({ page: index + 1, text });
  });

  // 页面树不可用（或页面没有 /Contents）时，退化为按对象号扫描所有内容流。
  if (!pages.length) {
    const streams = [...objects.values()].sort((a, b) => a.num - b.num);
    let page = 1;
    for (const object of streams) {
      const stream = objectStreamData(object.body);
      if (!stream) continue;
      const decoded = decodeStreamBody(stream.dict, stream.data);
      if (!decoded) continue;
      const text = extractContentText(decoded).replace(/[ \t]+\n/g, '\n').trim();
      if (text) {
        pages.push({ page, text });
        page += 1;
      }
    }
  }

  if (!pages.length) {
    throw new ExtractError('未能从 PDF 文本层提取到文字（可能是扫描件，或使用了不支持的字体/压缩方式）');
  }
  return pages;
}

module.exports = { ExtractError, extractPdf, extractText };
