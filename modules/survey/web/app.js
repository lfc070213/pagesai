'use strict';
// PagesAI 问卷控制台：同源调用 /api/survey/*。
// 认证依赖核心会话 Cookie；公开填写页使用 #fill/<slug>，不读取 /api/me。
// 所有服务端文本都通过 textContent / value 写入，页面不使用 innerHTML。

const state = {
  user: null,
  surveys: [],
  current: null,
  filtered: null,
  stats: null,
  responses: null,
  fill: null,
  fillSlug: null,
  route: null,
  busy: false
};

const $ = (selector) => document.querySelector(selector);

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else if (key === 'value') node.value = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child !== null && child !== undefined && child !== false) node.append(child);
  }
  return node;
}

function showNotice(message, kind = 'error') {
  const node = $('#notice');
  if (!node) return;
  node.textContent = message || '';
  node.className = kind === 'ok' ? 'notice ok' : 'notice';
  node.hidden = !message;
}

async function api(method, path, body) {
  const options = { method, credentials: 'same-origin', headers: { accept: 'application/json' } };
  if (body !== undefined) {
    options.headers['content-type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  let data = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) {
    const error = new Error((data && data.message) || `请求失败（HTTP ${response.status}）`);
    error.status = response.status;
    error.code = data && data.code;
    throw error;
  }
  return data;
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function statusLabel(status) {
  return status === 'published' ? '已发布' : status === 'closed' ? '已关闭' : '草稿';
}

function publicLink(slug) {
  return `${location.origin}/survey#fill/${encodeURIComponent(slug)}`;
}

function randomId(prefix) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  }
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// 路由：控制台 or 公开填写
// ---------------------------------------------------------------------------

function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  if (hash.startsWith('fill/')) return { mode: 'fill', slug: decodeURIComponent(hash.slice(5)) };
  return { mode: 'console' };
}

async function route() {
  state.route = parseRoute();
  if (state.route.mode === 'fill') {
    $('#console').hidden = true;
    $('header.topbar').hidden = true;
    $('#fill-root').hidden = false;
    document.title = '填写问卷 · PagesAI';
    await loadFill(state.route.slug);
    return;
  }
  $('#console').hidden = false;
  $('header.topbar').hidden = false;
  $('#fill-root').hidden = true;
  document.title = '问卷 · PagesAI';
  await loadIdentity();
  await loadSurveys();
}

// ---------------------------------------------------------------------------
// 账号与列表
// ---------------------------------------------------------------------------

async function loadIdentity() {
  try {
    const data = await api('GET', '/api/me');
    state.user = data && data.user ? data.user : null;
    const label = [state.user && state.user.username, state.user && state.user.email].filter(Boolean).join(' · ');
    $('#account').textContent = label || '已登录';
  } catch (error) {
    state.user = null;
    $('#account').textContent = '未登录';
    if (error.status === 401 || error.status === 403) {
      showNotice('请先通过 PagesAI 登录，再打开问卷控制台。');
    } else {
      showNotice(error.message);
    }
  }
}

async function loadSurveys() {
  const status = $('#status-filter') ? $('#status-filter').value : '';
  try {
    const query = status ? `?status=${encodeURIComponent(status)}` : '';
    const data = await api('GET', `/api/survey/surveys${query}`);
    state.surveys = Array.isArray(data.surveys) ? data.surveys : [];
    renderList();
  } catch (error) {
    showNotice(error.message);
  }
}

function renderList() {
  const list = $('#survey-list');
  list.replaceChildren();
  const status = $('#status-filter').value;
  const items = state.surveys.filter((item) => !status || item.status === status);
  $('#list-empty').hidden = items.length > 0;
  for (const item of items) {
    const button = el('button', {
      type: 'button',
      class: state.current && state.current.id === item.id ? 'active' : '',
      onclick: () => openSurvey(item.id)
    }, [
      el('span', { class: 'item-title', text: item.title }),
      el('span', { class: 'item-meta' }, [
        el('span', { class: `badge ${item.status}`, text: statusLabel(item.status) }),
        el('span', { text: `${item.responseCount} 份 · ${formatTime(item.updatedAt)}` })
      ])
    ]);
    list.append(el('li', {}, button));
  }
}

async function openSurvey(surveyId) {
  try {
    const data = await api('GET', `/api/survey/surveys/${encodeURIComponent(surveyId)}`);
    state.current = data.survey;
    state.stats = null;
    state.responses = null;
    renderEditor();
    showView('editor');
    renderList();
    showNotice('');
  } catch (error) {
    showNotice(error.message);
  }
}

async function createSurvey() {
  try {
    const data = await api('POST', '/api/survey/surveys', {
      title: '未命名问卷',
      description: '',
      questions: [{
        type: 'single',
        title: '请选择',
        required: true,
        options: [{ label: '选项一' }, { label: '选项二' }]
      }]
    });
    state.current = data.survey;
    state.stats = null;
    state.responses = null;
    await loadSurveys();
    renderEditor();
    showView('editor');
    showNotice('已创建草稿，编辑后记得保存。', 'ok');
  } catch (error) {
    showNotice(error.message);
  }
}

// ---------------------------------------------------------------------------
// 编辑器
// ---------------------------------------------------------------------------

function showView(name) {
  for (const view of ['empty', 'editor', 'results']) {
    $(`#view-${view}`).hidden = view !== name;
  }
}

function renderEditor() {
  const survey = state.current;
  if (!survey) {
    showView('empty');
    return;
  }
  $('#editor-heading').textContent = survey.title || '编辑问卷';
  $('#editor-meta').textContent = `${statusLabel(survey.status)} · 版本 v${survey.version || 0} · ${survey.questionCount} 道题 · 更新于 ${formatTime(survey.updatedAt)}`;
  $('#survey-title').value = survey.title || '';
  $('#survey-description').value = survey.description || '';
  const container = $('#questions');
  container.replaceChildren();
  const questions = Array.isArray(survey.questions) ? survey.questions : [];
  questions.forEach((question, index) => container.append(renderQuestionEditor(question, index)));

  const box = $('#publish-box');
  if (survey.slug) {
    box.hidden = false;
    $('#publish-text').textContent = survey.status === 'closed'
      ? `问卷已关闭，公开链接只读。版本 v${survey.version}。`
      : `公开链接（匿名填写），版本 v${survey.version}。`;
    $('#public-link').value = publicLink(survey.slug);
  } else {
    box.hidden = true;
    $('#public-link').value = '';
  }
  $('#close-survey').disabled = survey.status === 'closed';
}

const TYPE_LABELS = { single: '单选', multiple: '多选', text: '文本', file: '文件' };

function renderQuestionEditor(question, index) {
  const card = el('div', { class: 'question', 'data-qid': question.id || randomId('q_') });
  const typeSelect = el('select', { class: 'q-type' }, Object.entries(TYPE_LABELS).map(([value, label]) =>
    el('option', { value, text: label, selected: question.type === value })));
  const required = el('input', { type: 'checkbox', class: 'q-required-box' });
  required.checked = question.required === true;

  card.append(el('div', { class: 'q-head' }, [
    el('span', { class: 'q-index', text: `第 ${index + 1} 题` }),
    typeSelect,
    el('label', { class: 'q-required' }, [required, el('span', { text: '必填' })]),
    el('span', { class: 'spacer' }),
    el('button', { type: 'button', class: 'secondary small', 'data-action': 'up', text: '上移' }),
    el('button', { type: 'button', class: 'secondary small', 'data-action': 'down', text: '下移' }),
    el('button', { type: 'button', class: 'danger small', 'data-action': 'remove-question', text: '删除' })
  ]));

  const title = el('input', { type: 'text', class: 'q-title', maxlength: '500', placeholder: '题目标题' });
  title.value = question.title || '';
  card.append(title);

  const desc = el('textarea', { class: 'q-desc', rows: '2', maxlength: '5000', placeholder: '题目说明（可选）' });
  desc.value = question.description || '';
  card.append(desc);

  const options = el('div', { class: 'options' });
  const rows = Array.isArray(question.options) ? question.options : [];
  for (const option of rows) options.append(renderOptionRow(option.label));
  card.append(options);
  card.append(el('button', { type: 'button', class: 'secondary small add-option', 'data-action': 'add-option', text: '+ 选项' }));

  const sync = () => {
    const choice = typeSelect.value === 'single' || typeSelect.value === 'multiple';
    options.hidden = !choice;
    card.querySelector('.add-option').hidden = !choice;
  };
  typeSelect.addEventListener('change', () => { sync(); state.dirty = true; });
  sync();
  return card;
}

function renderOptionRow(label) {
  const input = el('input', { type: 'text', maxlength: '500', placeholder: '选项文字' });
  input.value = label || '';
  return el('div', { class: 'option-row' }, [
    input,
    el('button', { type: 'button', class: 'secondary small', 'data-action': 'remove-option', text: '删除' })
  ]);
}

function readQuestions() {
  const cards = [...document.querySelectorAll('#questions .question')];
  if (cards.length === 0) throw new Error('问卷至少需要一道题');
  return cards.map((card, index) => {
    const type = card.querySelector('.q-type').value;
    const title = card.querySelector('.q-title').value.trim();
    if (!title) throw new Error(`第 ${index + 1} 题标题不能为空`);
    const description = card.querySelector('.q-desc').value.trim();
    const required = card.querySelector('.q-required-box').checked;
    const question = {
      id: card.getAttribute('data-qid') || randomId('q_'),
      type,
      title,
      description,
      required
    };
    if (type === 'single' || type === 'multiple') {
      const labels = [...card.querySelectorAll('.option-row input')]
        .map((input) => input.value.trim())
        .filter(Boolean);
      if (labels.length < 2) throw new Error(`第 ${index + 1} 题至少需要两个非空选项`);
      question.options = labels.map((label, optionIndex) => ({ id: `o${optionIndex + 1}`, label }));
    } else {
      question.options = [];
    }
    return question;
  });
}

async function saveSurvey({ silent = false } = {}) {
  if (!state.current) return null;
  const questions = readQuestions();
  const title = $('#survey-title').value.trim();
  if (!title) throw new Error('问卷标题不能为空');
  const body = { title, description: $('#survey-description').value.trim(), questions };
  const data = await api('PUT', `/api/survey/surveys/${encodeURIComponent(state.current.id)}`, body);
  state.current = data.survey;
  state.dirty = false;
  renderEditor();
  await loadSurveys();
  if (!silent) showNotice('草稿已保存。', 'ok');
  return data.survey;
}

async function publishSurvey() {
  if (!state.current) return;
  if (!confirm('发布后公开链接立即可用，确认发布当前版本？')) return;
  try {
    await saveSurvey({ silent: true });
    const data = await api('POST', `/api/survey/surveys/${encodeURIComponent(state.current.id)}/publish`);
    state.current = data.survey;
    renderEditor();
    await loadSurveys();
    renderList();
    showNotice(`已发布版本 v${data.version}，公开链接已生成。`, 'ok');
  } catch (error) {
    showNotice(error.message);
  }
}

async function closeSurvey() {
  if (!state.current) return;
  if (!confirm('关闭后公开链接不能继续提交答卷，确认关闭？')) return;
  try {
    const data = await api('POST', `/api/survey/surveys/${encodeURIComponent(state.current.id)}/close`);
    state.current = data.survey;
    renderEditor();
    await loadSurveys();
    renderList();
    showNotice('问卷已关闭。', 'ok');
  } catch (error) {
    showNotice(error.message);
  }
}

async function copyPublicLink() {
  const field = $('#public-link');
  if (!field.value) return;
  try {
    await navigator.clipboard.writeText(field.value);
    showNotice('公开链接已复制。', 'ok');
  } catch {
    field.select();
    showNotice('请手动复制已选中的公开链接。', 'ok');
  }
}

// ---------------------------------------------------------------------------
// 预览
// ---------------------------------------------------------------------------

function renderQuestionView(question, index) {
  const block = el('div', { class: 'fill-question' });
  const heading = el('h3', {}, [el('span', { text: `${index + 1}. ${question.title}` })]);
  if (question.required) heading.append(el('span', { class: 'required-mark', text: '*' }));
  block.append(heading);
  if (question.description) block.append(el('p', { class: 'q-desc-text', text: question.description }));

  if (question.type === 'single' || question.type === 'multiple') {
    for (const option of question.options || []) {
      const input = el('input', {
        type: question.type === 'single' ? 'radio' : 'checkbox',
        name: `preview_${index}`,
        disabled: true
      });
      block.append(el('label', { class: 'choice' }, [input, el('span', { text: option.label })]));
    }
  } else if (question.type === 'file') {
    block.append(el('input', { type: 'file', disabled: true }));
  } else {
    block.append(el('textarea', { rows: '3', placeholder: '填写者在此输入', disabled: true }));
  }
  return block;
}

function previewSurvey() {
  try {
    const questions = readQuestions();
    $('#preview-title').textContent = $('#survey-title').value.trim() || '未命名问卷';
    $('#preview-description').textContent = $('#survey-description').value.trim();
    const body = $('#preview-body');
    body.replaceChildren(...questions.map(renderQuestionView));
    $('#preview').hidden = false;
  } catch (error) {
    showNotice(error.message);
  }
}

// ---------------------------------------------------------------------------
// 答卷与统计
// ---------------------------------------------------------------------------

async function openResults() {
  if (!state.current) return;
  try {
    if (state.dirty) await saveSurvey({ silent: true });
    const id = encodeURIComponent(state.current.id);
    const [statsData, responsesData] = await Promise.all([
      api('GET', `/api/survey/surveys/${id}/stats`),
      api('GET', `/api/survey/surveys/${id}/responses`)
    ]);
    state.stats = statsData.stats;
    state.responses = responsesData;
    renderResults();
    showView('results');
    showNotice('');
  } catch (error) {
    showNotice(error.message);
  }
}

function renderResults() {
  const stats = state.stats;
  const responses = state.responses;
  if (!stats) return;
  $('#results-meta').textContent = `${state.current.title} · 共 ${stats.responseCount} 份答卷 · 统计口径 v${stats.version || '—'}`;
  const pane = $('#stats-pane');
  pane.replaceChildren();
  if (stats.responseCount === 0) {
    pane.append(el('p', { class: 'empty', text: '还没有答卷。发布并分享公开链接后，答卷会显示在这里。' }));
  }
  for (const question of stats.questions) {
    const card = el('div', { class: 'stat-card' });
    card.append(el('h3', { text: question.title }));
    card.append(el('p', {
      class: 'stat-meta',
      text: `${TYPE_LABELS[question.type] || question.type} · 已答 ${question.answered} / ${stats.responseCount}（${question.answeredPercentage}%）`
    }));
    if (question.type === 'single' || question.type === 'multiple') {
      for (const option of question.options || []) {
        const bar = el('span');
        bar.style.width = `${Math.max(0, Math.min(100, option.answeredPercentage))}%`;
        card.append(el('div', { class: 'stat-row' }, [
          el('div', { class: 'stat-label' }, [
            el('span', { text: option.label }),
            el('span', { class: 'muted', text: `${option.count} 份 · ${option.answeredPercentage}%` })
          ]),
          el('div', { class: 'stat-bar' }, bar)
        ]));
      }
    }
    pane.append(card);
  }

  const list = $('#responses-pane');
  list.replaceChildren();
  if (!responses || !Array.isArray(responses.responses) || responses.responses.length === 0) {
    list.append(el('p', { class: 'empty', text: '暂无答卷。' }));
    return;
  }
  const questionMap = new Map(stats.questions.map((question) => [question.id, question]));
  for (const response of responses.responses.slice().reverse()) {
    const card = el('div', { class: 'response-card' });
    card.append(el('div', { class: 'response-head' }, [
      el('strong', { text: `答卷 ${response.id.slice(-8)}` }),
      el('span', { class: 'muted', text: `${formatTime(response.submittedAt)} · v${response.version}` })
    ]));
    const answers = el('div', { class: 'response-answers' });
    for (const [questionId, value] of Object.entries(response.answers || {})) {
      const question = questionMap.get(questionId);
      if (!question) continue;
      answers.append(renderAnswer(question, value));
    }
    if (answers.childElementCount === 0) answers.append(el('p', { class: 'muted', text: '（无作答内容）' }));
    card.append(answers);
    list.append(card);
  }
}

function answerText(question, value) {
  if (question.type === 'single') {
    const option = (question.options || []).find((item) => item.id === value);
    return option ? option.label : String(value);
  }
  if (question.type === 'multiple') {
    return (Array.isArray(value) ? value : [])
      .map((id) => {
        const option = (question.options || []).find((item) => item.id === id);
        return option ? option.label : id;
      })
      .join('；');
  }
  return String(value);
}

function renderAnswer(question, value) {
  const row = el('div', { class: 'answer-row' });
  row.append(el('div', { class: 'answer-q', text: question.title }));
  if (question.type === 'file' && value && typeof value === 'object') {
    row.append(el('button', {
      type: 'button',
      class: 'secondary small',
      text: `下载附件：${value.filename || '附件'}`,
      onclick: () => downloadAttachment(state.current.id, value.attachmentId, value.filename)
    }));
    return row;
  }
  row.append(el('div', { class: question.type === 'text' ? 'answer-v mono' : 'answer-v', text: answerText(question, value) }));
  return row;
}

async function downloadAttachment(surveyId, attachmentId, filename) {
  try {
    const data = await api('GET', `/api/survey/surveys/${encodeURIComponent(surveyId)}/attachments/${encodeURIComponent(attachmentId)}`);
    const binary = atob(data.dataBase64 || '');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: (data.attachment && data.attachment.contentType) || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const anchor = el('a', { href: url, download: filename || (data.attachment && data.attachment.filename) || 'attachment' });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (error) {
    showNotice(error.message);
  }
}

async function exportCsv() {
  if (!state.current) return;
  try {
    const response = await fetch(`/api/survey/surveys/${encodeURIComponent(state.current.id)}/export.csv`, {
      credentials: 'same-origin',
      headers: { accept: 'text/csv' }
    });
    if (!response.ok) {
      let message = `导出失败（HTTP ${response.status}）`;
      try {
        const data = await response.json();
        if (data && data.message) message = data.message;
      } catch { /* 非 JSON 错误体 */ }
      throw new Error(message);
    }
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') || '';
    const match = /filename="?([^";]+)"?/.exec(disposition);
    const filename = match ? match[1] : `survey-${state.current.id}.csv`;
    const url = URL.createObjectURL(blob);
    const anchor = el('a', { href: url, download: filename });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showNotice('CSV 已开始下载。', 'ok');
  } catch (error) {
    showNotice(error.message);
  }
}

// ---------------------------------------------------------------------------
// 公开填写页
// ---------------------------------------------------------------------------

async function loadFill(slug) {
  state.fillSlug = slug;
  $('#fill-form').replaceChildren();
  $('#fill-error').hidden = true;
  $('#fill-done').hidden = true;
  $('#fill-form').hidden = false;
  $('#fill-submit').hidden = false;
  $('#fill-title').textContent = '正在加载…';
  $('#fill-description').textContent = '';
  $('#fill-status').hidden = true;
  try {
    const data = await api('GET', `/api/survey/public/${encodeURIComponent(slug)}`);
    state.fill = data.survey;
    renderFill();
  } catch (error) {
    $('#fill-title').textContent = '无法打开问卷';
    $('#fill-description').textContent = error.status === 404 ? '链接不存在或问卷尚未发布。' : error.message;
    $('#fill-submit').hidden = true;
  }
}

function renderFill() {
  const survey = state.fill;
  document.title = `${survey.title} · PagesAI`;
  $('#fill-title').textContent = survey.title;
  $('#fill-description').textContent = survey.description || '';
  const status = $('#fill-status');
  if (!survey.acceptingResponses) {
    status.hidden = false;
    status.textContent = survey.closed ? '问卷已关闭，不能继续提交。' : '问卷当前不接受答卷。';
    $('#fill-submit').hidden = true;
  } else {
    status.hidden = true;
    $('#fill-submit').hidden = false;
  }
  const form = $('#fill-form');
  form.replaceChildren();
  survey.questions.forEach((question, index) => {
    const block = el('div', { class: 'fill-question', 'data-qid': question.id });
    const heading = el('h3', {}, [el('span', { text: `${index + 1}. ${question.title}` })]);
    if (question.required) heading.append(el('span', { class: 'required-mark', text: '*' }));
    block.append(heading);
    if (question.description) block.append(el('p', { class: 'q-desc-text', text: question.description }));

    if (question.type === 'single' || question.type === 'multiple') {
      for (const option of question.options || []) {
        const input = el('input', {
          type: question.type === 'single' ? 'radio' : 'checkbox',
          name: `q_${question.id}`,
          value: option.id,
          disabled: !survey.acceptingResponses
        });
        block.append(el('label', { class: 'choice' }, [input, el('span', { text: option.label })]));
      }
    } else if (question.type === 'file') {
      const input = el('input', { type: 'file', 'data-file': question.id });
      input.disabled = !survey.acceptingResponses;
      block.append(input);
    } else {
      const textarea = el('textarea', { rows: '4', 'data-text': question.id, maxlength: '20000', placeholder: '在此输入' });
      textarea.disabled = !survey.acceptingResponses;
      block.append(textarea);
    }
    form.append(block);
  });
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`读取文件失败：${file.name}`));
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

async function collectFillAnswers() {
  const survey = state.fill;
  const answers = {};
  for (const question of survey.questions) {
    if (question.type === 'single') {
      const checked = document.querySelector(`input[name="q_${question.id}"]:checked`);
      if (!checked) {
        if (question.required) throw new Error(`请回答第「${question.title}」题`);
        continue;
      }
      answers[question.id] = checked.value;
    } else if (question.type === 'multiple') {
      const checked = [...document.querySelectorAll(`input[name="q_${question.id}"]:checked`)].map((input) => input.value);
      if (checked.length === 0) {
        if (question.required) throw new Error(`请回答第「${question.title}」题`);
        continue;
      }
      answers[question.id] = checked;
    } else if (question.type === 'file') {
      const input = document.querySelector(`input[data-file="${CSS.escape(question.id)}"]`);
      const file = input && input.files ? input.files[0] : null;
      if (!file) {
        if (question.required) throw new Error(`请上传第「${question.title}」题的附件`);
        continue;
      }
      answers[question.id] = {
        filename: file.name,
        contentType: file.type || 'application/octet-stream',
        dataBase64: await readFileAsBase64(file)
      };
    } else {
      const textarea = document.querySelector(`textarea[data-text="${CSS.escape(question.id)}"]`);
      const value = textarea ? textarea.value : '';
      if (!value.trim()) {
        if (question.required) throw new Error(`请回答第「${question.title}」题`);
        continue;
      }
      answers[question.id] = value;
    }
  }
  return answers;
}

async function submitFill(event) {
  if (event) event.preventDefault();
  if (state.busy || !state.fill) return;
  const errorNode = $('#fill-error');
  errorNode.hidden = true;
  const button = $('#fill-submit');
  state.busy = true;
  button.disabled = true;
  button.textContent = '提交中…';
  try {
    const answers = await collectFillAnswers();
    await api('POST', `/api/survey/public/${encodeURIComponent(state.fillSlug)}/responses`, { answers });
    $('#fill-form').hidden = true;
    $('#fill-submit').hidden = true;
    $('#fill-done').hidden = false;
  } catch (error) {
    errorNode.textContent = error.message;
    errorNode.hidden = false;
  } finally {
    state.busy = false;
    button.disabled = false;
    button.textContent = '提交';
  }
}

function fillAgain() {
  $('#fill-done').hidden = true;
  $('#fill-form').hidden = false;
  $('#fill-submit').hidden = false;
  renderFill();
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------

function bind() {
  $('#refresh').addEventListener('click', () => { loadSurveys(); });
  $('#create-survey').addEventListener('click', createSurvey);
  $('#status-filter').addEventListener('change', () => { loadSurveys(); });
  $('#save-survey').addEventListener('click', () => { saveSurvey().catch((error) => showNotice(error.message)); });
  $('#preview-survey').addEventListener('click', previewSurvey);
  $('#preview-close').addEventListener('click', () => { $('#preview').hidden = true; });
  $('#preview').addEventListener('click', (event) => { if (event.target === $('#preview')) $('#preview').hidden = true; });
  $('#publish-survey').addEventListener('click', publishSurvey);
  $('#close-survey').addEventListener('click', closeSurvey);
  $('#copy-link').addEventListener('click', copyPublicLink);
  $('#open-results').addEventListener('click', openResults);
  $('#back-editor').addEventListener('click', () => { showView('editor'); });
  $('#export-csv').addEventListener('click', exportCsv);
  $('#tab-stats').addEventListener('click', () => switchTab('stats'));
  $('#tab-responses').addEventListener('click', () => switchTab('responses'));
  $('#fill-form').addEventListener('submit', submitFill);
  $('#fill-submit').addEventListener('click', submitFill);
  $('#fill-again').addEventListener('click', fillAgain);
  window.addEventListener('hashchange', () => { route().catch((error) => showNotice(error.message)); });

  $('#survey-title').addEventListener('input', () => { state.dirty = true; });
  $('#survey-description').addEventListener('input', () => { state.dirty = true; });

  for (const button of document.querySelectorAll('[data-add]')) {
    button.addEventListener('click', () => addQuestion(button.getAttribute('data-add')));
  }

  const container = $('#questions');
  container.addEventListener('input', () => { state.dirty = true; });
  container.addEventListener('change', () => { state.dirty = true; });
  container.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const action = button.getAttribute('data-action');
    const card = button.closest('.question');
    if (!card) return;
    if (action === 'remove-question') {
      card.remove();
      renumberQuestions();
    } else if (action === 'add-option') {
      card.querySelector('.options').append(renderOptionRow(''));
    } else if (action === 'remove-option') {
      button.closest('.option-row').remove();
    } else if (action === 'up' || action === 'down') {
      const sibling = action === 'up' ? card.previousElementSibling : card.nextElementSibling;
      if (sibling) {
        if (action === 'up') card.parentNode.insertBefore(card, sibling);
        else card.parentNode.insertBefore(sibling, card);
        renumberQuestions();
      }
    }
    state.dirty = true;
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#preview').hidden) $('#preview').hidden = true;
  });
}

function renumberQuestions() {
  [...document.querySelectorAll('#questions .question')].forEach((card, index) => {
    const label = card.querySelector('.q-index');
    if (label) label.textContent = `第 ${index + 1} 题`;
  });
}

function addQuestion(type) {
  const question = {
    id: randomId('q_'),
    type,
    title: '',
    description: '',
    required: false,
    options: type === 'single' || type === 'multiple'
      ? [{ id: 'o1', label: '选项一' }, { id: 'o2', label: '选项二' }]
      : []
  };
  const container = $('#questions');
  container.append(renderQuestionEditor(question, container.childElementCount));
  state.dirty = true;
  container.lastElementChild.querySelector('.q-title').focus();
}

function switchTab(name) {
  $('#tab-stats').classList.toggle('active', name === 'stats');
  $('#tab-responses').classList.toggle('active', name === 'responses');
  $('#stats-pane').hidden = name !== 'stats';
  $('#responses-pane').hidden = name !== 'responses';
}

state.dirty = false;
bind();
route().catch((error) => showNotice(error.message));
