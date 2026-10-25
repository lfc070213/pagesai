'use strict';
// PagesAI Paper 控制台：同源调用 /api/paper/*。
// 认证依赖核心会话 Cookie；页面不含任何服务端文本之外的注入点，
// 所有服务端内容都通过 textContent / value 写入，不使用 innerHTML。

const MAX_UPLOAD_BYTES = 128 * 1024 * 1024;
const POLL_INTERVAL_MS = 600;

const state = {
  user: null,
  docs: [],
  doc: null,
  docId: null,
  job: null,
  translations: {},
  view: 'aligned',
  translateLang: 'zh',
  loadToken: 0,
  pollTimer: null,
  busy: false,
  selectedSid: null,
  menuSid: null,
  pdfOpen: false
};

const $ = (selector) => document.querySelector(selector);

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
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
    error.details = data && data.details;
    throw error;
  }
  return data;
}

function formatBytes(value) {
  const size = Number(value) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function docPath(id, suffix = '') {
  return `/api/paper/docs/${encodeURIComponent(id)}${suffix}`;
}

function jobStatusLabel(status) {
  switch (status) {
    case 'running': return '翻译中';
    case 'done': return '翻译完成';
    case 'stopped': return '已停止（可继续）';
    case 'interrupted': return '已中断（可继续）';
    case 'failed': return '翻译失败';
    default: return '未翻译';
  }
}

function canResume(job) {
  return job && (job.status === 'stopped' || job.status === 'interrupted');
}

// ---------------------------------------------------------------------------
// 路由与列表
// ---------------------------------------------------------------------------

function parseRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  if (hash.startsWith('doc/')) {
    const id = decodeURIComponent(hash.slice(4));
    if (/^[A-Za-z0-9_-]{1,64}$/.test(id)) return { mode: 'doc', id };
  }
  return { mode: 'home' };
}

async function route() {
  const target = parseRoute();
  await loadIdentity();
  const loaded = await loadDocs();
  if (!loaded) return;
  if (target.mode === 'doc') {
    await openDoc(target.id);
  } else {
    showHome();
  }
}

async function loadIdentity() {
  try {
    const data = await api('GET', '/api/me');
    state.user = data && data.user ? data.user : null;
    const label = [state.user && state.user.username, state.user && state.user.email].filter(Boolean).join(' · ');
    $('#account').textContent = label || '已登录';
  } catch {
    state.user = null;
    $('#account').textContent = '未登录或会话已过期';
  }
}

async function loadDocs() {
  try {
    const data = await api('GET', '/api/paper/docs');
    state.docs = Array.isArray(data && data.docs) ? data.docs : [];
    renderList();
    return true;
  } catch (error) {
    state.docs = [];
    renderList();
    showNotice(error.status === 403 ? '请先登录，再使用 Paper。' : error.message);
    return false;
  }
}

function renderList() {
  const list = $('#doc-list');
  list.textContent = '';
  $('#list-empty').hidden = state.docs.length > 0;
  for (const doc of state.docs) {
    const item = el('button', {
      type: 'button',
      class: `doc-item${doc.id === state.docId ? ' active' : ''}`,
      title: doc.filename,
      onclick: () => { location.hash = `#doc/${encodeURIComponent(doc.id)}`; }
    }, [
      el('span', { class: 'name', text: doc.title || doc.filename }),
      el('span', { class: 'meta' }, [
        el('span', { text: doc.kind === 'pdf' ? 'PDF' : '文本' }),
        el('span', { text: `${doc.pageCount || 1} 页` }),
        el('span', { text: `${doc.segmentCount || 0} 句` }),
        doc.kind === 'pdf' && !doc.fileAvailable ? el('span', { class: 'pill', text: '原件未落盘' }) : null
      ])
    ]);
    list.append(item);
  }
}

function showHome() {
  state.loadToken += 1;
  stopPolling();
  state.doc = null;
  state.docId = null;
  state.job = null;
  state.translations = {};
  state.selectedSid = null;
  state.pdfOpen = false;
  $('#doc-view').hidden = true;
  $('#welcome').hidden = false;
  renderList();
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}

// ---------------------------------------------------------------------------
// 文档视图
// ---------------------------------------------------------------------------

async function openDoc(id) {
  const token = ++state.loadToken;
  stopPolling();
  try {
    const overview = await api('GET', docPath(id));
    if (token !== state.loadToken) return;
    state.doc = overview.doc;
    state.docId = overview.doc.id;
    state.view = state.view || 'aligned';
    state.pdfOpen = false;
    state.translations = {};
    state.selectedSid = null;

    const lang = overview.translation && overview.translation.targetLang;
    if (lang && [...$('#translate-lang').options].some((option) => option.value === lang)) {
      state.translateLang = lang;
      $('#translate-lang').value = lang;
    }

    applyJob(overview.translation);
    renderDocHead();
    renderReader();
    resetAsk();
    $('#welcome').hidden = true;
    $('#doc-view').hidden = false;
    renderList();
    $('#pdf-panel').hidden = true;
    $('#pdf-frame').removeAttribute('src');

    await loadTranslation(id, state.translateLang, token);
    if (token !== state.loadToken) return;
    if (state.job && state.job.status === 'running') startPolling(id, state.translateLang, token);
  } catch (error) {
    if (token !== state.loadToken) return;
    showNotice(error.status === 404 ? '论文不存在或已删除。' : error.message);
    showHome();
  }
}

async function loadTranslation(id, lang, token) {
  try {
    const data = await api('GET', `${docPath(id, '/translate')}?targetLang=${encodeURIComponent(lang)}&include=text`);
    if (token !== state.loadToken) return;
    applyJob(data.job);
    state.translations = data.translations && typeof data.translations === 'object' ? data.translations : {};
    renderReader();
  } catch (error) {
    if (token !== state.loadToken) return;
    if (error.status !== 404) showNotice(error.message);
  }
}

function renderDocHead() {
  const doc = state.doc;
  if (!doc) return;
  $('#doc-title').textContent = doc.title || doc.filename;
  const parts = [
    doc.filename,
    doc.kind === 'pdf' ? 'PDF' : '文本',
    `${doc.pageCount || 1} 页`,
    `${doc.segmentCount || 0} 句`,
    `${doc.charCount || 0} 字符`,
    formatBytes(doc.sizeBytes),
    `上传于 ${formatTime(doc.createdAt)}`
  ];
  $('#doc-meta').textContent = parts.join(' · ');

  const download = $('#download-original');
  download.href = docPath(doc.id, '/file');
  download.download = doc.filename;
  if (doc.fileAvailable) {
    download.classList.remove('disabled');
    download.removeAttribute('aria-disabled');
    download.removeAttribute('title');
  } else {
    download.classList.add('disabled');
    download.setAttribute('aria-disabled', 'true');
    download.title = '原件未落盘（未配置 uploadsDir），无法下载';
  }

  const pdfToggle = $('#toggle-pdf');
  pdfToggle.hidden = !(doc.kind === 'pdf' && doc.fileAvailable);
  pdfToggle.textContent = state.pdfOpen ? '收起 PDF' : 'PDF 原件';
}

function applyJob(job) {
  state.job = job || null;
  renderJob();
  renderTranslateControls();
}

function renderJob() {
  const job = state.job;
  const status = job ? job.status : 'idle';
  const badge = $('#job-status');
  badge.className = `job-status ${status}`;
  badge.textContent = jobStatusLabel(status);

  const total = job ? Number(job.total) || 0 : 0;
  const done = job ? Number(job.done) || 0 : 0;
  const percent = job ? Number(job.percent) || 0 : 0;
  const progress = Math.max(0, Math.min(100, percent));

  let detail;
  if (status === 'running') detail = `${done}/${total} 句 · ${progress}%`;
  else if (status === 'done') detail = `${total} 句全部完成`;
  else if (status === 'stopped' || status === 'interrupted') detail = `${done}/${total} 句已保留，可继续`;
  else if (status === 'failed') detail = `${done}/${total} 句`;
  else detail = `共 ${total} 句 · 目标语言 ${job && job.targetLang ? job.targetLang : state.translateLang}`;
  $('#job-percent').textContent = detail;

  const bar = $('#job-bar');
  bar.style.width = `${progress}%`;
  const role = $('#job-progress');
  role.setAttribute('aria-valuenow', String(progress));

  const error = $('#job-error');
  const panel = $('.job-panel');
  const message = job && job.error && status !== 'done' ? job.error : '';
  error.textContent = message;
  error.hidden = !message;
  panel.classList.toggle('error', Boolean(message) || status === 'failed');
}

function renderTranslateControls() {
  const status = state.job ? state.job.status : 'idle';
  const start = $('#translate-start');
  const stop = $('#translate-stop');
  const del = $('#delete-doc');
  start.hidden = status === 'running';
  stop.hidden = status !== 'running';
  start.textContent = status === 'done' ? '重新翻译' : (canResume(state.job) ? '继续翻译' : '开始翻译');
  start.disabled = state.busy;
  stop.disabled = state.busy;
  del.disabled = status === 'running';
  del.title = status === 'running' ? '翻译进行中，停止后再删除' : '';
}

function missingLabel() {
  const status = state.job ? state.job.status : 'idle';
  if (status === 'running') return '翻译中…';
  if (status === 'done') return '（无译文）';
  return '—';
}

function renderReader() {
  const doc = state.doc;
  if (!doc) return;
  const reader = $('#reader');
  reader.dataset.view = state.view;
  for (const button of document.querySelectorAll('.view-switch button')) {
    button.classList.toggle('active', button.dataset.view === state.view);
  }

  const container = $('#reader-body');
  const scrollTop = reader.scrollTop;
  container.textContent = '';
  const fragment = document.createDocumentFragment();

  for (const block of doc.blocks || []) {
    fragment.append(el('div', {
      class: 'block-head',
      text: `第 ${block.page || 1} 页 · 段落 ${Number(block.index) + 1}`
    }));
    for (const segment of block.segments || []) {
      const translated = state.translations && Object.prototype.hasOwnProperty.call(state.translations, segment.sid)
        ? state.translations[segment.sid]
        : null;
      const original = el('div', {
        class: 'seg original',
        'data-sid': segment.sid,
        role: 'button',
        tabindex: '0',
        title: '点击定位，右键提问',
        text: segment.text
      });
      const translation = el('div', {
        class: `seg translation${translated ? '' : ' missing'}`,
        'data-sid': segment.sid,
        text: translated || missingLabel()
      });
      original.addEventListener('click', () => selectSid(segment.sid));
      original.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectSid(segment.sid); }
      });
      translation.addEventListener('click', () => selectSid(segment.sid));
      for (const node of [original, translation]) {
        node.addEventListener('contextmenu', (event) => {
          event.preventDefault();
          openContextMenu(event.clientX, event.clientY, segment.sid);
        });
      }
      fragment.append(original, translation);
    }
  }
  container.append(fragment);
  reader.scrollTop = scrollTop;
  if (state.selectedSid) highlightSid(state.selectedSid);
}

function selectSid(sid, { flash = false, scroll = false } = {}) {
  state.selectedSid = sid;
  highlightSid(sid, flash);
  if (scroll) {
    const node = document.querySelector(`.seg.original[data-sid="${cssEscape(sid)}"]`)
      || document.querySelector(`.seg[data-sid="${cssEscape(sid)}"]`);
    if (node) node.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function highlightSid(sid, flash = false) {
  const nodes = document.querySelectorAll('.seg.selected');
  for (const node of nodes) node.classList.remove('selected');
  const matches = document.querySelectorAll(`.seg[data-sid="${cssEscape(sid)}"]`);
  for (const node of matches) {
    node.classList.add('selected');
    if (flash) {
      node.classList.add('flash');
      setTimeout(() => node.classList.remove('flash'), 1200);
    }
  }
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(value));
  return String(value).replace(/["\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// 翻译任务
// ---------------------------------------------------------------------------

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function startPolling(id, lang, token) {
  stopPolling();
  state.pollTimer = setInterval(async () => {
    if (token !== state.loadToken || id !== state.docId) { stopPolling(); return; }
    try {
      const data = await api('GET', `${docPath(id, '/translate')}?targetLang=${encodeURIComponent(lang)}&include=text`);
      if (token !== state.loadToken || id !== state.docId) { stopPolling(); return; }
      applyJob(data.job);
      if (data.translations && typeof data.translations === 'object') {
        const changed = Object.keys(data.translations).length !== Object.keys(state.translations).length;
        state.translations = data.translations;
        if (changed) renderReader();
      }
      if (!data.job || data.job.status !== 'running') stopPolling();
    } catch {
      stopPolling();
    }
  }, POLL_INTERVAL_MS);
}

async function startTranslate() {
  if (!state.doc) return;
  const id = state.doc.id;
  const lang = $('#translate-lang').value;
  state.translateLang = lang;
  const restart = state.job && state.job.status === 'done';
  if (restart && !window.confirm('重新翻译会覆盖已有译文，确定继续？')) return;

  const token = ++state.loadToken;
  state.busy = true;
  renderTranslateControls();
  showNotice('');
  const pending = api('POST', docPath(id, '/translate'), { targetLang: lang, restart });
  startPolling(id, lang, token);
  try {
    const out = await pending;
    if (token !== state.loadToken) return;
    applyJob(out.job);
    await loadTranslation(id, lang, token);
  } catch (error) {
    if (token !== state.loadToken) return;
    if (error.details && error.details.job) applyJob(error.details.job);
    if (error.code === 'paper.translate_not_configured') {
      showNotice('翻译适配器尚未配置（config.translateAdapter），请联系管理员在模块配置中填写。');
    } else if (error.code === 'paper.translate_in_progress') {
      showNotice('该论文的翻译任务已在运行，请稍候或先停止。');
    } else {
      showNotice(`翻译未完成：${error.message}`);
      await loadTranslation(id, lang, token);
    }
  } finally {
    if (token === state.loadToken) {
      state.busy = false;
      stopPolling();
      renderTranslateControls();
    }
  }
}

async function stopTranslate() {
  if (!state.doc) return;
  const id = state.doc.id;
  state.busy = true;
  renderTranslateControls();
  try {
    const out = await api('POST', docPath(id, '/translate/stop'), { targetLang: state.translateLang });
    applyJob(out.job);
    if (!out.stopped) await loadTranslation(id, state.translateLang, state.loadToken);
    else showNotice('已请求停止，当前批次结束后保留已完成的译文。', 'ok');
  } catch (error) {
    showNotice(error.message);
  } finally {
    state.busy = false;
    renderTranslateControls();
  }
}

async function changeLanguage() {
  if (!state.doc) return;
  const lang = $('#translate-lang').value;
  state.translateLang = lang;
  stopPolling();
  const token = ++state.loadToken;
  state.translations = {};
  renderReader();
  await loadTranslation(state.doc.id, lang, token);
  if (token === state.loadToken && state.job && state.job.status === 'running') startPolling(state.doc.id, lang, token);
}

// ---------------------------------------------------------------------------
// PDF 原件
// ---------------------------------------------------------------------------

function togglePdf() {
  if (!state.doc || state.doc.kind !== 'pdf' || !state.doc.fileAvailable) return;
  state.pdfOpen = !state.pdfOpen;
  const panel = $('#pdf-panel');
  panel.hidden = !state.pdfOpen;
  if (state.pdfOpen) {
    const src = `${docPath(state.doc.id, '/file')}?inline=1`;
    $('#pdf-frame').src = src;
    $('#pdf-new-tab').href = src;
    $('#pdf-note').textContent = '原件通过同源鉴权读取；浏览器不支持内嵌 PDF 时可新标签打开。';
  } else {
    $('#pdf-frame').removeAttribute('src');
  }
  $('#toggle-pdf').textContent = state.pdfOpen ? '收起 PDF' : 'PDF 原件';
}

// ---------------------------------------------------------------------------
// 问答
// ---------------------------------------------------------------------------

function resetAsk() {
  $('#ask-input').value = '';
  $('#ask-result').hidden = true;
  $('#ask-answer').textContent = '';
  $('#ask-degraded').hidden = true;
  $('#ask-citations').textContent = '';
}

async function ask(event) {
  if (event) event.preventDefault();
  if (!state.doc || state.busy) return;
  const question = $('#ask-input').value.trim();
  if (!question) { showNotice('请输入问题。'); return; }
  state.busy = true;
  $('#ask-submit').disabled = true;
  showNotice('');
  try {
    const out = await api('POST', docPath(state.doc.id, '/ask'), { question });
    $('#ask-answer').textContent = out.answer;
    $('#ask-result').hidden = false;

    const notes = [];
    if (out.degraded && out.degraded.message) notes.push(out.degraded.message);
    if (out.search && out.search.configured === false) notes.push('检索适配器未配置，已使用本地关键词检索。');
    if (out.citationsIgnored) notes.push(`已忽略 ${out.citationsIgnored} 条无法定位的引用。`);
    const degraded = $('#ask-degraded');
    degraded.textContent = notes.join(' ');
    degraded.hidden = notes.length === 0;

    const list = $('#ask-citations');
    list.textContent = '';
    for (const citation of out.citations || []) {
      const item = el('li', {
        role: 'button',
        tabindex: '0',
        title: '定位到原文',
        onclick: () => selectSid(citation.sid, { flash: true, scroll: true }),
        onkeydown: (keyEvent) => {
          if (keyEvent.key === 'Enter' || keyEvent.key === ' ') {
            keyEvent.preventDefault();
            selectSid(citation.sid, { flash: true, scroll: true });
          }
        }
      }, [
        el('span', { text: citation.text }),
        el('span', { class: 'cite-meta', text: `第 ${citation.page} 页 · 句 ${citation.sid}` })
      ]);
      list.append(item);
    }
    if (!(out.citations || []).length) {
      list.append(el('li', { class: 'hint', text: '本次回答没有可定位的引用。' }));
    }
  } catch (error) {
    if (error.code === 'paper.qa_not_configured') {
      showNotice('问答适配器尚未配置（config.qaAdapter），请联系管理员在模块配置中填写。');
    } else {
      showNotice(`提问失败：${error.message}`);
    }
  } finally {
    state.busy = false;
    $('#ask-submit').disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 上传与删除
// ---------------------------------------------------------------------------

async function uploadFile(file) {
  if (!file) return;
  if (file.size === 0) { showNotice('文件为空，无法上传。'); return; }
  if (file.size > MAX_UPLOAD_BYTES) {
    showNotice(`文件 ${formatBytes(file.size)} 超过上限 ${formatBytes(MAX_UPLOAD_BYTES)}。`);
    return;
  }
  const status = $('#upload-status');
  status.hidden = false;
  status.textContent = `正在上传：${file.name}（${formatBytes(file.size)}）`;
  $('#upload-trigger').disabled = true;
  showNotice('');
  try {
    const response = await fetch(`/api/paper/docs/upload?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': file.type || 'application/octet-stream' },
      body: file
    });
    let data = null;
    try { data = await response.json(); } catch { data = null; }
    if (!response.ok) {
      const error = new Error((data && data.message) || `上传失败（HTTP ${response.status}）`);
      error.code = data && data.code;
      throw error;
    }
    status.textContent = `已上传：${file.name}`;
    showNotice('上传完成，正在打开文档。', 'ok');
    await loadDocs();
    location.hash = `#doc/${encodeURIComponent(data.doc.id)}`;
    if (state.docId === data.doc.id) await openDoc(data.doc.id);
  } catch (error) {
    status.textContent = '';
    status.hidden = true;
    showNotice(error.code === 'paper.unsupported_file'
      ? '只支持 PDF 与 UTF-8 纯文本（.txt/.md）。'
      : `上传失败：${error.message}`);
  } finally {
    $('#upload-trigger').disabled = false;
    $('#file-input').value = '';
  }
}

async function deleteDoc() {
  if (!state.doc) return;
  if (!window.confirm(`删除《${state.doc.title || state.doc.filename}》？译文与原件会一并删除。`)) return;
  try {
    await api('DELETE', docPath(state.doc.id));
    showNotice('论文已删除。', 'ok');
    const id = state.docId;
    state.doc = null;
    state.docId = null;
    await loadDocs();
    if (state.docId === id) showHome();
    if (!location.hash || history.state === null) showHome();
    history.replaceState(null, '', location.pathname + location.search);
    showHome();
  } catch (error) {
    showNotice(error.message);
  }
}

// ---------------------------------------------------------------------------
// 右键菜单
// ---------------------------------------------------------------------------

function openContextMenu(x, y, sid) {
  state.menuSid = sid;
  const menu = $('#context-menu');
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
}

function closeContextMenu() {
  $('#context-menu').hidden = true;
  state.menuSid = null;
}

function segmentText(sid) {
  for (const block of (state.doc && state.doc.blocks) || []) {
    for (const segment of block.segments || []) {
      if (segment.sid === sid) return segment.text;
    }
  }
  return '';
}

async function contextAction(action) {
  const sid = state.menuSid;
  closeContextMenu();
  if (!sid) return;
  const text = segmentText(sid);
  if (action === 'copy') {
    try {
      await navigator.clipboard.writeText(text);
      showNotice('原文已复制。', 'ok');
    } catch {
      showNotice('浏览器未允许复制，请手动选择文本。');
    }
    return;
  }
  if (action === 'ask') {
    selectSid(sid, { flash: true });
    const prompt = `请结合论文上下文解释这句话：${text.slice(0, 800)}`;
    $('#ask-input').value = prompt;
    $('#ask-input').focus();
    $('#ask-input').scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------

function bind() {
  $('#refresh').addEventListener('click', async () => {
    const changed = await loadDocs();
    if (!changed) return;
    if (state.docId) await openDoc(state.docId);
    else showHome();
  });
  $('#upload-trigger').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (event) => uploadFile(event.target.files && event.target.files[0]));

  const dropzone = $('#dropzone');
  dropzone.addEventListener('dragover', (event) => { event.preventDefault(); dropzone.classList.add('over'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropzone.classList.remove('over');
    uploadFile(event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0]);
  });

  $('#translate-start').addEventListener('click', startTranslate);
  $('#translate-stop').addEventListener('click', stopTranslate);
  $('#translate-lang').addEventListener('change', changeLanguage);
  $('#delete-doc').addEventListener('click', deleteDoc);
  $('#toggle-pdf').addEventListener('click', togglePdf);
  $('#ask-form').addEventListener('submit', ask);

  for (const button of document.querySelectorAll('.view-switch button')) {
    button.addEventListener('click', () => {
      state.view = button.dataset.view;
      renderReader();
    });
  }

  for (const button of document.querySelectorAll('#context-menu button')) {
    button.addEventListener('click', () => contextAction(button.dataset.action));
  }
  document.addEventListener('click', (event) => {
    if (!event.target.closest('#context-menu')) closeContextMenu();
  });
  document.addEventListener('scroll', closeContextMenu, true);
  window.addEventListener('resize', closeContextMenu);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { closeContextMenu(); showNotice(''); }
  });
  window.addEventListener('hashchange', () => { route().catch((error) => showNotice(error.message)); });
}

bind();
route().catch((error) => showNotice(error.message));