'use strict';
// Survey 模块测试：直接调用 handler（构造 fake ctx），不启动 HTTP。
// 运行：node --test modules/survey/tests/*.test.js
// 依赖：仅 Node 内置模块。

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const surveyModule = require('../server/index.js');
const { validateManifest } = require('../../../core/registry/manifest.js');
const { validate } = require('../../../core/contracts/validate.js');
const { codes } = require('../../../core/errors.js');

const MODULE_ROOT = path.join(__dirname, '..');
const ALICE = { id: 'user-alice', username: 'alice', role: 'user' };
const BOB = { id: 'user-bob', username: 'bob', role: 'user' };
const ADMIN = { id: 'user-admin', username: 'admin', role: 'admin' };
const tempDirs = [];

function matchPath(pattern, pathname) {
  const expected = pattern.split('/');
  const actual = pathname.split('/');
  if (expected.length !== actual.length) return null;
  const params = {};
  for (let i = 0; i < expected.length; i += 1) {
    if (expected[i].startsWith(':')) {
      if (!actual[i]) return null;
      params[expected[i].slice(1)] = decodeURIComponent(actual[i]);
    } else if (expected[i] !== actual[i]) {
      return null;
    }
  }
  return params;
}

function routeFor(method, routePath) {
  for (const route of surveyModule.routes) {
    if (route.method !== method) continue;
    const params = matchPath(route.path, routePath);
    if (params) return { route, params };
  }
  return null;
}

async function call(method, routePath, options = {}) {
  const matched = routeFor(method, routePath);
  assert.ok(matched, `路由不存在：${method} ${routePath}`);
  return matched.route.handler({
    req: {},
    res: {},
    url: new URL(`http://127.0.0.1${routePath}`),
    params: { ...matched.params, ...(options.params || {}) },
    query: options.query || {},
    body: options.body === undefined ? {} : options.body,
    user: options.user === undefined ? null : options.user
  });
}

async function boot(config = {}) {
  await surveyModule.start({
    config,
    logger: { info() {}, warn() {}, error() {} }
  });
}

function tempDataFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pagesai-survey-test-'));
  tempDirs.push(dir);
  return { dir, dataFile: path.join(dir, 'survey.json') };
}

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(absolute));
    else result.push(absolute);
  }
  return result;
}

async function createSurvey(user, overrides = {}) {
  const response = await call('POST', '/api/survey/surveys', {
    user,
    body: {
      title: '测试问卷',
      description: '用于模块测试',
      questions: [
        {
          type: 'single',
          title: '你最常用的部门',
          required: true,
          options: [{ id: 'o-dev', label: '研发' }, { id: 'o-mkt', label: '市场' }]
        },
        {
          type: 'multiple',
          title: '你关注的方向',
          options: [{ id: 'o-ai', label: 'AI' }, { id: 'o-web', label: 'Web' }]
        },
        {
          type: 'text',
          title: '补充建议',
          required: false
        }
      ],
      ...overrides
    }
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.survey;
}

afterEach(async () => {
  await surveyModule.stop();
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

test('manifest/config schema 通过公共契约校验，路由前缀与生命周期正确', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(MODULE_ROOT, 'manifest.json'), 'utf8'));
  assert.doesNotThrow(() => validateManifest(manifest));
  assert.equal(manifest.id, 'survey');
  assert.equal(manifest.activation.routePrefix, '/api/survey');
  assert.equal(manifest.activation.serverEntry, 'server/index.js');
  assert.ok(Array.isArray(manifest.capabilities.tools));

  const configSchema = JSON.parse(fs.readFileSync(path.join(MODULE_ROOT, 'config.schema.json'), 'utf8'));
  assert.equal(validate(configSchema, {}).valid, true);
  assert.equal(validate(configSchema, { dataFile: null }).valid, true);
  assert.equal(validate(configSchema, { dataFile: 123 }).valid, false);
  assert.equal(validate(configSchema, { maxAttachmentBytes: 0 }).valid, false);

  for (const route of surveyModule.routes) {
    assert.ok(route.path.startsWith('/api/survey/'), `越界路由：${route.path}`);
    assert.equal(typeof route.handler, 'function');
  }
  assert.deepEqual(surveyModule.tools, {});

  await boot();
  const health = await surveyModule.health();
  assert.deepEqual(health, { ok: true });
  const httpHealth = await call('GET', '/api/survey/health');
  assert.equal(httpHealth.status, 200);
  assert.equal(httpHealth.body.ok, true);
  assert.equal((await call('GET', '/api/survey/public/not-exists')).status, 404);
});

test('创建/编辑需要登录且所有者隔离，管理员可读列表', async () => {
  await boot();

  const anonymous = await call('POST', '/api/survey/surveys', {
    body: { title: '匿名问卷', questions: [{ type: 'text', title: '问题' }] }
  });
  assert.equal(anonymous.status, 403);
  assert.equal(anonymous.body.code, codes.FORBIDDEN);

  const survey = await createSurvey(ALICE);
  assert.equal(survey.ownerId, ALICE.id);
  assert.equal(survey.status, 'draft');
  assert.equal(survey.questions[0].type, 'single');
  assert.equal(survey.questions[0].options[0].id, 'o-dev');

  const getByOwner = await call('GET', `/api/survey/surveys/${survey.id}`, { user: ALICE });
  assert.equal(getByOwner.status, 200);
  assert.equal(getByOwner.body.survey.title, '测试问卷');

  const getByOther = await call('GET', `/api/survey/surveys/${survey.id}`, { user: BOB });
  assert.equal(getByOther.status, 403);
  assert.equal(getByOther.body.code, codes.FORBIDDEN);

  const patchByOther = await call('PATCH', `/api/survey/surveys/${survey.id}`, {
    user: BOB,
    body: { title: '被篡改' }
  });
  assert.equal(patchByOther.status, 403);

  const patched = await call('PATCH', `/api/survey/surveys/${survey.id}`, {
    user: ALICE,
    body: {
      title: '已编辑问卷',
      questions: [
        { id: 'q-keep', type: 'text', title: '保留题目', required: true }
      ]
    }
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.survey.title, '已编辑问卷');
  assert.deepEqual(patched.body.survey.questions.map((question) => question.id), ['q-keep']);

  const put = await call('PUT', `/api/survey/surveys/${survey.id}`, {
    user: ALICE,
    body: { description: 'PUT 更新描述' }
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.survey.description, 'PUT 更新描述');
  assert.equal(put.body.survey.title, '已编辑问卷');

  const bobList = await call('GET', '/api/survey/surveys', { user: BOB });
  assert.equal(bobList.status, 200);
  assert.deepEqual(bobList.body.surveys, []);

  const adminList = await call('GET', '/api/survey/surveys', { user: ADMIN });
  assert.equal(adminList.status, 200);
  assert.equal(adminList.body.surveys.length, 1);
});

test('发布快照冻结题目；匿名填写、关闭后 409、跨用户 403', async () => {
  await boot();
  const survey = await createSurvey(ALICE);

  const publish = await call('POST', `/api/survey/surveys/${survey.id}/publish`, { user: ALICE });
  assert.equal(publish.status, 200);
  assert.equal(publish.body.version, 1);
  assert.ok(publish.body.slug);
  assert.equal(publish.body.publicPath, `/api/survey/public/${publish.body.slug}`);

  const publicBefore = await call('GET', `/api/survey/public/${publish.body.slug}`);
  assert.equal(publicBefore.status, 200);
  assert.equal(publicBefore.body.survey.questions[0].title, '你最常用的部门');
  assert.equal(publicBefore.body.survey.acceptingResponses, true);

  // 发布后继续编辑：公开快照不得变化。
  const edited = await call('PATCH', `/api/survey/surveys/${survey.id}`, {
    user: ALICE,
    body: {
      title: '发布后修改的标题',
      questions: [
        { id: 'q1', type: 'text', title: '发布后修改的题目' }
      ]
    }
  });
  assert.equal(edited.status, 200);
  const publicAfter = await call('GET', `/api/survey/public/${publish.body.slug}`);
  assert.equal(publicAfter.status, 200);
  assert.equal(publicAfter.body.survey.title, '测试问卷');
  assert.equal(publicAfter.body.survey.questions[0].title, '你最常用的部门');
  assert.equal(publicAfter.body.survey.questions.length, 3);

  const submitted = await call('POST', `/api/survey/public/${publish.body.slug}/responses`, {
    body: {
      answers: {
        q1: 'o-dev',
        q2: ['o-ai', 'o-web'],
        q3: '匿名提交'
      }
    }
  });
  assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
  assert.equal(submitted.body.response.version, 1);

  const missingRequired = await call('POST', `/api/survey/public/${publish.body.slug}/responses`, {
    body: { answers: { q2: ['o-ai'] } }
  });
  assert.equal(missingRequired.status, 400);
  assert.equal(missingRequired.body.code, codes.INVALID_INPUT);

  const stats = await call('GET', `/api/survey/surveys/${survey.id}/stats`, { user: ALICE });
  assert.equal(stats.status, 200);
  assert.equal(stats.body.stats.responseCount, 1);
  assert.equal(stats.body.stats.questions[0].answered, 1);

  const responses = await call('GET', `/api/survey/surveys/${survey.id}/responses`, { user: ALICE });
  assert.equal(responses.status, 200);
  assert.equal(responses.body.ownerId, ALICE.id);
  assert.equal(responses.body.responses[0].ownerId, ALICE.id, '答卷应归属问卷所有者');

  for (const endpoint of [
    `/api/survey/surveys/${survey.id}/responses`,
    `/api/survey/surveys/${survey.id}/stats`,
    `/api/survey/surveys/${survey.id}/export.csv`
  ]) {
    const denied = await call('GET', endpoint, { user: BOB });
    assert.equal(denied.status, 403, endpoint);
    assert.equal(denied.body.code, codes.FORBIDDEN);
    const anonymousRead = await call('GET', endpoint);
    assert.equal(anonymousRead.status, 403, endpoint);
  }

  const adminStats = await call('GET', `/api/survey/surveys/${survey.id}/stats`, { user: ADMIN });
  assert.equal(adminStats.status, 200);

  const closed = await call('POST', `/api/survey/surveys/${survey.id}/close`, { user: ALICE });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.survey.status, 'closed');

  const publicClosed = await call('GET', `/api/survey/public/${publish.body.slug}`);
  assert.equal(publicClosed.status, 200);
  assert.equal(publicClosed.body.survey.closed, true);
  assert.equal(publicClosed.body.survey.acceptingResponses, false);

  const afterClose = await call('POST', `/api/survey/public/${publish.body.slug}/responses`, {
    body: { answers: { q1: 'o-dev', q2: ['o-ai'], q3: '关闭后提交' } }
  });
  assert.equal(afterClose.status, 409);
  assert.equal(afterClose.body.code, 'SURVEY_CLOSED');
  assert.match(afterClose.body.message, /关闭/);
});

test('统计计数/占比正确，CSV 正确转义引号与换行', async () => {
  await boot();
  const created = await call('POST', '/api/survey/surveys', {
    user: ALICE,
    body: {
      title: '统计问卷',
      questions: [
        {
          type: 'single_choice',
          title: '部门',
          required: true,
          options: ['研发一部', '市场部']
        },
        {
          type: 'multiple_choice',
          title: '方向',
          options: ['AI', 'Web']
        },
        {
          type: 'text',
          title: '备注,说明'
        }
      ]
    }
  });
  assert.equal(created.status, 201);
  const survey = created.body.survey;
  const publish = await call('POST', `/api/survey/surveys/${survey.id}/publish`, { user: ALICE });
  const slug = publish.body.slug;

  const first = await call('POST', `/api/survey/public/${slug}/responses`, {
    body: {
      answers: {
        q1: 'o1',
        q2: ['o1', 'o2'],
        q3: '第一行\n他说"你好",然后走了'
      }
    }
  });
  assert.equal(first.status, 201);
  assert.equal((await call('POST', `/api/survey/public/${slug}/responses`, {
    body: { answers: { q1: 'o2', q2: ['o1'], q3: '普通' } }
  })).status, 201);
  assert.equal((await call('POST', `/api/survey/public/${slug}/responses`, {
    body: { answers: { q1: 'o1', q2: [] } }
  })).status, 201);

  const statsResponse = await call('GET', `/api/survey/surveys/${survey.id}/stats`, { user: ALICE });
  assert.equal(statsResponse.status, 200);
  const stats = statsResponse.body.stats;
  assert.equal(stats.responseCount, 3);
  assert.equal(stats.total, 3);

  const single = stats.questions[0];
  assert.equal(single.type, 'single');
  assert.equal(single.answered, 3);
  assert.equal(single.counts.o1, 2);
  assert.equal(single.counts.o2, 1);
  assert.equal(single.options[0].percentage, 66.67);
  assert.equal(single.options[1].percentage, 33.33);
  assert.equal(single.options[0].ratio, 0.6667);

  const multiple = stats.questions[1];
  assert.equal(multiple.answered, 2);
  assert.equal(multiple.counts.o1, 2);
  assert.equal(multiple.counts.o2, 1);
  assert.equal(multiple.options[0].percentage, 66.67, '占比以全部答卷为分母');
  assert.equal(multiple.options[1].percentage, 33.33);
  assert.equal(multiple.options[0].answeredPercentage, 100, '另给以答该题者为分母的占比');
  assert.equal(multiple.options[1].answeredPercentage, 50);

  const text = stats.questions[2];
  assert.equal(text.type, 'text');
  assert.equal(text.answered, 2);
  assert.equal(text.unanswered, 1);
  assert.equal(text.answeredPercentage, 66.67);

  const exported = await call('GET', `/api/survey/surveys/${survey.id}/export.csv`, { user: ALICE });
  assert.equal(exported.status, 200);
  assert.equal(exported.contentType, 'text/csv; charset=utf-8');
  const csv = exported.body;
  assert.equal(typeof csv, 'string');
  assert.ok(csv.startsWith('response_id,submitted_at,部门,方向,"备注,说明"\r\n'));
  assert.ok(csv.includes('"第一行\n他说""你好"",然后走了"'), '文本中的引号应双写、换行应保留在带引号单元格内');
  assert.ok(csv.includes(',研发一部,AI; Web,'));
  assert.equal(csv.split('\r\n').length, 5, '表头 + 3 行 + 末尾空串');

  const bobExport = await call('GET', `/api/survey/surveys/${survey.id}/export.csv`, { user: BOB });
  assert.equal(bobExport.status, 403);
});

test('文件题附件写入 dataFile 同级 attachments；未配置 dataFile 返回 409', async () => {
  const { dir, dataFile } = tempDataFile();
  await boot({ dataFile });

  const created = await call('POST', '/api/survey/surveys', {
    user: ALICE,
    body: {
      title: '文件题问卷',
      questions: [{ type: 'file', title: '上传证明材料', required: true }]
    }
  });
  assert.equal(created.status, 201);
  const survey = created.body.survey;
  const publish = await call('POST', `/api/survey/surveys/${survey.id}/publish`, { user: ALICE });
  const fileBuffer = Buffer.from('附件内容\nsecond line', 'utf8');

  const submitted = await call('POST', `/api/survey/public/${publish.body.slug}/responses`, {
    body: {
      answers: {
        q1: {
          filename: '../报告 "1".txt',
          contentType: 'text/plain',
          dataBase64: fileBuffer.toString('base64')
        }
      }
    }
  });
  assert.equal(submitted.status, 201, JSON.stringify(submitted.body));

  const attachmentsRoot = path.join(dir, 'attachments');
  assert.equal(fs.existsSync(attachmentsRoot), true);
  const stored = walkFiles(attachmentsRoot);
  assert.equal(stored.length, 1);
  assert.equal(fs.readFileSync(stored[0], 'utf8'), fileBuffer.toString('utf8'));
  assert.ok(path.resolve(stored[0]).startsWith(path.resolve(attachmentsRoot) + path.sep));

  const responses = await call('GET', `/api/survey/surveys/${survey.id}/responses`, { user: ALICE });
  assert.equal(responses.status, 200);
  const answer = responses.body.responses[0].answers.q1;
  assert.equal(answer.filename, '../报告 "1".txt');
  assert.equal(answer.size, fileBuffer.length);
  assert.ok(answer.attachmentId);
  assert.equal(Object.prototype.hasOwnProperty.call(answer, 'storageKey'), false, '不得向 API 暴露内部存储键');

  const downloaded = await call('GET', `/api/survey/surveys/${survey.id}/attachments/${answer.attachmentId}`, { user: ALICE });
  assert.equal(downloaded.status, 200);
  assert.equal(Buffer.from(downloaded.body.dataBase64, 'base64').toString('utf8'), fileBuffer.toString('utf8'));
  assert.equal(downloaded.body.attachment.filename, '../报告 "1".txt');

  const bobDownload = await call('GET', `/api/survey/surveys/${survey.id}/attachments/${answer.attachmentId}`, { user: BOB });
  assert.equal(bobDownload.status, 403);

  // 纯内存运行：文本题可用，文件题必须明确 409，而不是假装写入成功。
  await surveyModule.stop();
  await boot({});
  const memoryCreated = await call('POST', '/api/survey/surveys', {
    user: ALICE,
    body: {
      title: '纯内存文件题',
      questions: [{ type: 'file', title: '附件' }]
    }
  });
  const memoryPublish = await call('POST', `/api/survey/surveys/${memoryCreated.body.survey.id}/publish`, { user: ALICE });
  const memorySubmit = await call('POST', `/api/survey/public/${memoryPublish.body.slug}/responses`, {
    body: { answers: { q1: { filename: 'a.txt', dataBase64: Buffer.from('x').toString('base64') } } }
  });
  assert.equal(memorySubmit.status, 409);
  assert.equal(memorySubmit.body.code, 'ATTACHMENT_STORAGE_NOT_CONFIGURED');
  assert.match(memorySubmit.body.message, /dataFile/);
});

test('重新发布生成新版本快照并更新同一 slug 的公开内容', async () => {
  await boot();
  const survey = await createSurvey(ALICE);
  const first = await call('POST', `/api/survey/surveys/${survey.id}/publish`, { user: ALICE });
  assert.equal(first.body.version, 1);
  assert.equal((await call('GET', `/api/survey/public/${first.body.slug}`)).body.survey.title, '测试问卷');

  const edited = await call('PATCH', `/api/survey/surveys/${survey.id}`, {
    user: ALICE,
    body: {
      title: '第二版标题',
      questions: [
        { type: 'single', title: '第二版题目', options: ['A', 'B'] }
      ]
    }
  });
  assert.equal(edited.status, 200);

  const second = await call('POST', `/api/survey/surveys/${survey.id}/publish`, { user: ALICE });
  assert.equal(second.status, 200);
  assert.equal(second.body.version, 2);
  assert.equal(second.body.slug, first.body.slug, '重新发布沿用同一公开 slug');
  const publicNow = await call('GET', `/api/survey/public/${first.body.slug}`);
  assert.equal(publicNow.body.survey.version, 2);
  assert.equal(publicNow.body.survey.title, '第二版标题');
  assert.equal(publicNow.body.survey.questions[0].title, '第二版题目');
});

test('dataFile 持久化：重启后问卷、公开快照与答卷仍在', async () => {
  const { dataFile } = tempDataFile();
  await boot({ dataFile });
  const survey = await createSurvey(ALICE);
  const publish = await call('POST', `/api/survey/surveys/${survey.id}/publish`, { user: ALICE });
  const submitted = await call('POST', `/api/survey/public/${publish.body.slug}/responses`, {
    body: { answers: { q1: 'o-dev', q2: ['o-ai'], q3: '持久化' } }
  });
  assert.equal(submitted.status, 201);

  await surveyModule.stop();
  await boot({ dataFile });

  const publicAgain = await call('GET', `/api/survey/public/${publish.body.slug}`);
  assert.equal(publicAgain.status, 200);
  assert.equal(publicAgain.body.survey.title, '测试问卷');
  const stats = await call('GET', `/api/survey/surveys/${survey.id}/stats`, { user: ALICE });
  assert.equal(stats.status, 200);
  assert.equal(stats.body.stats.responseCount, 1);
  assert.equal(stats.body.stats.questions[0].counts['o-dev'], 1);
  const responses = await call('GET', `/api/survey/surveys/${survey.id}/responses`, { user: ALICE });
  assert.equal(responses.body.responseCount, 1);
  assert.equal(responses.body.responses[0].answers.q3, '持久化');
});

test('输入校验：非法题目、越界答案、超大附件均返回明确错误', async () => {
  const { dataFile } = tempDataFile();
  await boot({ dataFile, maxAttachmentBytes: 4 });

  const invalidType = await call('POST', '/api/survey/surveys', {
    user: ALICE,
    body: { title: '非法类型', questions: [{ type: 'matrix', title: '矩阵' }] }
  });
  assert.equal(invalidType.status, 400);
  assert.equal(invalidType.body.code, codes.INVALID_INPUT);

  const noQuestions = await call('POST', '/api/survey/surveys', {
    user: ALICE,
    body: { title: '空问卷', questions: [] }
  });
  assert.equal(noQuestions.status, 400);

  const noOptions = await call('POST', '/api/survey/surveys', {
    user: ALICE,
    body: { title: '缺选项', questions: [{ type: 'single', title: '单选' }] }
  });
  assert.equal(noOptions.status, 400);

  const survey = await createSurvey(ALICE);
  const publish = await call('POST', `/api/survey/surveys/${survey.id}/publish`, { user: ALICE });
  const slug = publish.body.slug;

  const unknownQuestion = await call('POST', `/api/survey/public/${slug}/responses`, {
    body: { answers: { q1: 'o-dev', not_exist: 'x' } }
  });
  assert.equal(unknownQuestion.status, 400);
  assert.match(unknownQuestion.body.message, /不存在的题目/);

  const invalidOption = await call('POST', `/api/survey/public/${slug}/responses`, {
    body: { answers: { q1: 'o-missing' } }
  });
  assert.equal(invalidOption.status, 400);

  const wrongTextType = await call('POST', `/api/survey/public/${slug}/responses`, {
    body: { answers: { q1: 'o-dev', q3: 123 } }
  });
  assert.equal(wrongTextType.status, 400);

  const normalSubmission = await call('POST', `/api/survey/public/${slug}/responses`, {
    body: {
      answers: {
        q1: 'o-dev',
        q3: 'ok'
      }
    }
  });
  assert.equal(normalSubmission.status, 201);

  const fileSurvey = await call('POST', '/api/survey/surveys', {
    user: ALICE,
    body: { title: '小附件', questions: [{ type: 'file', title: '附件' }] }
  });
  const filePublish = await call('POST', `/api/survey/surveys/${fileSurvey.body.survey.id}/publish`, { user: ALICE });
  const oversized = await call('POST', `/api/survey/public/${filePublish.body.slug}/responses`, {
    body: {
      answers: {
        q1: {
          filename: 'big.bin',
          dataBase64: Buffer.from('1234567890').toString('base64')
        }
      }
    }
  });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.body.code, 'ATTACHMENT_TOO_LARGE');

  const unknownPublish = await call('POST', '/api/survey/surveys/does-not-exist/publish', { user: ALICE });
  assert.equal(unknownPublish.status, 404);
  assert.equal(unknownPublish.body.code, codes.NOT_FOUND);

  // 原型链键不得被误当作记录（管理员也不能越过 404）。
  const protoSurvey = await call('GET', '/api/survey/surveys/__proto__', { user: ADMIN });
  assert.equal(protoSurvey.status, 404);
  const protoPublic = await call('GET', '/api/survey/public/__proto__');
  assert.equal(protoPublic.status, 404);
});
