'use strict';
// 提取与切分的单元测试（不经过 HTTP）。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { ExtractError, extractPdf, extractText } = require(path.join(__dirname, '..', 'server', 'extract.js'));
const {
  flattenSegments,
  normalizeText,
  segmentBlocks,
  splitParagraphs,
  splitSentences
} = require(path.join(__dirname, '..', 'server', 'segment.js'));
const { buildPdf } = require('./helpers.js');

test('纯文本提取：去 BOM、拒空内容与二进制空字节', () => {
  const pages = extractText(Buffer.from('\uFEFF第一段。\n\n第二段。', 'utf8'));
  assert.equal(pages.length, 1);
  assert.equal(pages[0].page, 1);
  assert.match(pages[0].text, /第一段/);

  assert.throws(() => extractText(Buffer.from('   \n\t ', 'utf8')), (err) => err instanceof ExtractError);
  assert.throws(() => extractText(Buffer.from([0x61, 0x00, 0x62])), (err) => err instanceof ExtractError);
});

test('PDF 文本层提取：Flate 与非压缩内容流都能还原句子', () => {
  const content = 'BT /F1 12 Tf 72 720 Td (Hello world. This is PDF extraction.) Tj 0 -20 Td [(Second) -200 (line here.)] TJ ET';
  for (const compress of [true, false]) {
    const pages = extractPdf(buildPdf(content, { compress }));
    assert.equal(pages.length, 1);
    const text = pages[0].text.replace(/\s+/g, ' ').trim();
    assert.match(text, /Hello world/);
    assert.match(text, /Second line here/);
  }
});

test('PDF 多页按页面树顺序编号', () => {
  const pages = extractPdf(buildPdf(['First page content.', 'Second page content.']));
  assert.equal(pages.length, 2);
  assert.equal(pages[0].page, 1);
  assert.equal(pages[1].page, 2);
  assert.match(pages[0].text, /First/);
  assert.match(pages[1].text, /Second/);
});

test('PDF 提取失败：无文本层 / 加密 / 非法文件头都抛 ExtractError，不伪造正文', () => {
  assert.throws(() => extractPdf(buildPdf('0 0 100 100 re f', { wrapText: false })), (err) => err instanceof ExtractError);
  assert.throws(
    () => extractPdf(Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Encrypt 2 0 R >>\nendobj\n%%EOF')),
    (err) => err instanceof ExtractError && /加密/.test(err.message)
  );
  assert.throws(() => extractPdf(Buffer.from('this is definitely not a pdf')), (err) => err instanceof ExtractError);
});

test('句子切分保护缩写、小数，并保持确定性', () => {
  const sentences = splitSentences('Mr. Smith wrote Fig. 3 in 2020. Then he left.');
  assert.deepEqual(sentences, ['Mr. Smith wrote Fig. 3 in 2020.', 'Then he left.']);

  const cjk = splitSentences('数值 3.14 不应断句。第二句！');
  assert.deepEqual(cjk, ['数值 3.14 不应断句。', '第二句！']);

  const input = 'One sentence. Two sentence. Three sentence.';
  assert.deepEqual(splitSentences(input), splitSentences(input));
});

test('连字符断行还原、段落拆分与 normalizeText', () => {
  assert.equal(normalizeText('transla-\ntion works'), 'translation works');
  assert.deepEqual(splitParagraphs('第一段。\n\n第二段。\n\n\n第三段。'), ['第一段。', '第二段。', '第三段。']);
  assert.deepEqual(splitParagraphs('没有空行\n只有换行'), ['没有空行\n只有换行']);
});

test('segmentBlocks 生成稳定 sid，flattenSegments 顺序与下标一致', () => {
  const blocks = segmentBlocks([
    { page: 1, text: 'Alpha one. Alpha two.' },
    { page: 2, text: '' },
    { page: 2, text: 'Beta three.' }
  ]);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0].segments.map((item) => item.sid), ['0:0', '0:1']);
  assert.deepEqual(blocks[1].segments.map((item) => item.sid), ['1:0']);
  assert.equal(blocks[1].page, 2);

  const flat = flattenSegments(blocks);
  assert.deepEqual(flat.map((item) => item.sid), ['0:0', '0:1', '1:0']);
  assert.equal(flat[2].blockIndex, 1);
  assert.equal(flat[2].sentenceIndex, 0);

  // 同样的输入必须得到完全相同的 sid 序列（翻译进度恢复依赖这一点）
  const again = flattenSegments(segmentBlocks([
    { page: 1, text: 'Alpha one. Alpha two.' },
    { page: 2, text: 'Beta three.' }
  ]));
  assert.deepEqual(flat.map((item) => item.sid), again.map((item) => item.sid));
});
