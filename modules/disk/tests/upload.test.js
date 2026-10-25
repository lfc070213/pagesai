'use strict';
// 上传与下载核心链路：分块 init/chunks/complete、Range 内容一致、幂等、修订冲突、配额、持久化。

const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  assert,
  api,
  base64,
  boot,
  call,
  createFile,
  expectError,
  nextOperationId,
  shutdown,
  uploadFile,
  USER_A
} = require('./helpers');

function sha256Hex(text) {
  return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

test('分块上传后全文与 Range 下载内容一致', async () => {
  await boot();
  const file = await createFile(USER_A, { name: 'hello.txt', chunks: ['hello ', 'world'], size: 11 });
  assert.equal(file.size, 11);
  assert.equal(file.revision, 1);
  assert.equal(file.status, 'active');
  assert.match(file.contentHash, /^sha256:[0-9a-f]{64}$/);

  const full = await api('content', { params: { fileId: file.fileId }, user: USER_A });
  assert.equal(full.status, 200);
  assert.ok(Buffer.isBuffer(full.body));
  assert.equal(full.body.toString('utf8'), 'hello world');
  assert.equal(full.headers['content-length'], '11');
  assert.equal(full.headers['accept-ranges'], 'bytes');

  const first = await api('content', {
    params: { fileId: file.fileId },
    user: USER_A,
    headers: { range: 'bytes=0-4' }
  });
  assert.equal(first.status, 206);
  assert.equal(first.body.toString('utf8'), 'hello');
  assert.equal(first.headers['content-range'], 'bytes 0-4/11');
  assert.equal(first.headers['content-length'], '5');

  const tail = await api('content', {
    params: { fileId: file.fileId },
    user: USER_A,
    headers: { range: 'bytes=6-' }
  });
  assert.equal(tail.status, 206);
  assert.equal(tail.body.toString('utf8'), 'world');

  const suffix = await api('content', {
    params: { fileId: file.fileId },
    user: USER_A,
    headers: { range: 'bytes=-5' }
  });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.body.toString('utf8'), 'world');

  const clamped = await api('content', {
    params: { fileId: file.fileId },
    user: USER_A,
    headers: { range: 'bytes=6-999' }
  });
  assert.equal(clamped.status, 206);
  assert.equal(clamped.body.toString('utf8'), 'world');
  assert.equal(clamped.headers['content-range'], 'bytes 6-10/11');

  const invalid = await api('content', {
    params: { fileId: file.fileId },
    user: USER_A,
    headers: { range: 'bytes=100-200' }
  });
  expectError(invalid, 416, 'RANGE_NOT_SATISFIABLE');
  assert.equal(invalid.headers['content-range'], 'bytes */11');

  const multi = await api('content', {
    params: { fileId: file.fileId },
    user: USER_A,
    headers: { range: 'bytes=0-1,3-4' }
  });
  expectError(multi, 416, 'RANGE_NOT_SATISFIABLE');
  await shutdown();
});

test('空文件可提交，Range 对空文件返回 416', async () => {
  await boot();
  const init = await api('init', { user: USER_A, body: { name: 'empty.txt', totalChunks: 0, size: 0 } });
  assert.equal(init.status, 201);
  const complete = await api('complete', {
    user: USER_A,
    params: { uploadId: init.body.uploadId },
    body: { operationId: nextOperationId('empty') }
  });
  assert.equal(complete.status, 201, JSON.stringify(complete.body));
  assert.equal(complete.body.file.size, 0);

  const full = await api('content', { params: { fileId: complete.body.file.fileId }, user: USER_A });
  assert.equal(full.status, 200);
  assert.equal(full.body.length, 0);

  const range = await api('content', {
    params: { fileId: complete.body.file.fileId },
    user: USER_A,
    headers: { range: 'bytes=0-0' }
  });
  expectError(range, 416, 'RANGE_NOT_SATISFIABLE');
  await shutdown();
});

test('重复 complete 幂等：不产生第二份文件，不重复递增修订', async () => {
  await boot();
  const result = await uploadFile(USER_A, { chunks: ['idempotent'] });
  assert.equal(result.complete.status, 201);
  const file = result.complete.body.file;

  const again = await api('complete', {
    user: USER_A,
    params: { uploadId: result.uploadId },
    body: { operationId: nextOperationId('again') }
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.idempotent, true);
  assert.equal(again.body.file.fileId, file.fileId);
  assert.equal(again.body.file.revision, file.revision);
  assert.equal(again.body.file.size, file.size);

  const sameOperation = await api('complete', {
    user: USER_A,
    params: { uploadId: result.uploadId },
    body: { operationId: result.complete.body.operationId }
  });
  assert.equal(sameOperation.status, 200);
  assert.equal(sameOperation.body.idempotent, true);
  assert.equal(sameOperation.body.file.fileId, file.fileId);

  const list = await api('list', { user: USER_A });
  assert.equal(list.body.files.length, 1);
  assert.equal(list.body.files[0].fileId, file.fileId);

  const lateChunk = await api('chunk', {
    user: USER_A,
    params: { uploadId: result.uploadId, index: '0' },
    body: { data: base64('late') }
  });
  expectError(lateChunk, 409, 'UPLOAD_COMPLETED');
  await shutdown();
});

test('同一 operationId 不能用于提交两个不同上传任务', async () => {
  await boot();
  const first = await uploadFile(USER_A, { chunks: ['one'], operationId: 'shared-operation-id' });
  assert.equal(first.complete.status, 201);

  const second = await api('init', { user: USER_A, body: { name: 'two.txt', totalChunks: 1 } });
  assert.equal(second.status, 201);
  await api('chunk', {
    user: USER_A,
    params: { uploadId: second.body.uploadId, index: '0' },
    body: { data: base64('two') }
  });
  const conflict = await api('complete', {
    user: USER_A,
    params: { uploadId: second.body.uploadId },
    body: { operationId: 'shared-operation-id' }
  });
  expectError(conflict, 409, 'OPERATION_CONFLICT');

  const list = await api('list', { user: USER_A });
  assert.equal(list.body.files.length, 1, '冲突提交不得产生第二份文件');

  const ok = await api('complete', {
    user: USER_A,
    params: { uploadId: second.body.uploadId },
    body: { operationId: nextOperationId('second') }
  });
  assert.equal(ok.status, 201);
  await shutdown();
});

test('修订冲突：上传期间文件被更新，complete 返回 409 且不覆盖新内容', async () => {
  await boot();
  const file = await createFile(USER_A, { chunks: ['v1'] });
  assert.equal(file.revision, 1);

  // 两个上传任务都基于 revision 1，先后提交；后提交者必须冲突。
  const initA = await api('init', {
    user: USER_A,
    body: { name: 'hello.txt', fileId: file.fileId, baseRevision: 1, totalChunks: 1 }
  });
  assert.equal(initA.status, 201);
  await api('chunk', {
    user: USER_A,
    params: { uploadId: initA.body.uploadId, index: '0' },
    body: { data: base64('stale') }
  });

  const initB = await api('init', {
    user: USER_A,
    body: { name: 'hello.txt', fileId: file.fileId, baseRevision: 1, totalChunks: 1 }
  });
  assert.equal(initB.status, 201);
  await api('chunk', {
    user: USER_A,
    params: { uploadId: initB.body.uploadId, index: '0' },
    body: { data: base64('fresh') }
  });

  const winner = await api('complete', {
    user: USER_A,
    params: { uploadId: initB.body.uploadId },
    body: { operationId: nextOperationId('winner') }
  });
  assert.equal(winner.status, 201, JSON.stringify(winner.body));
  assert.equal(winner.body.file.revision, 2);

  const loser = await api('complete', {
    user: USER_A,
    params: { uploadId: initA.body.uploadId },
    body: { operationId: nextOperationId('loser') }
  });
  expectError(loser, 409, 'REVISION_CONFLICT');

  const content = await api('content', { params: { fileId: file.fileId }, user: USER_A });
  assert.equal(content.body.toString('utf8'), 'fresh');

  const staleInit = await api('init', {
    user: USER_A,
    body: { name: 'hello.txt', fileId: file.fileId, baseRevision: 1, totalChunks: 1 }
  });
  expectError(staleInit, 409, 'REVISION_CONFLICT');

  const current = await api('file', { user: USER_A, params: { fileId: file.fileId } });
  assert.equal(current.body.file.revision, 2);

  // 同一个任务仍停留在 open，但它的 baseRevision 已过期，重新提交仍必须 409；
  // 客户端应以当前 revision 重新 init 一个上传任务。
  const retry = await api('complete', {
    user: USER_A,
    params: { uploadId: initA.body.uploadId },
    body: { operationId: nextOperationId('retry') }
  });
  expectError(retry, 409, 'REVISION_CONFLICT');
  await shutdown();
});

test('complete 携带的 baseRevision 与上传任务不一致时返回 409', async () => {
  await boot();
  const file = await createFile(USER_A, { chunks: ['base'] });
  const init = await api('init', {
    user: USER_A,
    body: { name: 'base.txt', fileId: file.fileId, baseRevision: file.revision, totalChunks: 1 }
  });
  assert.equal(init.status, 201);
  await api('chunk', {
    user: USER_A,
    params: { uploadId: init.body.uploadId, index: '0' },
    body: { data: base64('next') }
  });

  const mismatch = await api('complete', {
    user: USER_A,
    params: { uploadId: init.body.uploadId },
    body: { operationId: nextOperationId('mismatch'), baseRevision: 99 }
  });
  expectError(mismatch, 409, 'REVISION_CONFLICT');

  const ok = await api('complete', {
    user: USER_A,
    params: { uploadId: init.body.uploadId },
    body: { operationId: nextOperationId('ok'), baseRevision: file.revision }
  });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.file.revision, file.revision + 1);
  await shutdown();
});

test('配额：声明大小/实际提交超限均返回 413，边界值可用', async () => {
  await boot({ quotaBytes: 10 });
  const declared = await api('init', { user: USER_A, body: { name: 'big.bin', size: 11, totalChunks: 1 } });
  expectError(declared, 413, 'QUOTA_EXCEEDED');

  const init = await api('init', { user: USER_A, body: { name: 'big.bin', totalChunks: 1 } });
  assert.equal(init.status, 201);
  const chunk = await api('chunk', {
    user: USER_A,
    params: { uploadId: init.body.uploadId, index: '0' },
    body: { data: base64('01234567890') }
  });
  assert.equal(chunk.status, 200);
  const tooBig = await api('complete', {
    user: USER_A,
    params: { uploadId: init.body.uploadId },
    body: { operationId: nextOperationId('too-big') }
  });
  expectError(tooBig, 413, 'QUOTA_EXCEEDED');

  const list = await api('list', { user: USER_A });
  assert.equal(list.body.files.length, 0);
  assert.equal(list.body.quota.usedBytes, 0);

  const exact = await createFile(USER_A, { name: 'exact.bin', chunks: ['0123456789'], size: 10 });
  assert.equal(exact.size, 10);
  const quota = await api('quota', { user: USER_A });
  assert.equal(quota.body.usedBytes, 10);
  assert.equal(quota.body.quotaBytes, 10);
  assert.equal(quota.body.remainingBytes, 0);

  const over = await api('init', { user: USER_A, body: { name: 'one.bin', size: 1, totalChunks: 1 } });
  expectError(over, 413, 'QUOTA_EXCEEDED');

  // 软删文件仍保留逻辑字节（可恢复），所以删除不会瞬间释放配额。
  const removed = await api('remove', {
    user: USER_A,
    params: { fileId: exact.fileId },
    body: { operationId: nextOperationId('delete') }
  });
  assert.equal(removed.status, 200);
  const afterDelete = await api('quota', { user: USER_A });
  assert.equal(afterDelete.body.usedBytes, 10);
  await shutdown();
});

test('单文件上限 maxFileBytes 返回 413 FILE_TOO_LARGE', async () => {
  await boot({ quotaBytes: 100, maxFileBytes: 5 });
  const declared = await api('init', { user: USER_A, body: { name: 'six.bin', size: 6, totalChunks: 1 } });
  expectError(declared, 413, 'FILE_TOO_LARGE');

  const init = await api('init', { user: USER_A, body: { name: 'six.bin', totalChunks: 1 } });
  await api('chunk', {
    user: USER_A,
    params: { uploadId: init.body.uploadId, index: '0' },
    body: { data: base64('123456') }
  });
  const complete = await api('complete', {
    user: USER_A,
    params: { uploadId: init.body.uploadId },
    body: { operationId: nextOperationId('too-large') }
  });
  expectError(complete, 413, 'FILE_TOO_LARGE');
  await shutdown();
});

test('分块重试幂等、sha256 校验、缺块与大小不符均被拒绝', async () => {
  await boot();
  const init = await api('init', { user: USER_A, body: { name: 'chunks.txt', totalChunks: 2 } });
  assert.equal(init.status, 201);
  const uploadId = init.body.uploadId;

  const badHash = await api('chunk', {
    user: USER_A,
    params: { uploadId, index: '0' },
    body: { data: base64('aa'), sha256: `sha256:${sha256Hex('bb')}` }
  });
  expectError(badHash, 400, 'CHUNK_HASH_MISMATCH');

  const first = await api('chunk', {
    user: USER_A,
    params: { uploadId, index: '0' },
    body: { data: base64('aa') }
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.receivedChunks, 1);

  // 同序号重试覆盖旧分块，不产生第二份数据。
  const retried = await api('chunk', {
    user: USER_A,
    params: { uploadId, index: '0' },
    body: { data: base64('cc') }
  });
  assert.equal(retried.status, 200);
  assert.equal(retried.body.receivedChunks, 1);

  const missing = await api('complete', {
    user: USER_A,
    params: { uploadId },
    body: { operationId: nextOperationId('missing') }
  });
  expectError(missing, 400, 'MISSING_CHUNKS');

  const second = await api('chunk', {
    user: USER_A,
    params: { uploadId, index: '1' },
    body: { data: base64('dd') }
  });
  assert.equal(second.status, 200);

  const status = await api('upload', { user: USER_A, params: { uploadId } });
  assert.equal(status.status, 200);
  assert.equal(status.body.upload.receivedChunks, 2);
  assert.equal(status.body.upload.status, 'open');

  const complete = await api('complete', {
    user: USER_A,
    params: { uploadId },
    body: { operationId: nextOperationId('chunks') }
  });
  assert.equal(complete.status, 201, JSON.stringify(complete.body));
  const content = await api('content', { params: { fileId: complete.body.file.fileId }, user: USER_A });
  assert.equal(content.body.toString('utf8'), 'ccdd');

  const sizeInit = await api('init', { user: USER_A, body: { name: 'size.txt', size: 10, totalChunks: 1 } });
  await api('chunk', {
    user: USER_A,
    params: { uploadId: sizeInit.body.uploadId, index: '0' },
    body: { data: base64('abc') }
  });
  const sizeMismatch = await api('complete', {
    user: USER_A,
    params: { uploadId: sizeInit.body.uploadId },
    body: { operationId: nextOperationId('size') }
  });
  expectError(sizeMismatch, 400, 'SIZE_MISMATCH');
  await shutdown();
});

test('单分块上限与分块序号越界返回明确错误', async () => {
  await boot({ chunkSizeBytes: 4, maxChunkBytes: 4 });
  const init = await api('init', { user: USER_A, body: { name: 'chunk.bin', totalChunks: 1 } });
  const tooLarge = await api('chunk', {
    user: USER_A,
    params: { uploadId: init.body.uploadId, index: '0' },
    body: { data: base64('12345') }
  });
  expectError(tooLarge, 413, 'CHUNK_TOO_LARGE');

  const outOfRange = await api('chunk', {
    user: USER_A,
    params: { uploadId: init.body.uploadId, index: '1' },
    body: { data: base64('123') }
  });
  expectError(outOfRange, 400, 'INVALID_INPUT');
  await shutdown();
});

test('dataFile 持久化：重启后文件与内容仍在，且数据文件权限为 0600', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagesai-disk-test-'));
  const dataFile = path.join(dir, 'disk.json');
  try {
    await boot({ dataFile });
    const file = await createFile(USER_A, { chunks: ['persist'] });
    await shutdown();

    assert.equal(fs.existsSync(dataFile), true);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(dataFile).mode & 0o777, 0o600);
    }

    await boot({ dataFile });
    const content = await api('content', { params: { fileId: file.fileId }, user: USER_A });
    assert.equal(content.status, 200);
    assert.equal(content.body.toString('utf8'), 'persist');
    const list = await api('list', { user: USER_A });
    assert.equal(list.body.files.length, 1);
    assert.equal(list.body.files[0].fileId, file.fileId);
  } finally {
    await shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('兼容路由：POST /chunks 用 body.index，POST /files/:fileId/delete 软删', async () => {
  await boot();
  const init = await api('init', { user: USER_A, body: { name: 'alias.txt', totalChunks: 1 } });
  assert.equal(init.status, 201);

  const chunk = await call('POST', '/api/disk/uploads/:uploadId/chunks', {
    user: USER_A,
    params: { uploadId: init.body.uploadId },
    body: { index: 0, data: base64('alias') }
  });
  assert.equal(chunk.status, 200, JSON.stringify(chunk.body));
  assert.equal(chunk.body.index, 0);

  const complete = await api('complete', {
    user: USER_A,
    params: { uploadId: init.body.uploadId },
    body: { operationId: nextOperationId('alias') }
  });
  assert.equal(complete.status, 201);
  const file = complete.body.file;

  const removed = await call('POST', '/api/disk/files/:fileId/delete', {
    user: USER_A,
    params: { fileId: file.fileId },
    body: { baseRevision: file.revision }
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.file.status, 'deleted');
  await shutdown();
});
