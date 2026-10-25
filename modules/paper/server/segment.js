'use strict';
// 句子切分（Paper 模块自包含实现，不依赖旧 source/site 代码）。
//
// 为什么必须确定性：句子 ID（sid = `${blockIndex}:${sentenceIndex}`）是
// 「原文/译文逐句对齐」「翻译进度恢复」「问答引用索引」三者的共同主键。
// 同样的输入必须永远切出同样的 sid，否则恢复翻译会把已完成句子再翻一遍，
// 问答引用也会指到别的句子上。
//
// 规则：
//  - 在句末标点（. ! ? 。 ！ ？ ； …）后切分；英文要求标点后为空白或行尾；
//  - 保护常见缩写与编号（Mr. / e.g. / Fig. 3 / et al. / No. 4 / 3.1）；
//  - 过短碎片并回上一句，避免出现 "1." 这种独立句；
//  - 超长句继续按逗号/分号切，保证单次翻译请求可控。

const MIN_SEGMENT_CHARS = 2;
const MAX_SEGMENT_CHARS = 600;
const MAX_SENTENCES_PER_BLOCK = 400;

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'fig', 'figs', 'eq', 'eqs',
  'no', 'nos', 'vol', 'vols', 'ch', 'sec', 'secs', 'pp', 'p', 'al', 'etc', 'vs', 'cf',
  'eg', 'ie', 'approx', 'dept', 'univ', 'inc', 'ltd', 'co', 'corp', 'ed', 'eds',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'i.e', 'e.g', 'u.s', 'u.k', 'a.m', 'p.m'
]);

const CJK_END = new Set(['。', '！', '？', '；', '…']);
const ASCII_END = new Set(['.', '!', '?']);
const CLAUSE_BREAK = new Set([',', '，', ';', '：', ':']);

function normalizeText(value) {
  return String(value == null ? '' : value)
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    // 连字符断行：学术 PDF 常见 "transla-\ntion"，还原成一个词
    .replace(/([A-Za-z])-\n([a-z])/g, '$1$2')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

// 取句点前的一个「词」（保留大小写，供首字母缩写判断使用）
function previousWord(text, index) {
  let i = index - 1;
  let word = '';
  while (i >= 0 && /[A-Za-z.]/.test(text[i])) {
    word = text[i] + word;
    i -= 1;
  }
  return word.replace(/^\.+/, '');
}

function isAbbreviationDot(text, index) {
  const raw = previousWord(text, index);
  if (!raw) return false;
  if (ABBREVIATIONS.has(raw.toLowerCase())) return true;
  // 人名首字母缩写（J. Smith / J. R. R. Tolkien）；小写单字母更可能是变量名，正常断句。
  if (/^[A-Z]$/.test(raw)) return true;
  return false;
}

// 返回切分边界（句末标点之后的下一个字符下标）
function boundaryAfter(text, index) {
  const char = text[index];
  if (CJK_END.has(char)) return index + 1;
  if (!ASCII_END.has(char)) return -1;
  // 小数与版本号：3.14 / v2.0.1 的句点两侧都是数字，绝不能断句
  if (char === '.' && /\d/.test(String(text[index - 1] || '')) && /\d/.test(String(text[index + 1] || ''))) return -1;
  if (isAbbreviationDot(text, index)) return -1;
  // 省略号 ... 归到最后一个点
  if (char === '.' && text[index + 1] === '.') return -1;
  const next = text[index + 1];
  if (next === undefined) return index + 1;
  if (next === '"' || next === "'" || next === '”' || next === '’' || next === ')' || next === '）') {
    return index + 2;
  }
  if (/\s/.test(next)) return index + 1;
  return -1;
}

function splitLongPiece(piece) {
  const text = piece.trim();
  if (text.length <= MAX_SEGMENT_CHARS) return text ? [text] : [];
  const parts = [];
  let rest = text;
  while (rest.length > MAX_SEGMENT_CHARS) {
    let cut = -1;
    for (let i = MAX_SEGMENT_CHARS; i > MAX_SEGMENT_CHARS * 0.5; i -= 1) {
      if (CLAUSE_BREAK.has(rest[i])) { cut = i + 1; break; }
    }
    if (cut === -1) {
      for (let i = MAX_SEGMENT_CHARS; i > MAX_SEGMENT_CHARS * 0.5; i -= 1) {
        if (/\s/.test(rest[i])) { cut = i + 1; break; }
      }
    }
    if (cut === -1) cut = MAX_SEGMENT_CHARS;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

// 把一段文本切成句子数组
function splitSentences(input) {
  const text = normalizeText(input);
  if (!text) return [];
  const pieces = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const end = boundaryAfter(text, i);
    if (end === -1) continue;
    const piece = text.slice(start, end).trim();
    if (piece) pieces.push(piece);
    start = end;
    i = end - 1;
  }
  const tail = text.slice(start).trim();
  if (tail) pieces.push(tail);

  const merged = [];
  for (const piece of pieces) {
    const last = merged[merged.length - 1];
    if (last && piece.replace(/[^\p{L}\p{N}]/gu, '').length < MIN_SEGMENT_CHARS) {
      merged[merged.length - 1] = `${last} ${piece}`.trim();
      continue;
    }
    merged.push(...splitLongPiece(piece));
  }
  return merged.slice(0, MAX_SENTENCES_PER_BLOCK);
}

// 段落拆分：空行分段；没有空行时整段保持为一个 block（PDF 的排版换行由 normalizeText 折叠）。
function splitParagraphs(text) {
  const raw = String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ');
  return raw
    .split(/\n[ \t]*\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * [{page,text}] -> [{index,page,text,segments:[{sid,text}]}]
 * 空段落会被跳过并重新编号，保证 index 与数组下标一致。
 */
function segmentBlocks(blocks) {
  const source = Array.isArray(blocks) ? blocks : [];
  const out = [];
  source.forEach((block) => {
    const text = normalizeText(block && block.text);
    if (!text) return;
    const segments = splitSentences(text).map((sentence) => ({ sid: '', text: sentence }));
    if (!segments.length) return;
    out.push({
      index: out.length,
      page: Number(block && block.page) > 0 ? Number(block.page) : 1,
      text,
      segments
    });
  });
  out.forEach((block, index) => {
    block.index = index;
    block.segments.forEach((segment, sentenceIndex) => {
      segment.sid = `${index}:${sentenceIndex}`;
    });
  });
  return out;
}

// 展平为带位置信息的句子列表（翻译、问答、引用校验共用）。
function flattenSegments(blocks) {
  const list = [];
  for (const block of blocks || []) {
    for (let sentenceIndex = 0; sentenceIndex < (block.segments || []).length; sentenceIndex += 1) {
      const segment = block.segments[sentenceIndex];
      list.push({
        sid: segment.sid,
        text: segment.text,
        blockIndex: block.index,
        sentenceIndex,
        page: block.page
      });
    }
  }
  return list;
}

module.exports = {
  MAX_SEGMENT_CHARS,
  flattenSegments,
  normalizeText,
  segmentBlocks,
  splitParagraphs,
  splitSentences
};
