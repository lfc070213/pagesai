'use strict';
// PagesAI 邮件控制台：同源调用 /api/mail/*，身份来自核心会话 Cookie。
// 服务端文本一律通过 textContent 写入；只有服务端已净化的 HTML 正文使用 innerHTML。

const state = {
  folder: 'INBOX',
  offset: 0,
  limit: 20,
  total: 0,
  messages: [],
  selected: null,
  sendEnabled: false,
  idempotencyKey: null
};

const $ = (selector) => document.querySelector(selector);

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child !== null && child !== undefined) node.append(child);
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
  try {
    data = await response.json();
  } catch {
    data = null;
  }
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

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function currentFolder() {
  const custom = $('#custom-folder').value.trim();
  return custom || $('#folder').value || 'INBOX';
}

function newKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `mail-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// ---------------------------------------------------------------------------
// 账号与状态
// ---------------------------------------------------------------------------

async function loadIdentity() {
  try {
    const data = await api('GET', '/api/me');
    const user = data && data.user ? data.user : {};
    const label = [user.username, user.email].filter(Boolean).join(' · ');
    $('#account').textContent = label || '已登录';
  } catch (error) {
    $('#account').textContent = '未登录';
    if (error.status === 401 || error.status === 403) {
      showNotice('请先通过 PagesAI 登录，再打开邮件控制台。');
    }
  }
}

async function loadHealth() {
  try {
    const health = await api('GET', '/api/mail/health');
    state.sendEnabled = health.userSendEnabled === true;
    $('#smtp-status').textContent = health.transportConfigured ? '已配置' : '未配置';
    $('#imap-status').textContent = health.imapConfigured ? '已配置' : '未配置';
    $('#send-status').textContent = state.sendEnabled ? '开放' : '仅系统发信';
    $('#compose-open').disabled = !state.sendEnabled;
    $('#compose-open').title = state.sendEnabled ? '' : '当前部署未开放用户发信';
  } catch (error) {
    $('#smtp-status').textContent = '未知';
    $('#imap-status').textContent = '未知';
    showNotice(error.message);
  }
}

// ---------------------------------------------------------------------------
// 邮件列表与阅读
// ---------------------------------------------------------------------------

async function loadMessages() {
  state.folder = currentFolder();
  $('#list-title').textContent = state.folder;
  try {
    const query = new URLSearchParams({
      folder: state.folder,
      limit: String(state.limit),
      offset: String(state.offset)
    });
    const data = await api('GET', `/api/mail/messages?${query.toString()}`);
    state.messages = Array.isArray(data.messages) ? data.messages : [];
    state.total = Number.isSafeInteger(data.total) ? data.total : state.messages.length;
    showNotice('');
    renderList();
  } catch (error) {
    state.messages = [];
    state.total = 0;
    renderList();
    showNotice(error.code === 'mail.imap_not_configured'
      ? '当前部署未配置收件适配器（IMAP），无法读取邮箱。'
      : error.message);
  }
}

function renderList() {
  const list = $('#message-list');
  list.replaceChildren();
  $('#list-count').textContent = state.total > 0 ? `共 ${state.total} 封` : '';
  $('#newer').disabled = state.offset <= 0;
  $('#older').disabled = state.offset + state.messages.length >= state.total;
  if (state.messages.length === 0) {
    list.append(el('li', { class: 'empty', text: '这个文件夹没有邮件' }));
    return;
  }
  for (const message of state.messages) {
    const item = el('li', {
      class: `message-item${message.unread ? ' unread' : ''}${state.selected && state.selected.id === message.id ? ' active' : ''}`
    }, [
      el('button', { class: 'message-button', type: 'button', onclick: () => openMessage(message.id) }, [
        el('span', { class: 'line' }, [
          el('strong', { text: message.from || '(未知发件人)' }),
          el('time', { text: formatTime(message.date) })
        ]),
        el('span', { class: 'subject', text: message.subject || '(无主题)' }),
        el('span', { class: 'snippet', text: message.snippet || '' }),
        message.hasAttachments ? el('span', { class: 'badge', text: `附件 ${message.attachments.length}` }) : null
      ])
    ]);
    list.append(item);
  }
}

async function openMessage(id) {
  try {
    const query = new URLSearchParams({ folder: state.folder });
    const data = await api('GET', `/api/mail/messages/${encodeURIComponent(id)}?${query.toString()}`);
    state.selected = data.message;
    renderReader();
    renderList();
  } catch (error) {
    showNotice(error.message);
  }
}

function renderReader() {
  const message = state.selected;
  $('#reader-empty').hidden = Boolean(message);
  $('#reader-body').hidden = !message;
  if (!message) return;
  $('#message-subject').textContent = message.subject || '(无主题)';
  $('#message-meta').textContent = `发件人：${message.from || '—'} · 收件人：${message.to || '—'} · ${formatTime(message.date)}`;
  const htmlBox = $('#message-html');
  const textBox = $('#message-text');
  // 服务端已按白名单净化 HTML；这里只渲染净化后的结果。
  if (message.html) {
    htmlBox.innerHTML = message.html;
    htmlBox.hidden = false;
    textBox.hidden = true;
    textBox.textContent = '';
  } else {
    htmlBox.replaceChildren();
    htmlBox.hidden = true;
    textBox.hidden = false;
    textBox.textContent = message.text || message.snippet || '';
  }
  renderAttachments(message);
}

function renderAttachments(message) {
  const box = $('#attachment-box');
  const list = $('#attachment-list');
  list.replaceChildren();
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  box.hidden = attachments.length === 0;
  for (const attachment of attachments) {
    list.append(el('li', {}, [
      el('button', {
        type: 'button',
        class: 'link',
        text: `${attachment.filename || '附件'}（${formatBytes(attachment.size)}）`,
        onclick: () => downloadAttachment(message.id, attachment)
      })
    ]));
  }
}

async function downloadAttachment(messageId, attachment) {
  try {
    const query = new URLSearchParams({ folder: state.folder });
    const path = `/api/mail/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachment.id)}?${query.toString()}`;
    const data = await api('GET', path);
    const binary = atob(data.contentBase64 || '');
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const blob = new Blob([bytes], { type: data.contentType || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = data.filename || 'attachment';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    showNotice(error.message);
  }
}

async function deleteSelected() {
  const message = state.selected;
  if (!message) return;
  if (!window.confirm('确定删除这封邮件吗？删除后不可撤销。')) return;
  try {
    await api('DELETE', `/api/mail/messages/${encodeURIComponent(message.id)}`, { folder: state.folder });
    state.selected = null;
    renderReader();
    showNotice('邮件已删除', 'ok');
    await loadMessages();
  } catch (error) {
    showNotice(error.message);
  }
}

// ---------------------------------------------------------------------------
// 写邮件
// ---------------------------------------------------------------------------

async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve({ filename: file.name, contentType: file.type || 'application/octet-stream', contentBase64: comma >= 0 ? result.slice(comma + 1) : result });
    };
    reader.onerror = () => reject(new Error(`无法读取附件 ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function openCompose() {
  if (!state.sendEnabled) return;
  state.idempotencyKey = newKey();
  $('#compose-to').value = '';
  $('#compose-subject').value = '';
  $('#compose-text').value = '';
  $('#compose-html').value = '';
  $('#compose-files').value = '';
  $('#compose-error').hidden = true;
  $('#compose').hidden = false;
  $('#compose-to').focus();
}

function closeCompose() {
  $('#compose').hidden = true;
  state.idempotencyKey = null;
}

async function submitCompose(event) {
  event.preventDefault();
  const errorNode = $('#compose-error');
  errorNode.hidden = true;
  const to = $('#compose-to').value.trim();
  const subject = $('#compose-subject').value;
  const text = $('#compose-text').value;
  const html = $('#compose-html').value;
  if (!to) {
    errorNode.textContent = '请填写收件人';
    errorNode.hidden = false;
    return;
  }
  if (!text && !html) {
    errorNode.textContent = '请填写纯文本或 HTML 正文';
    errorNode.hidden = false;
    return;
  }
  const files = Array.from($('#compose-files').files || []);
  const button = $('#compose-send');
  button.disabled = true;
  try {
    const attachments = [];
    for (const file of files) attachments.push(await fileToBase64(file));
    await api('POST', '/api/mail/send', {
      to,
      subject,
      text,
      html,
      attachments,
      idempotencyKey: state.idempotencyKey
    });
    closeCompose();
    showNotice('邮件已提交给发信服务', 'ok');
  } catch (error) {
    errorNode.textContent = error.message;
    errorNode.hidden = false;
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

function bind() {
  $('#refresh').addEventListener('click', () => {
    loadHealth();
    loadMessages();
  });
  $('#folder').addEventListener('change', () => {
    $('#custom-folder').value = '';
    state.offset = 0;
    state.selected = null;
    renderReader();
    loadMessages();
  });
  $('#apply-folder').addEventListener('click', () => {
    state.offset = 0;
    state.selected = null;
    renderReader();
    loadMessages();
  });
  $('#newer').addEventListener('click', () => {
    state.offset = Math.max(0, state.offset - state.limit);
    loadMessages();
  });
  $('#older').addEventListener('click', () => {
    state.offset += state.limit;
    loadMessages();
  });
  $('#delete-message').addEventListener('click', deleteSelected);
  $('#compose-open').addEventListener('click', openCompose);
  $('#compose-cancel').addEventListener('click', closeCompose);
  $('#compose-form').addEventListener('submit', submitCompose);
  $('#compose').addEventListener('click', (event) => {
    if (event.target === $('#compose')) closeCompose();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#compose').hidden) closeCompose();
  });
}

bind();
loadIdentity();
loadHealth();
loadMessages();
