'use strict';
// Glim 控制台：同源调用 /api/glim/*，身份来自核心会话 Cookie。
// 所有服务端文本都通过 textContent 写入，不拼接 HTML。

const state = {
  sessions: [],
  sessionId: null,
  messages: [],
  connectors: [],
  tools: [],
  tasks: [],
  workspace: [],
  taskTimer: null
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

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

function showError(selector, message) {
  const node = $(selector);
  if (node) node.textContent = message || '';
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

// ---------------------------------------------------------------------------
// 标签页
// ---------------------------------------------------------------------------

function activate(tab) {
  $$('#tabs button').forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
  $$('[data-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.panel === tab));
  if (tab === 'connections') loadConnections();
  if (tab === 'tasks') {
    loadTasks();
    loadSessions();
  }
  if (tab === 'workspace') loadWorkspace();
  if (tab === 'memory') loadMemory();
  if (tab === 'audit') loadAudit();
}

// ---------------------------------------------------------------------------
// 会话与消息
// ---------------------------------------------------------------------------

async function loadSessions() {
  try {
    const data = await api('GET', '/api/glim/sessions');
    state.sessions = data.sessions || [];
    renderSessions();
    renderTaskSessionOptions();
  } catch (error) {
    showError('#chat-error', error.message);
  }
}

function renderSessions() {
  const list = $('#session-list');
  list.replaceChildren();
  if (state.sessions.length === 0) {
    list.append(el('li', { class: 'empty', text: '还没有会话' }));
    return;
  }
  for (const session of state.sessions) {
    const item = el('li', { class: session.id === state.sessionId ? 'item active' : 'item' }, [
      el('button', {
        class: 'link',
        text: session.title,
        onclick: () => selectSession(session.id)
      }),
      el('span', { class: 'muted', text: `${session.messageCount} 条` }),
      el('button', {
        class: 'danger ghost small',
        text: '删除',
        onclick: async (event) => {
          event.stopPropagation();
          if (!window.confirm(`删除会话「${session.title}」？`)) return;
          try {
            await api('DELETE', `/api/glim/sessions/${encodeURIComponent(session.id)}`);
            if (state.sessionId === session.id) {
              state.sessionId = null;
              state.messages = [];
              renderMessages();
            }
            await loadSessions();
          } catch (error) {
            showError('#chat-error', error.message);
          }
        }
      })
    ]);
    list.append(item);
  }
}

function renderTaskSessionOptions() {
  const select = $('#task-session');
  const current = select.value;
  select.replaceChildren(el('option', { value: '', text: '自动创建会话' }));
  for (const session of state.sessions) {
    select.append(el('option', { value: session.id, text: session.title }));
  }
  if (current) select.value = current;
}

async function selectSession(sessionId) {
  state.sessionId = sessionId;
  const session = state.sessions.find((item) => item.id === sessionId);
  $('#session-title').textContent = session ? session.title : '会话';
  renderSessions();
  try {
    const data = await api('GET', `/api/glim/sessions/${encodeURIComponent(sessionId)}/messages?limit=200`);
    state.messages = data.messages || [];
    renderMessages();
  } catch (error) {
    showError('#chat-error', error.message);
  }
}

function renderMessages() {
  const container = $('#messages');
  container.replaceChildren();
  if (!state.sessionId) {
    container.append(el('p', { class: 'empty', text: '选择或新建一个会话开始对话。' }));
    return;
  }
  if (state.messages.length === 0) {
    container.append(el('p', { class: 'empty', text: '还没有消息。' }));
    return;
  }
  for (const message of state.messages) {
    container.append(el('div', { class: `message ${message.role}` }, [
      el('div', { class: 'role', text: message.role === 'user' ? '你' : 'Glim' }),
      el('div', { class: 'bubble', text: message.content })
    ]));
  }
  container.scrollTop = container.scrollHeight;
}

async function createSession() {
  try {
    const data = await api('POST', '/api/glim/sessions', { title: '新会话' });
    await loadSessions();
    await selectSession(data.session.id);
    $('#chat-input').focus();
  } catch (error) {
    showError('#chat-error', error.message);
  }
}

async function sendMessage(event) {
  event.preventDefault();
  const input = $('#chat-input');
  const content = input.value.trim();
  if (!content) return;
  if (!state.sessionId) {
    await createSession();
    if (!state.sessionId) return;
  }
  showError('#chat-error', '');
  const button = $('#send-button');
  button.disabled = true;
  try {
    const data = await api('POST', `/api/glim/sessions/${encodeURIComponent(state.sessionId)}/messages`, { content });
    state.messages.push(data.userMessage, data.assistantMessage);
    input.value = '';
    renderMessages();
    await loadSessions();
  } catch (error) {
    showError('#chat-error', error.message);
  } finally {
    button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 连接与发现
// ---------------------------------------------------------------------------

const STATUS_LABELS = {
  available: '可用',
  'pending-auth': '待授权',
  'not-installed': '未安装',
  'not-configured': '未配置',
  unavailable: '不可用',
  incompatible: '版本不兼容'
};

async function loadConnections() {
  showError('#connections-error', '');
  try {
    const [connectors, tools] = await Promise.all([
      api('GET', '/api/glim/connectors'),
      api('GET', '/api/glim/tools')
    ]);
    state.connectors = connectors.connectors || [];
    state.tools = tools.tools || [];
    renderConnectors();
    renderTools();
  } catch (error) {
    showError('#connections-error', error.message);
  }
  try {
    const discovery = await api('GET', '/api/glim/discovery');
    renderDiscovery(discovery);
  } catch (error) {
    $('#discovery').replaceChildren(el('p', { class: 'error', text: error.message }));
  }
}

function renderDiscovery(data) {
  const container = $('#discovery');
  container.replaceChildren();
  if (!data.configured) {
    container.append(el('p', { class: 'muted', text: '未配置 moduleDirectoryUrl，无法读取模块目录。' }));
  }
  for (const item of data.modules || []) {
    const actions = [];
    if (item.status !== 'not-installed' && item.status !== 'unavailable') {
      if (!item.connectorId) {
        actions.push(el('button', {
          class: 'primary small',
          text: '登记',
          onclick: () => registerModule(item.moduleId, false)
        }));
        actions.push(el('button', {
          class: 'ghost small',
          text: '登记并授权',
          onclick: () => registerModule(item.moduleId, true)
        }));
      } else if (!item.granted) {
        actions.push(el('button', {
          class: 'primary small',
          text: '授权全部能力',
          onclick: () => grantConnector(item.connectorId, null)
        }));
      }
    }
    container.append(el('article', { class: 'card' }, [
      el('div', { class: 'row between' }, [
        el('strong', { text: item.label || item.moduleId }),
        el('span', { class: `badge status-${item.status}`, text: STATUS_LABELS[item.status] || item.status })
      ]),
      el('p', { class: 'muted', text: item.reason || `版本 ${item.version || '未知'}` }),
      el('p', { class: 'muted', text: (item.capabilities || []).length ? `${(item.capabilities || []).length} 项能力` : '无已声明能力' }),
      el('div', { class: 'row' }, actions)
    ]));
  }
}

async function registerModule(moduleId, grant) {
  try {
    await api('POST', '/api/glim/connectors/from-module', { moduleId, grant });
    await loadConnections();
  } catch (error) {
    showError('#connections-error', error.message);
  }
}

function renderConnectors() {
  const list = $('#connector-list');
  list.replaceChildren();
  if (state.connectors.length === 0) {
    list.append(el('li', { class: 'empty', text: '还没有登记连接。' }));
    return;
  }
  for (const connector of state.connectors) {
    const granted = connector.grant ? connector.grant.capabilities.length : 0;
    list.append(el('li', { class: 'item' }, [
      el('div', { class: 'grow' }, [
        el('strong', { text: connector.name }),
        el('div', { class: 'muted', text: connector.endpoint }),
        el('div', { class: 'muted', text: `${connector.moduleId ? `模块 ${connector.moduleId} · ` : ''}${granted}/${connector.capabilities.length} 项已授权` })
      ]),
      el('div', { class: 'row' }, [
        el('button', { class: 'ghost small', text: '授权全部', onclick: () => grantConnector(connector.id, null) }),
        el('button', { class: 'ghost small', text: '撤销全部', onclick: () => revokeConnector(connector.id) }),
        el('button', { class: 'danger ghost small', text: '删除', onclick: () => deleteConnector(connector.id) })
      ])
    ]));
  }
}

async function grantConnector(connectorId, capabilities) {
  try {
    await api('POST', `/api/glim/connectors/${encodeURIComponent(connectorId)}/grant`, capabilities ? { capabilities } : {});
    await loadConnections();
  } catch (error) {
    showError('#connections-error', error.message);
  }
}

async function revokeConnector(connectorId) {
  try {
    await api('POST', `/api/glim/connectors/${encodeURIComponent(connectorId)}/revoke`, {});
    await loadConnections();
  } catch (error) {
    showError('#connections-error', error.message);
  }
}

async function deleteConnector(connectorId) {
  if (!window.confirm('删除该连接并清除授权？')) return;
  try {
    await api('DELETE', `/api/glim/connectors/${encodeURIComponent(connectorId)}`);
    await loadConnections();
  } catch (error) {
    showError('#connections-error', error.message);
  }
}

function renderTools() {
  const list = $('#tool-list');
  list.replaceChildren();
  if (state.tools.length === 0) {
    list.append(el('li', { class: 'empty', text: '没有已授权且可用的工具。' }));
    return;
  }
  for (const tool of state.tools) {
    list.append(el('li', { class: 'item' }, [
      el('div', { class: 'grow' }, [
        el('strong', { text: tool.name }),
        el('div', { class: 'muted', text: `${tool.access}${tool.externalEffect ? ' · 有外部副作用' : ''} · ${tool.connectorName}` })
      ]),
      el('span', {
        class: tool.adapterReady ? 'badge status-available' : 'badge status-unavailable',
        text: tool.adapterReady ? '可执行' : '缺少适配器'
      })
    ]));
  }
}

// ---------------------------------------------------------------------------
// 任务
// ---------------------------------------------------------------------------

async function loadTasks() {
  try {
    const data = await api('GET', '/api/glim/tasks?limit=50');
    state.tasks = data.tasks || [];
    renderTasks();
    const active = state.tasks.some((task) => task.status === 'queued' || task.status === 'running');
    if (active && !state.taskTimer) {
      state.taskTimer = setInterval(loadTasks, 1500);
    } else if (!active && state.taskTimer) {
      clearInterval(state.taskTimer);
      state.taskTimer = null;
    }
  } catch (error) {
    showError('#tasks-error', error.message);
  }
}

function renderTasks() {
  const container = $('#task-list');
  container.replaceChildren();
  if (state.tasks.length === 0) {
    container.append(el('p', { class: 'empty', text: '还没有任务。' }));
    return;
  }
  for (const task of state.tasks) {
    const trace = (task.trace || []).slice(-6).map((item) =>
      `${formatTime(item.at)} ${item.name || item.type} ${item.status}${item.code ? ` (${item.code})` : ''}`
    );
    const actions = [];
    if (task.status === 'queued' || task.status === 'running') {
      actions.push(el('button', { class: 'ghost small', text: '停止', onclick: () => stopTask(task.id) }));
    }
    if (task.status === 'stopped' || task.status === 'interrupted' || task.status === 'failed') {
      actions.push(el('button', { class: 'primary small', text: '恢复', onclick: () => resumeTask(task.id) }));
    }
    container.append(el('article', { class: 'task' }, [
      el('div', { class: 'row between' }, [
        el('strong', { text: task.prompt.slice(0, 80) }),
        el('span', { class: `badge status-${task.status}`, text: task.status })
      ]),
      el('p', { class: 'muted', text: `创建 ${formatTime(task.createdAt)} · 尝试 ${task.attempts}` }),
      task.reply ? el('p', { text: task.reply }) : null,
      task.error ? el('p', { class: 'error', text: task.error }) : null,
      trace.length ? el('pre', { class: 'trace', text: trace.join('\n') }) : null,
      el('div', { class: 'row' }, actions)
    ]));
  }
}

async function createTask(event) {
  event.preventDefault();
  const prompt = $('#task-prompt').value.trim();
  if (!prompt) return;
  const sessionId = $('#task-session').value || undefined;
  try {
    await api('POST', '/api/glim/tasks', { prompt, sessionId });
    $('#task-prompt').value = '';
    await loadTasks();
  } catch (error) {
    showError('#tasks-error', error.message);
  }
}

async function stopTask(taskId) {
  try {
    await api('POST', `/api/glim/tasks/${encodeURIComponent(taskId)}/stop`);
    await loadTasks();
  } catch (error) {
    showError('#tasks-error', error.message);
  }
}

async function resumeTask(taskId) {
  try {
    await api('POST', `/api/glim/tasks/${encodeURIComponent(taskId)}/resume`);
    await loadTasks();
  } catch (error) {
    showError('#tasks-error', error.message);
  }
}

// ---------------------------------------------------------------------------
// 工作区
// ---------------------------------------------------------------------------

async function loadWorkspace() {
  showError('#workspace-error', '');
  try {
    const data = await api('GET', '/api/glim/workspace');
    state.workspace = data.files || [];
    const list = $('#workspace-list');
    list.replaceChildren();
    if (state.workspace.length === 0) {
      list.append(el('li', { class: 'empty', text: '工作区为空' }));
    } else {
      for (const file of state.workspace) {
        list.append(el('li', { class: 'item' }, [
          el('button', { class: 'link grow', text: file.path, onclick: () => openWorkspaceFile(file.path) }),
          el('span', { class: 'muted', text: formatBytes(file.size) })
        ]));
      }
    }
    $('#workspace-quota').textContent = `${state.workspace.length}/${data.maxFiles} 个文件 · ${formatBytes(data.totalBytes)} / ${formatBytes(data.maxTotalBytes)}`;
  } catch (error) {
    showError('#workspace-error', error.message);
  }
}

async function openWorkspaceFile(path) {
  try {
    const data = await api('GET', `/api/glim/workspace/file?path=${encodeURIComponent(path)}`);
    $('#workspace-path').value = data.path;
    if (data.encoding === 'base64') {
      $('#workspace-content').value = '';
      showError('#workspace-error', '该文件为二进制，控制台不展示内容；可直接覆盖或删除。');
    } else {
      $('#workspace-content').value = data.content;
      showError('#workspace-error', '');
    }
  } catch (error) {
    showError('#workspace-error', error.message);
  }
}

async function saveWorkspaceFile() {
  const path = $('#workspace-path').value.trim();
  if (!path) {
    showError('#workspace-error', '请填写文件路径');
    return;
  }
  try {
    await api('PUT', '/api/glim/workspace/file', { path, content: $('#workspace-content').value });
    showError('#workspace-error', '');
    await loadWorkspace();
  } catch (error) {
    showError('#workspace-error', error.message);
  }
}

async function deleteWorkspaceFile() {
  const path = $('#workspace-path').value.trim();
  if (!path) return;
  if (!window.confirm(`删除工作区文件「${path}」？`)) return;
  try {
    await api('POST', '/api/glim/workspace/delete', { path });
    $('#workspace-path').value = '';
    $('#workspace-content').value = '';
    await loadWorkspace();
  } catch (error) {
    showError('#workspace-error', error.message);
  }
}

// ---------------------------------------------------------------------------
// 记忆与审计
// ---------------------------------------------------------------------------

async function loadMemory() {
  try {
    const data = await api('GET', '/api/glim/memory');
    $('#memory-content').value = data.content || '';
    $('#memory-meta').textContent = `${(data.content || '').length}/${data.maxChars} 字符 · 更新于 ${formatTime(data.updatedAt)}`;
    showError('#memory-error', '');
  } catch (error) {
    showError('#memory-error', error.message);
  }
}

async function saveMemory() {
  try {
    const data = await api('PUT', '/api/glim/memory', { content: $('#memory-content').value });
    $('#memory-meta').textContent = `${(data.content || '').length}/${data.maxChars} 字符 · 更新于 ${formatTime(data.updatedAt)}`;
    showError('#memory-error', '');
  } catch (error) {
    showError('#memory-error', error.message);
  }
}

async function loadAudit() {
  try {
    const data = await api('GET', '/api/glim/audit?limit=100');
    const body = $('#audit-body');
    body.replaceChildren();
    for (const record of data.audit || []) {
      body.append(el('tr', {}, [
        el('td', { text: formatTime(record.startedAt) }),
        el('td', { text: `${record.tool}${record.moduleId ? ` · ${record.moduleId}` : ''}` }),
        el('td', { text: record.source }),
        el('td', { text: record.ok ? '成功' : `${record.code || '失败'}` }),
        el('td', { text: record.durationMs === null ? '—' : `${record.durationMs} ms` })
      ]));
    }
    if (!(data.audit || []).length) {
      body.append(el('tr', {}, [el('td', { colspan: '5', class: 'empty', text: '暂无审计记录' })]));
    }
  } catch (error) {
    $('#audit-body').replaceChildren(el('tr', {}, [el('td', { colspan: '5', class: 'error', text: error.message })]));
  }
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

async function boot() {
  try {
    const health = await api('GET', '/api/glim/health');
    $('#status').textContent = `模型 ${health.model === 'configured' ? '已配置' : '未配置'} · 工作区 ${health.workspace ? '可用' : '未启用'} · 发现 ${health.discovery ? '已配置' : '未配置'}`;
  } catch {
    $('#status').textContent = '无法读取模块状态';
  }
  await loadSessions();
  renderMessages();
}

$('#tabs').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-tab]');
  if (button) activate(button.dataset.tab);
});
$('#new-session').addEventListener('click', createSession);
$('#refresh-sessions').addEventListener('click', loadSessions);
$('#chat-form').addEventListener('submit', sendMessage);
$('#chat-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('#chat-form').requestSubmit();
  }
});
$('#refresh-discovery').addEventListener('click', loadConnections);
$('#task-form').addEventListener('submit', createTask);
$('#refresh-workspace').addEventListener('click', loadWorkspace);
$('#new-file').addEventListener('click', () => {
  $('#workspace-path').value = '';
  $('#workspace-content').value = '';
  $('#workspace-path').focus();
});
$('#save-file').addEventListener('click', saveWorkspaceFile);
$('#delete-file').addEventListener('click', deleteWorkspaceFile);
$('#save-memory').addEventListener('click', saveMemory);
$('#refresh-audit').addEventListener('click', loadAudit);

boot();
