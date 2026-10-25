'use strict';
// 只读分享：令牌创建、公开读取、Range、过期、撤销、文件删除后的行为。

const test = require('node:test');

const {
  assert,
  api,
  boot,
  createFile,
  expectError,
  nextOperationId,
  shutdown,
  USER_A,
  USER_B
} = require('./helpers');

test('只读分享令牌可公开读取文件并支持 Range，且不会泄露给列表', async () => {
  await boot();
  const file = await createFile(USER_A, { chunks: ['hello ', 'world'] });

  const created = await api('createShare', {
    user: USER_A,
    params: { fileId: file.fileId },
    body: { expiresInSeconds: 3600 }
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const share = created.body.share;
  assert.equal(share.readOnly, true);
  assert.equal(share.fileId, file.fileId);
  assert.match(share.token, /^[A-Za-z0-9_-]{32,}$/);
  assert.match(share.urlPath, /^\/api\/disk\/shares\/.+\/content$/);
  assert.ok(Date.parse(share.expiresAt) > Date.now());

  const metadata = await api('share', { params: { token: share.token } });
  assert.equal(metadata.status, 200);
  assert.equal(metadata.body.file.fileId, file.fileId);
  assert.equal(metadata.body.file.name, 'hello.txt');
  assert.equal(metadata.body.share.readOnly, true);
  assert.equal(metadata.body.share.ownerId, undefined);

  const publicContent = await api('shareContent', { params: { token: share.token } });
  assert.equal(publicContent.status, 200);
  assert.ok(Buffer.isBuffer(publicContent.body));
  assert.equal(publicContent.body.toString('utf8'), 'hello world');

  const publicRange = await api('shareContent', {
    params: { token: share.token },
    headers: { range: 'bytes=0-4' }
  });
  assert.equal(publicRange.status, 206);
  assert.equal(publicRange.body.toString('utf8'), 'hello');
  assert.equal(publicRange.headers['content-range'], 'bytes 0-4/11');

  const viaQuery = await api('content', { params: { fileId: file.fileId }, query: { token: share.token } });
  assert.equal(viaQuery.status, 200);
  assert.equal(viaQuery.body.toString('utf8'), 'hello world');

  const viaHeader = await api('content', {
    params: { fileId: file.fileId },
    headers: { 'x-share-token': share.token }
  });
  assert.equal(viaHeader.status, 200);

  const viaAuthorization = await api('content', {
    params: { fileId: file.fileId },
    headers: { authorization: `Share ${share.token}` }
  });
  assert.equal(viaAuthorization.status, 200);

  // 已认证的其他用户持令牌同样只读可用；无令牌仍然 403。
  const otherWithToken = await api('content', {
    user: USER_B,
    params: { fileId: file.fileId },
    query: { token: share.token }
  });
  assert.equal(otherWithToken.status, 200);
  expectError(await api('content', { user: USER_B, params: { fileId: file.fileId } }), 403, 'FORBIDDEN');

  const listed = await api('listShares', { user: USER_A, params: { fileId: file.fileId } });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.shares.length, 1);
  assert.equal(JSON.stringify(listed.body).includes(share.token), false, '分享列表不得返回明文令牌');
  assert.equal(JSON.stringify(listed.body).includes('tokenHash'), false, '分享列表不得返回令牌哈希');

  expectError(
    await api('listShares', { user: USER_B, params: { fileId: file.fileId } }),
    403,
    'FORBIDDEN'
  );

  const second = await createFile(USER_A, { name: 'second.txt', chunks: ['second'] });
  expectError(
    await api('content', { params: { fileId: second.fileId }, query: { token: share.token } }),
    404,
    'SHARE_NOT_FOUND'
  );
  expectError(await api('share', { params: { token: 'not-a-real-token' } }), 404, 'SHARE_NOT_FOUND');
  await shutdown();
});

test('分享令牌按过期时间失效，过期判断使用注入时钟', async () => {
  let now = Date.parse('2026-01-01T00:00:00.000Z');
  await boot({}, { clock: () => now });
  const file = await createFile(USER_A, { chunks: ['expire'] });

  const created = await api('createShare', {
    user: USER_A,
    params: { fileId: file.fileId },
    body: { expiresInSeconds: 60 }
  });
  assert.equal(created.status, 201);
  const token = created.body.share.token;
  assert.equal(created.body.share.expiresAt, new Date(now + 60_000).toISOString());

  now += 59_000;
  assert.equal((await api('shareContent', { params: { token } })).status, 200);

  now += 2_000;
  expectError(await api('shareContent', { params: { token } }), 410, 'SHARE_EXPIRED');
  expectError(await api('share', { params: { token } }), 410, 'SHARE_EXPIRED');

  // expiresAt 必须晚于当前时间且不超过上限。
  expectError(await api('createShare', {
    user: USER_A,
    params: { fileId: file.fileId },
    body: { expiresAt: new Date(now - 1_000).toISOString() }
  }), 400, 'INVALID_INPUT');
  expectError(await api('createShare', {
    user: USER_A,
    params: { fileId: file.fileId },
    body: { expiresInSeconds: 10 * 365 * 24 * 60 * 60 }
  }), 400, 'INVALID_INPUT');
  expectError(await api('createShare', {
    user: USER_A,
    params: { fileId: file.fileId },
    body: { expiresInSeconds: 60, expiresAt: new Date(now + 60_000).toISOString() }
  }), 400, 'INVALID_INPUT');
  expectError(await api('createShare', {
    user: USER_A,
    params: { fileId: file.fileId },
    body: { expiresAt: 'not-a-date' }
  }), 400, 'INVALID_INPUT');
  await shutdown();
});

test('撤销分享：所有者可撤销、重复撤销幂等、撤销后公开读取 410', async () => {
  await boot();
  const file = await createFile(USER_A, { chunks: ['revoke'] });
  const created = await api('createShare', {
    user: USER_A,
    params: { fileId: file.fileId },
    body: { expiresInSeconds: 3600 }
  });
  const share = created.body.share;

  expectError(await api('revokeShare', { user: USER_B, params: { shareId: share.shareId } }), 403, 'FORBIDDEN');

  const revoked = await api('revokeShare', { user: USER_A, params: { shareId: share.shareId } });
  assert.equal(revoked.status, 200);
  assert.ok(revoked.body.share.revokedAt);
  assert.equal(revoked.body.idempotent, false);

  const repeated = await api('revokeShare', { user: USER_A, params: { shareId: share.shareId } });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.idempotent, true);

  expectError(await api('shareContent', { params: { token: share.token } }), 410, 'SHARE_REVOKED');
  expectError(await api('share', { params: { token: share.token } }), 410, 'SHARE_REVOKED');
  expectError(
    await api('revokeShare', { user: USER_A, params: { shareId: `shr_${'0'.repeat(24)}` } }),
    404,
    'SHARE_NOT_FOUND'
  );
  await shutdown();
});

test('文件删除后分享不可用；恢复后同一未过期令牌重新可用', async () => {
  await boot();
  const file = await createFile(USER_A, { chunks: ['restorable'] });
  const created = await api('createShare', {
    user: USER_A,
    params: { fileId: file.fileId },
    body: { expiresInSeconds: 3600 }
  });
  const share = created.body.share;

  const removed = await api('remove', {
    user: USER_A,
    params: { fileId: file.fileId },
    body: { operationId: nextOperationId('delete') }
  });
  assert.equal(removed.status, 200);

  expectError(await api('share', { params: { token: share.token } }), 410, 'FILE_DELETED');
  expectError(await api('shareContent', { params: { token: share.token } }), 410, 'FILE_DELETED');
  expectError(await api('createShare', {
    user: USER_A,
    params: { fileId: file.fileId },
    body: { expiresInSeconds: 60 }
  }), 409, 'FILE_DELETED');

  const restored = await api('restore', {
    user: USER_A,
    params: { fileId: file.fileId },
    body: { operationId: nextOperationId('restore') }
  });
  assert.equal(restored.status, 200);
  const afterRestore = await api('shareContent', { params: { token: share.token } });
  assert.equal(afterRestore.status, 200);
  assert.equal(afterRestore.body.toString('utf8'), 'restorable');
  await shutdown();
});
