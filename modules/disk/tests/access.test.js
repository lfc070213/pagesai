'use strict';
// 授权与生命周期：用户隔离、未认证写 403、软删/恢复、跨用户上传任务、区域过滤。

const test = require('node:test');

const {
  assert,
  api,
  base64,
  boot,
  createFile,
  expectError,
  nextOperationId,
  shutdown,
  USER_A,
  USER_B
} = require('./helpers');

test('跨用户隔离：读取、删除、覆盖、分享与列表均不越权', async () => {
  await boot();
  const file = await createFile(USER_A, { chunks: ['private'] });

  const metadata = await api('file', { user: USER_B, params: { fileId: file.fileId } });
  expectError(metadata, 403, 'FORBIDDEN');

  const content = await api('content', { user: USER_B, params: { fileId: file.fileId } });
  expectError(content, 403, 'FORBIDDEN');

  const removed = await api('remove', { user: USER_B, params: { fileId: file.fileId } });
  expectError(removed, 403, 'FORBIDDEN');

  const overwrite = await api('init', {
    user: USER_B,
    body: { name: 'steal.txt', fileId: file.fileId, baseRevision: file.revision, totalChunks: 1 }
  });
  expectError(overwrite, 403, 'FORBIDDEN');

  const share = await api('createShare', { user: USER_B, params: { fileId: file.fileId }, body: {} });
  expectError(share, 403, 'FORBIDDEN');

  const listB = await api('list', { user: USER_B });
  assert.equal(listB.status, 200);
  assert.equal(listB.body.files.length, 0);
  const quotaB = await api('quota', { user: USER_B });
  assert.equal(quotaB.body.usedBytes, 0);

  const listA = await api('list', { user: USER_A });
  assert.equal(listA.body.files.length, 1);
  assert.equal(listA.body.files[0].fileId, file.fileId);
  const contentA = await api('content', { params: { fileId: file.fileId }, user: USER_A });
  assert.equal(contentA.body.toString('utf8'), 'private');
  await shutdown();
});

test('未认证写操作一律 403，未认证读操作 401', async () => {
  await boot();
  const file = await createFile(USER_A, { chunks: ['auth'] });
  const init = await api('init', { user: USER_A, body: { name: 'pending.txt', totalChunks: 1 } });

  expectError(await api('init', { body: { name: 'anon.txt' } }), 403, 'FORBIDDEN');
  expectError(await api('chunk', {
    params: { uploadId: init.body.uploadId, index: '0' },
    body: { data: base64('x') }
  }), 403, 'FORBIDDEN');
  expectError(await api('complete', {
    params: { uploadId: init.body.uploadId },
    body: { operationId: nextOperationId('anon') }
  }), 403, 'FORBIDDEN');
  expectError(await api('remove', { params: { fileId: file.fileId } }), 403, 'FORBIDDEN');
  expectError(await api('restore', { params: { fileId: file.fileId } }), 403, 'FORBIDDEN');
  expectError(await api('createShare', { params: { fileId: file.fileId }, body: {} }), 403, 'FORBIDDEN');
  expectError(await api('revokeShare', { params: { shareId: `shr_${'0'.repeat(24)}` } }), 403, 'FORBIDDEN');

  expectError(await api('list', {}), 401, 'UNAUTHENTICATED');
  expectError(await api('quota', {}), 401, 'UNAUTHENTICATED');
  expectError(await api('file', { params: { fileId: file.fileId } }), 401, 'UNAUTHENTICATED');
  expectError(await api('content', { params: { fileId: file.fileId } }), 401, 'UNAUTHENTICATED');
  expectError(await api('upload', { params: { uploadId: init.body.uploadId } }), 401, 'UNAUTHENTICATED');
  await shutdown();
});

test('其他用户不能操作他人的上传任务', async () => {
  await boot();
  const init = await api('init', { user: USER_A, body: { name: 'mine.txt', totalChunks: 1 } });
  assert.equal(init.status, 201);
  const uploadId = init.body.uploadId;

  expectError(await api('chunk', {
    user: USER_B,
    params: { uploadId, index: '0' },
    body: { data: base64('x') }
  }), 403, 'FORBIDDEN');
  expectError(await api('upload', { user: USER_B, params: { uploadId } }), 403, 'FORBIDDEN');
  expectError(await api('complete', {
    user: USER_B,
    params: { uploadId },
    body: { operationId: nextOperationId('other') }
  }), 403, 'FORBIDDEN');

  const chunk = await api('chunk', {
    user: USER_A,
    params: { uploadId, index: '0' },
    body: { data: base64('ok') }
  });
  assert.equal(chunk.status, 200);
  const complete = await api('complete', {
    user: USER_A,
    params: { uploadId },
    body: { operationId: nextOperationId('mine') }
  });
  assert.equal(complete.status, 201);
  await shutdown();
});

test('软删除与恢复：修订递增、operationId 幂等、墓碑内容不丢', async () => {
  await boot();
  const file = await createFile(USER_A, { chunks: ['survive'] });
  assert.equal(file.revision, 1);

  const wrongRevision = await api('remove', {
    user: USER_A,
    params: { fileId: file.fileId },
    body: { baseRevision: 99 }
  });
  expectError(wrongRevision, 409, 'REVISION_CONFLICT');

  const deleteOperation = nextOperationId('delete');
  const removed = await api('remove', {
    user: USER_A,
    params: { fileId: file.fileId },
    body: { operationId: deleteOperation, baseRevision: 1 }
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.file.status, 'deleted');
  assert.equal(removed.body.file.revision, 2);
  assert.ok(removed.body.file.deletedAt);

  const repeated = await api('remove', {
    user: USER_A,
    params: { fileId: file.fileId },
    body: { operationId: deleteOperation }
  });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.idempotent, true);

  const again = await api('remove', {
    user: USER_A,
    params: { fileId: file.fileId },
    body: { operationId: nextOperationId('delete-again') }
  });
  expectError(again, 409, 'FILE_ALREADY_DELETED');

  // 软删只改索引状态，内容仍由所有者可取回。
  const stillThere = await api('content', { params: { fileId: file.fileId }, user: USER_A });
  assert.equal(stillThere.status, 200);
  assert.equal(stillThere.body.toString('utf8'), 'survive');

  const hidden = await api('list', { user: USER_A });
  assert.equal(hidden.body.files.length, 0);
  const withDeleted = await api('list', { user: USER_A, query: { includeDeleted: '1' } });
  assert.equal(withDeleted.body.files.length, 1);
  assert.equal(withDeleted.body.files[0].status, 'deleted');

  // 删除状态下不能直接覆盖上传，必须先恢复。
  const overwriteDeleted = await api('init', {
    user: USER_A,
    body: { name: 'survive.txt', fileId: file.fileId, baseRevision: 2, totalChunks: 1 }
  });
  expectError(overwriteDeleted, 409, 'FILE_DELETED');

  const wrongRestore = await api('restore', {
    user: USER_A,
    params: { fileId: file.fileId },
    body: { baseRevision: 1 }
  });
  expectError(wrongRestore, 409, 'REVISION_CONFLICT');

  const restoreOperation = nextOperationId('restore');
  const restored = await api('restore', {
    user: USER_A,
    params: { fileId: file.fileId },
    body: { operationId: restoreOperation, baseRevision: 2 }
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(restored.body.file.status, 'active');
  assert.equal(restored.body.file.revision, 3);
  assert.equal(restored.body.file.deletedAt, null);
  assert.ok(restored.body.file.restoredAt);

  const repeatedRestore = await api('restore', {
    user: USER_A,
    params: { fileId: file.fileId },
    body: { operationId: restoreOperation }
  });
  assert.equal(repeatedRestore.status, 200);
  assert.equal(repeatedRestore.body.idempotent, true);

  const restoreAgain = await api('restore', {
    user: USER_A,
    params: { fileId: file.fileId },
    body: { operationId: nextOperationId('restore-again') }
  });
  expectError(restoreAgain, 409, 'FILE_NOT_DELETED');

  const visible = await api('list', { user: USER_A });
  assert.equal(visible.body.files.length, 1);
  assert.equal(visible.body.files[0].status, 'active');
  const content = await api('content', { params: { fileId: file.fileId }, user: USER_A });
  assert.equal(content.body.toString('utf8'), 'survive');
  await shutdown();
});

test('不存在的文件/上传任务返回 404，未知区域过滤返回 404', async () => {
  await boot();
  expectError(await api('file', { user: USER_A, params: { fileId: `fil_${'0'.repeat(24)}` } }), 404, 'FILE_NOT_FOUND');
  expectError(await api('content', { user: USER_A, params: { fileId: 'not-a-file-id' } }), 404, 'FILE_NOT_FOUND');
  expectError(await api('upload', { user: USER_A, params: { uploadId: `upl_${'0'.repeat(24)}` } }), 404, 'UPLOAD_NOT_FOUND');
  expectError(await api('list', { user: USER_A, query: { region: 'disk.other' } }), 404, 'REGION_NOT_EXPOSED');
  await shutdown();
});
