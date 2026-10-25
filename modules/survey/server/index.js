'use strict';
// PagesAI 公开版 · Survey 模块（方案 §7.6）
//
// 最小闭环：创建/编辑 → 发布快照 → 公开链接匿名填写 → 关闭 → 答卷/统计/CSV 导出 → 文件题附件。
// 设计约束：
//  - 只使用 Node 内置模块；不依赖 MongoDB、Mail、Disk、Glim 或 AI；
//  - 数据统一走 core/storage/json-store.js；config.dataFile 缺省时为纯内存；
//  - 发布后公开读取的是不可变快照，后续编辑不影响已发布问卷；
//  - 文件题附件写入 config.attachmentsDir（缺省为 dataFile 同级的 attachments/），两者都未配置时明确 409。
//
// 所有路由以 /api/survey/ 开头。handler 返回 { status, body }；错误统一为 { code, message }。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { CoreError, codes } = require('../../../core/errors.js');
const { JsonStore } = require('../../../core/storage/json-store.js');

const ROUTE_PREFIX = '/api/survey';
const DEFAULT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES_LIMIT = 100 * 1024 * 1024;
const MAX_QUESTIONS = 200;
const MAX_OPTIONS = 200;
const MAX_TEXT_ANSWER = 20000;

const TYPE_ALIASES = Object.freeze({
  single: 'single',
  single_choice: 'single',
  radio: 'single',
  单选: 'single',
  multiple: 'multiple',
  multiple_choice: 'multiple',
  checkbox: 'multiple',
  多选: 'multiple',
  text: 'text',
  short_text: 'text',
  long_text: 'text',
  textarea: 'text',
  文本: 'text',
  file: 'file',
  file_upload: 'file',
  upload: 'file',
  文件: 'file'
});

const CHOICE_TYPES = new Set(['single', 'multiple']);
const QUESTION_TYPES = new Set(['single', 'multiple', 'text', 'file']);

let state = null;

function fail(code, message, status = 400) {
  throw new CoreError(code, message, { status });
}

function invalid(message) {
  fail(codes.INVALID_INPUT, message, 400);
}

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeType(raw) {
  if (typeof raw !== 'string') invalid('题目类型必须是字符串');
  const type = TYPE_ALIASES[raw.trim().toLowerCase()];
  if (!type || !QUESTION_TYPES.has(type)) {
    invalid('题目类型只支持 single、multiple、text、file');
  }
  return type;
}

function requiredText(value, label, maxLength) {
  if (typeof value !== 'string') invalid(`${label}必须是字符串`);
  const text = value.trim();
  if (!text) invalid(`${label}不能为空`);
  if (text.length > maxLength) invalid(`${label}不能超过 ${maxLength} 个字符`);
  return text;
}

function optionalText(value, label, maxLength) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') invalid(`${label}必须是字符串`);
  const text = value.trim();
  if (text.length > maxLength) invalid(`${label}不能超过 ${maxLength} 个字符`);
  return text;
}

function safeQuestionId(raw) {
  return typeof raw === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(raw);
}

function safeOptionId(raw) {
  return typeof raw === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(raw);
}

/** 归一化题目；只接受四种最小类型。 */
function normalizeQuestions(rawQuestions) {
  if (!Array.isArray(rawQuestions)) invalid('questions 必须是数组');
  if (rawQuestions.length < 1) invalid('问卷至少需要一道题');
  if (rawQuestions.length > MAX_QUESTIONS) invalid(`题目不能超过 ${MAX_QUESTIONS} 道`);

  const usedQuestionIds = new Set();
  return rawQuestions.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid(`第 ${index + 1} 道题格式无效`);
    const type = normalizeType(raw.type);
    const title = requiredText(raw.title ?? raw.label ?? raw.text ?? raw.name, `第 ${index + 1} 道题标题`, 500);
    const description = optionalText(raw.description, `第 ${index + 1} 道题描述`, 5000);

    let questionId;
    if (raw.id !== undefined && raw.id !== null && raw.id !== '') {
      if (!safeQuestionId(raw.id)) invalid(`第 ${index + 1} 道题 id 无效`);
      questionId = raw.id;
      if (usedQuestionIds.has(questionId)) invalid(`题目 id 重复：${questionId}`);
    } else {
      let n = index + 1;
      questionId = `q${n}`;
      while (usedQuestionIds.has(questionId)) {
        n += 1;
        questionId = `q${index + 1}_${n}`;
      }
    }
    usedQuestionIds.add(questionId);

    let options = [];
    if (CHOICE_TYPES.has(type)) {
      if (!Array.isArray(raw.options)) invalid(`第 ${index + 1} 道选择题必须提供 options`);
      if (raw.options.length < 2) invalid(`第 ${index + 1} 道选择题至少需要两个选项`);
      if (raw.options.length > MAX_OPTIONS) invalid(`第 ${index + 1} 道选择题选项不能超过 ${MAX_OPTIONS} 个`);
      const usedOptionIds = new Set();
      options = raw.options.map((option, optionIndex) => {
        const source = option && typeof option === 'object' && !Array.isArray(option) ? option : { label: option };
        const label = requiredText(source.label ?? source.text ?? source.value ?? source.title ?? source.name, `第 ${index + 1} 道题第 ${optionIndex + 1} 个选项`, 500);
        let optionId;
        if (source.id !== undefined && source.id !== null && source.id !== '') {
          if (!safeOptionId(source.id)) invalid(`第 ${index + 1} 道题第 ${optionIndex + 1} 个选项 id 无效`);
          optionId = source.id;
        } else {
          optionId = `o${optionIndex + 1}`;
        }
        if (usedOptionIds.has(optionId)) invalid(`第 ${index + 1} 道题选项 id 重复：${optionId}`);
        usedOptionIds.add(optionId);
        return { id: optionId, label };
      });
    }

    return {
      id: questionId,
      type,
      title,
      description,
      required: raw.required === true,
      options
    };
  });
}

/** 校验并归一化问卷草稿（创建与 PATCH 共用）。 */
function normalizeDraft(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('请求体必须是对象');
  const title = requiredText(input.title ?? input.name, '问卷标题', 500);
  const description = optionalText(input.description, '问卷描述', 5000);
  const questions = normalizeQuestions(input.questions);
  return { title, description, questions };
}

function mergeDraft(existing, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) invalid('请求体必须是对象');
  return normalizeDraft({
    title: patch.title !== undefined ? patch.title : (patch.name !== undefined ? patch.name : existing.title),
    description: patch.description !== undefined ? patch.description : existing.description,
    questions: patch.questions !== undefined ? patch.questions : existing.questions
  });
}

function requireState() {
  if (!state) fail('MODULE_NOT_READY', 'Survey 模块尚未启动', 503);
  return state;
}

function authInfo(ctx) {
  const user = ctx && ctx.user ? ctx.user : null;
  if (!user || typeof user !== 'object') fail(codes.FORBIDDEN, '需要登录后才能执行该操作', 403);
  const rawId = user.id ?? user.userId ?? user._id;
  if (rawId === undefined || rawId === null || String(rawId) === '') {
    fail(codes.FORBIDDEN, '当前用户缺少稳定标识', 403);
  }
  return { userId: String(rawId), isAdmin: user.role === 'admin', user };
}

function ownGet(collection, key) {
  const bucket = requireState().store.get(collection);
  return Object.prototype.hasOwnProperty.call(bucket, key) ? bucket[key] : null;
}

function findSurvey(surveyId) {
  const survey = ownGet('surveys', surveyId);
  if (!survey) fail(codes.NOT_FOUND, '问卷不存在', 404);
  return survey;
}

/** 所有者或管理员可访问；普通跨用户访问返回 403。 */
function ownedSurvey(ctx, surveyId) {
  const auth = authInfo(ctx);
  const survey = findSurvey(surveyId);
  if (!auth.isAdmin && survey.ownerId !== auth.userId) {
    fail(codes.FORBIDDEN, '无权访问该问卷', 403);
  }
  return { survey, ...auth };
}

function param(ctx, name) {
  const value = ctx && ctx.params ? ctx.params[name] : undefined;
  if (typeof value !== 'string' || value === '') invalid(`缺少路径参数 ${name}`);
  return value;
}

function parseListQuery(ctx) {
  const query = ctx && ctx.query ? ctx.query : {};
  return {
    status: typeof query.status === 'string' ? query.status : null
  };
}

function newSlug() {
  const store = requireState().store;
  for (let i = 0; i < 20; i += 1) {
    const slug = `s${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
    if (!store.has('slugs', slug)) return slug;
  }
  throw new CoreError('SLUG_GENERATION_FAILED', '无法生成唯一公开链接', { status: 500 });
}

function surveySummary(survey) {
  return {
    id: survey.id,
    ownerId: survey.ownerId,
    title: survey.title,
    description: survey.description,
    status: survey.status,
    slug: survey.slug || null,
    version: survey.version || null,
    questionCount: survey.questions.length,
    responseCount: requireState().store.list('responses').filter((item) => item.surveyId === survey.id).length,
    createdAt: survey.createdAt,
    updatedAt: survey.updatedAt,
    publishedAt: survey.publishedAt || null,
    closedAt: survey.closedAt || null
  };
}

function ownerSurvey(survey) {
  return {
    ...surveySummary(survey),
    questions: clone(survey.questions)
  };
}

function findPublic(slug) {
  const link = ownGet('slugs', slug);
  if (!link) fail(codes.NOT_FOUND, '问卷不存在或尚未发布', 404);
  const snapshot = ownGet('snapshots', link.snapshotId);
  const survey = ownGet('surveys', link.surveyId);
  if (!snapshot || !survey) fail(codes.NOT_FOUND, '问卷不存在或尚未发布', 404);
  return { survey, snapshot, link };
}

function publicSurvey(survey, snapshot) {
  return {
    id: snapshot.surveyId,
    slug: snapshot.slug,
    version: snapshot.version,
    title: snapshot.title,
    description: snapshot.description,
    questions: clone(snapshot.questions),
    status: survey.status,
    closed: survey.status === 'closed',
    acceptingResponses: survey.status === 'published',
    publishedAt: snapshot.publishedAt,
    closedAt: survey.closedAt || null
  };
}

/** 当前统计/导出使用的题目：优先活动快照，避免后续编辑改变已发布题目的口径。 */
function resultQuestions(survey) {
  const store = requireState().store;
  const snapshot = survey.activeSnapshotId ? store.get('snapshots')[survey.activeSnapshotId] : null;
  return {
    questions: snapshot ? clone(snapshot.questions) : clone(survey.questions),
    version: snapshot ? snapshot.version : (survey.version || null)
  };
}

function extractRawAnswers(body) {
  if (body === undefined || body === null || body === '') return {};
  if (typeof body !== 'object' || Array.isArray(body)) invalid('answers 必须是对象或数组');
  const raw = body.answers !== undefined ? body.answers : body;
  if (raw === null || raw === undefined) return {};
  if (Array.isArray(raw)) {
    const mapped = {};
    for (const item of raw) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) invalid('answers 数组元素格式无效');
      const key = item.questionId ?? item.id ?? item.qid;
      if (typeof key !== 'string' || !key) invalid('answers 数组元素缺少 questionId');
      mapped[key] = item.value !== undefined ? item.value : item.answer;
    }
    return mapped;
  }
  if (typeof raw !== 'object') invalid('answers 必须是对象或数组');
  return raw;
}

function isUnanswered(value) {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

function sanitizeFilename(name) {
  const base = path.basename(String(name).replace(/\\/g, '/'));
  const cleaned = base.replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim();
  return (cleaned || 'file').slice(0, 180);
}

function decodeFileValue(question, value, maxBytes) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    invalid(`第「${question.title}」题需要一个文件对象`);
  }
  const filenameRaw = value.filename ?? value.name;
  if (typeof filenameRaw !== 'string' || !filenameRaw.trim()) invalid(`第「${question.title}」题缺少文件名`);
  if (filenameRaw.length > 255) invalid(`第「${question.title}」题文件名过长`);
  const filename = filenameRaw.trim();

  const base64 = value.dataBase64 ?? value.contentBase64 ?? value.base64
    ?? (typeof value.data === 'string' ? value.data : null);
  let buffer;
  if (typeof base64 === 'string') {
    const cleaned = base64.replace(/^data:[^;]*;base64,/i, '').replace(/\s+/g, '');
    if (cleaned && !/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) {
      invalid(`第「${question.title}」题附件不是合法 base64`);
    }
    buffer = Buffer.from(cleaned, 'base64');
  } else if (typeof value.content === 'string') {
    buffer = Buffer.from(value.content, 'utf8');
  } else {
    invalid(`第「${question.title}」题缺少 dataBase64/content`);
  }
  if (buffer.length > maxBytes) {
    fail('ATTACHMENT_TOO_LARGE', `第「${question.title}」题附件超过 ${maxBytes} 字节限制`, 413);
  }
  const contentType = typeof value.contentType === 'string' && value.contentType.trim()
    ? value.contentType.trim().slice(0, 200)
    : 'application/octet-stream';
  return { questionId: question.id, filename, contentType, buffer };
}

/**
 * 校验答卷。文件对象只解析为内存 buffer，待生成 responseId 后再落盘。
 * @returns {{answers: object, files: Array<object>}}
 */
function prepareAnswers(snapshot, rawAnswers) {
  const answers = {};
  const files = [];
  const questions = snapshot.questions;
  const questionMap = new Map(questions.map((question) => [question.id, question]));

  for (const key of Object.keys(rawAnswers)) {
    if (!questionMap.has(key)) invalid(`答案包含不存在的题目：${key}`);
  }

  for (const question of questions) {
    const value = Object.prototype.hasOwnProperty.call(rawAnswers, question.id) ? rawAnswers[question.id] : undefined;
    if (isUnanswered(value)) {
      if (question.required) invalid(`第「${question.title}」题为必填项`);
      continue;
    }

    if (question.type === 'single') {
      if (typeof value !== 'string') invalid(`第「${question.title}」题答案必须是单个选项`);
      const option = question.options.find((item) => item.id === value || item.label === value);
      if (!option) invalid(`第「${question.title}」题答案不是有效选项`);
      answers[question.id] = option.id;
    } else if (question.type === 'multiple') {
      if (!Array.isArray(value)) invalid(`第「${question.title}」题答案必须是选项数组`);
      const selected = [];
      for (const item of value) {
        if (typeof item !== 'string') invalid(`第「${question.title}」题选项值必须是字符串`);
        const option = question.options.find((candidate) => candidate.id === item || candidate.label === item);
        if (!option) invalid(`第「${question.title}」题答案包含无效选项`);
        if (!selected.includes(option.id)) selected.push(option.id);
      }
      if (selected.length === 0) {
        if (question.required) invalid(`第「${question.title}」题为必填项`);
      } else {
        answers[question.id] = selected;
      }
    } else if (question.type === 'text') {
      if (typeof value !== 'string') invalid(`第「${question.title}」题答案必须是字符串`);
      if (value.length > MAX_TEXT_ANSWER) invalid(`第「${question.title}」题答案不能超过 ${MAX_TEXT_ANSWER} 个字符`);
      if (!value.trim()) {
        if (question.required) invalid(`第「${question.title}」题为必填项`);
      } else {
        answers[question.id] = value;
      }
    } else if (question.type === 'file') {
      files.push(decodeFileValue(question, value, requireState().config.maxAttachmentBytes));
    }
  }

  return { answers, files };
}

function resolveAttachmentPath(storageKey) {
  const root = requireState().attachmentsRoot;
  if (!root) {
    fail('ATTACHMENT_STORAGE_NOT_CONFIGURED', '文件题需要配置 config.attachmentsDir 或 config.dataFile 才能保存附件', 409);
  }
  const parts = String(storageKey || '').split('/').filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) {
    fail('ATTACHMENT_PATH_INVALID', '附件路径无效', 500);
  }
  const absolute = path.resolve(root, ...parts);
  if (!absolute.startsWith(root + path.sep)) fail('ATTACHMENT_PATH_INVALID', '附件路径越界', 500);
  return absolute;
}

/** 附件落在附件根（config.attachmentsDir 或 dataFile 同级 attachments/）的 <surveyId>/<responseId>/ 下。 */
function writeAttachment(survey, responseId, file) {
  const attachmentId = newId('att');
  const storedName = `${attachmentId}-${sanitizeFilename(file.filename)}`;
  const relativeKey = `${survey.id}/${responseId}/${storedName}`;
  const absolute = resolveAttachmentPath(relativeKey);
  try {
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, file.buffer, { mode: 0o600 });
  } catch (err) {
    throw new CoreError('ATTACHMENT_WRITE_FAILED', `附件写入失败：${err.message}`, { status: 500 });
  }
  return {
    attachmentId,
    filename: file.filename,
    contentType: file.contentType,
    size: file.buffer.length,
    storageKey: relativeKey
  };
}

function sanitizeAnswerValue(value) {
  if (Array.isArray(value)) return value.slice();
  if (value && typeof value === 'object') {
    return {
      attachmentId: value.attachmentId,
      filename: value.filename,
      contentType: value.contentType,
      size: value.size
    };
  }
  return value;
}

function sanitizeAnswers(answers) {
  const result = {};
  for (const [questionId, value] of Object.entries(answers || {})) {
    result[questionId] = sanitizeAnswerValue(value);
  }
  return result;
}

function responsesFor(surveyId) {
  return requireState().store
    .list('responses')
    .filter((response) => response.surveyId === surveyId)
    .sort((a, b) => String(a.submittedAt).localeCompare(String(b.submittedAt)));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function percentage(count, base) {
  return base > 0 ? round((count / base) * 100, 2) : 0;
}

function answerPresent(answer) {
  if (Array.isArray(answer)) return answer.length > 0;
  if (answer && typeof answer === 'object') return Boolean(answer.attachmentId);
  return answer !== undefined && answer !== null && answer !== '';
}

function buildStats(survey) {
  const responses = responsesFor(survey.id);
  const total = responses.length;
  const { questions, version } = resultQuestions(survey);

  const stats = questions.map((question) => {
    let answered = 0;
    const optionCounts = new Map((question.options || []).map((option) => [option.id, 0]));
    for (const response of responses) {
      const answer = (response.answers || {})[question.id];
      if (!answerPresent(answer)) continue;
      answered += 1;
      if (question.type === 'single' && typeof answer === 'string' && optionCounts.has(answer)) {
        optionCounts.set(answer, optionCounts.get(answer) + 1);
      } else if (question.type === 'multiple' && Array.isArray(answer)) {
        for (const selected of answer) {
          if (optionCounts.has(selected)) optionCounts.set(selected, optionCounts.get(selected) + 1);
        }
      }
    }

    const options = (question.options || []).map((option) => {
      const count = optionCounts.get(option.id) || 0;
      const percentageOfAnswered = percentage(count, answered);
      return {
        id: option.id,
        label: option.label,
        count,
        percentage: percentage(count, total),
        ratio: total > 0 ? round(count / total, 4) : 0,
        answeredPercentage: percentageOfAnswered,
        answeredRatio: answered > 0 ? round(count / answered, 4) : 0
      };
    });
    const counts = {};
    for (const option of options) counts[option.id] = option.count;

    return {
      id: question.id,
      title: question.title,
      type: question.type,
      required: question.required,
      answered,
      unanswered: total - answered,
      answeredPercentage: percentage(answered, total),
      counts,
      options
    };
  });

  return {
    surveyId: survey.id,
    version,
    responseCount: total,
    total,
    questions: stats,
    generatedAt: nowIso()
  };
}

function csvCell(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csvRow(cells) {
  return `${cells.map(csvCell).join(',')}\r\n`;
}

function answerText(question, answer) {
  if (!answerPresent(answer)) return '';
  if (question.type === 'single') {
    const option = question.options.find((item) => item.id === answer);
    return option ? option.label : '';
  }
  if (question.type === 'multiple') {
    return answer
      .map((id) => {
        const option = question.options.find((item) => item.id === id);
        return option ? option.label : '';
      })
      .filter(Boolean)
      .join('; ');
  }
  if (question.type === 'file') return answer.filename || '';
  return String(answer);
}

function buildCsv(survey) {
  const { questions } = resultQuestions(survey);
  const responses = responsesFor(survey.id);
  const header = ['response_id', 'submitted_at', ...questions.map((question) => question.title)];
  const rows = [csvRow(header)];
  for (const response of responses) {
    const cells = [
      response.id,
      response.submittedAt,
      ...questions.map((question) => answerText(question, (response.answers || {})[question.id]))
    ];
    rows.push(csvRow(cells));
  }
  return { csv: rows.join(''), questions };
}

function findAttachment(surveyId, attachmentId) {
  for (const response of responsesFor(surveyId)) {
    for (const [questionId, answer] of Object.entries(response.answers || {})) {
      if (answer && typeof answer === 'object' && answer.attachmentId === attachmentId) {
        return { response, questionId, answer };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 路由实现
// ---------------------------------------------------------------------------

async function moduleHealth() {
  return { status: 200, body: { ok: true, module: 'survey' } };
}

async function createSurvey(ctx) {
  const auth = authInfo(ctx);
  const draft = normalizeDraft(ctx.body);
  const store = requireState().store;
  const createdAt = nowIso();
  const survey = {
    id: newId('srv'),
    ownerId: auth.userId,
    ...draft,
    status: 'draft',
    slug: null,
    version: 0,
    activeSnapshotId: null,
    createdAt,
    updatedAt: createdAt,
    publishedAt: null,
    closedAt: null
  };
  store.put('surveys', survey.id, survey);
  return { status: 201, body: { survey: ownerSurvey(survey) } };
}

async function listSurveys(ctx) {
  const auth = authInfo(ctx);
  const { status } = parseListQuery(ctx);
  const list = requireState().store
    .list('surveys')
    .filter((survey) => auth.isAdmin || survey.ownerId === auth.userId)
    .filter((survey) => !status || survey.status === status)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .map((survey) => surveySummary(survey));
  return { status: 200, body: { surveys: list } };
}

async function getSurvey(ctx) {
  const { survey } = ownedSurvey(ctx, param(ctx, 'id'));
  return { status: 200, body: { survey: ownerSurvey(survey) } };
}

async function updateSurvey(ctx) {
  const surveyId = param(ctx, 'id');
  const { survey } = ownedSurvey(ctx, surveyId);
  const draft = mergeDraft(survey, ctx.body);
  const updated = requireState().store.update('surveys', surveyId, {
    ...draft,
    updatedAt: nowIso()
  });
  return { status: 200, body: { survey: ownerSurvey(updated) } };
}

async function publishSurvey(ctx) {
  const surveyId = param(ctx, 'id');
  const { survey } = ownedSurvey(ctx, surveyId);
  const draft = normalizeDraft(survey);
  const store = requireState().store;
  const version = (survey.version || 0) + 1;
  const publishedAt = nowIso();
  const slug = survey.slug || newSlug();
  const snapshotId = `${survey.id}:v${version}`;
  const snapshot = {
    id: snapshotId,
    surveyId: survey.id,
    ownerId: survey.ownerId,
    slug,
    version,
    title: draft.title,
    description: draft.description,
    questions: draft.questions,
    publishedAt
  };

  // 快照只写一次；同一 slug 的公开入口更新到最新快照，旧快照仍保留作历史记录。
  store.put('snapshots', snapshotId, snapshot);
  const slugLink = { slug, surveyId: survey.id, snapshotId, version };
  if (store.has('slugs', slug)) store.update('slugs', slug, slugLink);
  else store.put('slugs', slug, slugLink);
  const updated = store.update('surveys', survey.id, {
    title: draft.title,
    description: draft.description,
    questions: draft.questions,
    status: 'published',
    slug,
    version,
    activeSnapshotId: snapshotId,
    publishedAt,
    closedAt: null,
    updatedAt: publishedAt
  });
  return {
    status: 200,
    body: {
      survey: ownerSurvey(updated),
      slug,
      version,
      publicPath: `${ROUTE_PREFIX}/public/${slug}`
    }
  };
}

async function closeSurvey(ctx) {
  const surveyId = param(ctx, 'id');
  const { survey } = ownedSurvey(ctx, surveyId);
  if (survey.status === 'closed') {
    return { status: 200, body: { survey: ownerSurvey(survey) } };
  }
  const closedAt = nowIso();
  const updated = requireState().store.update('surveys', surveyId, {
    status: 'closed',
    closedAt,
    updatedAt: closedAt
  });
  return { status: 200, body: { survey: ownerSurvey(updated) } };
}

async function getPublicSurvey(ctx) {
  const slug = param(ctx, 'slug');
  const { survey, snapshot } = findPublic(slug);
  return { status: 200, body: { survey: publicSurvey(survey, snapshot) } };
}

async function submitResponse(ctx) {
  const slug = param(ctx, 'slug');
  const { survey, snapshot } = findPublic(slug);
  if (survey.status !== 'published') {
    fail('SURVEY_CLOSED', '问卷已关闭，不能继续填写', 409);
  }

  const rawAnswers = extractRawAnswers(ctx.body);
  const prepared = prepareAnswers(snapshot, rawAnswers);
  if (prepared.files.length > 0 && !requireState().attachmentsRoot) {
    fail('ATTACHMENT_STORAGE_NOT_CONFIGURED', '文件题需要配置 config.attachmentsDir 或 config.dataFile 才能保存附件', 409);
  }

  const responseId = newId('rsp');
  const submittedAt = nowIso();
  const answers = { ...prepared.answers };
  for (const file of prepared.files) {
    answers[file.questionId] = writeAttachment(survey, responseId, file);
  }

  const response = {
    id: responseId,
    surveyId: survey.id,
    ownerId: survey.ownerId,
    slug,
    version: snapshot.version,
    answers,
    submittedAt
  };
  requireState().store.put('responses', responseId, response);
  return {
    status: 201,
    body: {
      response: {
        id: response.id,
        surveyId: response.surveyId,
        version: response.version,
        submittedAt: response.submittedAt
      }
    }
  };
}

async function listResponses(ctx) {
  const { survey } = ownedSurvey(ctx, param(ctx, 'id'));
  const responses = responsesFor(survey.id).map((response) => ({
    id: response.id,
    surveyId: response.surveyId,
    ownerId: response.ownerId,
    version: response.version,
    submittedAt: response.submittedAt,
    answers: sanitizeAnswers(response.answers)
  }));
  return {
    status: 200,
    body: {
      surveyId: survey.id,
      ownerId: survey.ownerId,
      responseCount: responses.length,
      responses
    }
  };
}

async function getStats(ctx) {
  const { survey } = ownedSurvey(ctx, param(ctx, 'id'));
  return { status: 200, body: { stats: buildStats(survey) } };
}

async function exportCsv(ctx) {
  const { survey } = ownedSurvey(ctx, param(ctx, 'id'));
  const { csv } = buildCsv(survey);
  return {
    status: 200,
    body: csv,
    contentType: 'text/csv; charset=utf-8',
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="survey-${survey.id}.csv"`
    }
  };
}

async function downloadAttachment(ctx) {
  const { survey } = ownedSurvey(ctx, param(ctx, 'id'));
  const attachmentId = param(ctx, 'attachmentId');
  const found = findAttachment(survey.id, attachmentId);
  if (!found) fail(codes.NOT_FOUND, '附件不存在', 404);
  const absolute = resolveAttachmentPath(found.answer.storageKey);
  let buffer;
  try {
    buffer = fs.readFileSync(absolute);
  } catch {
    fail(codes.NOT_FOUND, '附件文件不存在', 404);
  }
  return {
    status: 200,
    body: {
      attachment: {
        attachmentId: found.answer.attachmentId,
        filename: found.answer.filename,
        contentType: found.answer.contentType,
        size: found.answer.size,
        responseId: found.response.id,
        questionId: found.questionId
      },
      dataBase64: buffer.toString('base64')
    }
  };
}

function normalizeResult(result) {
  if (!result || typeof result !== 'object') {
    fail('INTERNAL_ERROR', '处理器未返回有效结果', 500);
  }
  const output = { status: Number.isInteger(result.status) ? result.status : 200, body: result.body };
  if (result.contentType) output.contentType = result.contentType;
  if (result.headers) output.headers = result.headers;
  return output;
}

/** 统一捕获 CoreError 并映射为 {code,message}；不把内部异常细节暴露给调用方。 */
function wrap(fn) {
  return async function handler(ctx = {}) {
    try {
      requireState();
      return normalizeResult(await fn(ctx));
    } catch (err) {
      if (err instanceof CoreError) {
        return { status: err.status, body: { code: err.code, message: err.message } };
      }
      const logger = state && state.logger;
      if (logger && typeof logger.error === 'function') logger.error('[survey] handler error', err);
      return { status: 500, body: { code: 'INTERNAL_ERROR', message: '内部错误' } };
    }
  };
}

const routes = Object.freeze([
  { method: 'GET', path: `${ROUTE_PREFIX}/health`, handler: wrap(moduleHealth) },
  { method: 'POST', path: `${ROUTE_PREFIX}/surveys`, handler: wrap(createSurvey) },
  { method: 'GET', path: `${ROUTE_PREFIX}/surveys`, handler: wrap(listSurveys) },
  { method: 'GET', path: `${ROUTE_PREFIX}/surveys/:id`, handler: wrap(getSurvey) },
  { method: 'PATCH', path: `${ROUTE_PREFIX}/surveys/:id`, handler: wrap(updateSurvey) },
  { method: 'PUT', path: `${ROUTE_PREFIX}/surveys/:id`, handler: wrap(updateSurvey) },
  { method: 'POST', path: `${ROUTE_PREFIX}/surveys/:id/publish`, handler: wrap(publishSurvey) },
  { method: 'POST', path: `${ROUTE_PREFIX}/surveys/:id/close`, handler: wrap(closeSurvey) },
  { method: 'GET', path: `${ROUTE_PREFIX}/surveys/:id/responses`, handler: wrap(listResponses) },
  { method: 'GET', path: `${ROUTE_PREFIX}/surveys/:id/stats`, handler: wrap(getStats) },
  { method: 'GET', path: `${ROUTE_PREFIX}/surveys/:id/export.csv`, handler: wrap(exportCsv) },
  { method: 'GET', path: `${ROUTE_PREFIX}/surveys/:id/export`, handler: wrap(exportCsv) },
  { method: 'GET', path: `${ROUTE_PREFIX}/surveys/:id/attachments/:attachmentId`, handler: wrap(downloadAttachment) },
  { method: 'GET', path: `${ROUTE_PREFIX}/public/:slug`, handler: wrap(getPublicSurvey) },
  { method: 'POST', path: `${ROUTE_PREFIX}/public/:slug/responses`, handler: wrap(submitResponse) }
]);

function normalizeConfig(input) {
  const config = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  let dataFile = null;
  if (config.dataFile !== undefined && config.dataFile !== null && config.dataFile !== '') {
    if (typeof config.dataFile !== 'string' || !config.dataFile.trim()) {
      fail(codes.CONFIG_INVALID, 'config.dataFile 必须是非空字符串或 null', 500);
    }
    dataFile = path.resolve(config.dataFile.trim());
  }
  let maxAttachmentBytes = DEFAULT_MAX_ATTACHMENT_BYTES;
  if (config.maxAttachmentBytes !== undefined) {
    if (!Number.isInteger(config.maxAttachmentBytes)
      || config.maxAttachmentBytes < 1
      || config.maxAttachmentBytes > MAX_ATTACHMENT_BYTES_LIMIT) {
      fail(codes.CONFIG_INVALID, `config.maxAttachmentBytes 必须是 1-${MAX_ATTACHMENT_BYTES_LIMIT} 的整数`, 500);
    }
    maxAttachmentBytes = config.maxAttachmentBytes;
  }
  let attachmentsDir = null;
  if (config.attachmentsDir !== undefined && config.attachmentsDir !== null && config.attachmentsDir !== '') {
    if (typeof config.attachmentsDir !== 'string' || !config.attachmentsDir.trim()) {
      fail(codes.CONFIG_INVALID, 'config.attachmentsDir 必须是非空字符串', 500);
    }
    attachmentsDir = path.resolve(config.attachmentsDir.trim());
  }
  return { dataFile, maxAttachmentBytes, attachmentsDir };
}

async function start(options = {}) {
  const config = normalizeConfig(options.config);
  const logger = options.logger && typeof options.logger === 'object'
    ? options.logger
    : { info() {}, warn() {}, error() {} };
  let store;
  try {
    store = new JsonStore({ filePath: config.dataFile });
  } catch (err) {
    throw new CoreError(codes.CONFIG_INVALID, `Survey 数据文件无法加载：${err.message}`, { status: 500 });
  }
  state = {
    config,
    store,
    attachmentsRoot: config.attachmentsDir
      || (config.dataFile ? path.join(path.dirname(config.dataFile), 'attachments') : null),
    logger
  };
  if (typeof logger.info === 'function') {
    logger.info(`[survey] started (${config.dataFile ? `dataFile=${config.dataFile}` : 'memory-only'})`);
  }
}

async function stop() {
  if (state && typeof state.logger.info === 'function') state.logger.info('[survey] stopped');
  state = null;
}

async function health() {
  // 按统一模块接口返回固定形状；启动失败会在 start() 阶段抛出，不会进入 ready。
  return { ok: true };
}

module.exports = {
  start,
  stop,
  health,
  routes,
  tools: {}
};
