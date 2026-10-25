'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    authMode: 'login', user: null, sites: [], site: null, models: [],
    tasks: [], activeTask: null, events: null, selectedPath: null
  };

  function message(id, value, isError = true) {
    const node = $(id);
    node.textContent = value || '';
    node.style.color = isError ? '' : '#166534';
  }
  function errorText(error) { return error && error.message ? error.message : String(error); }
  function encodedPath(value) { return value.split('/').map(encodeURIComponent).join('/'); }
  function clearChildren(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function button(label, onClick, className = '') {
    const node = document.createElement('button');
    node.type = 'button'; node.textContent = label; node.className = className;
    node.addEventListener('click', onClick);
    return node;
  }

  async function api(path, options = {}) {
    const request = { credentials: 'same-origin', ...options, headers: { ...(options.headers || {}) } };
    if (request.json !== undefined) {
      request.headers['content-type'] = 'application/json';
      request.body = JSON.stringify(request.json);
      delete request.json;
    }
    const response = await fetch(path, request);
    if (response.status === 401 && !path.startsWith('/api/auth/') && path !== '/api/me') {
      closeEvents(); showAuth('会话已失效，请重新登录。');
    }
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) {
      const failure = new Error(payload && payload.message ? payload.message : `HTTP ${response.status}`);
      failure.code = payload && payload.code; failure.status = response.status;
      throw failure;
    }
    return payload;
  }

  function setAuthMode(mode) {
    state.authMode = mode;
    $('loginTab').classList.toggle('active', mode === 'login');
    $('registerTab').classList.toggle('active', mode === 'register');
    $('authSubmit').textContent = mode === 'login' ? '登录' : '注册并登录';
    $('password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    message('authMessage', '');
  }
  function showAuth(note = '') {
    state.user = null; state.site = null;
    $('appView').hidden = true; $('authView').hidden = false;
    if (note) message('authMessage', note);
  }
  async function showApp(user) {
    state.user = user;
    $('authView').hidden = true; $('appView').hidden = false;
    $('currentUser').textContent = `${user.username} · ${user.role}`;
    $('adminOpen').hidden = user.role !== 'admin';
    await Promise.all([loadSites(), loadModels()]);
  }

  async function loadSites(preferredId = null) {
    const result = await api('/api/pages/sites');
    state.sites = result.sites;
    const nav = $('siteList'); clearChildren(nav);
    for (const site of state.sites) {
      const item = button(site.name, () => selectSite(site.id), 'site-button');
      item.dataset.siteId = site.id;
      item.classList.toggle('active', Boolean(state.site && state.site.id === site.id));
      nav.appendChild(item);
    }
    const wanted = preferredId || (state.site && state.site.id);
    if (wanted && state.sites.some((site) => site.id === wanted)) await selectSite(wanted);
    else if (!state.site && state.sites.length) await selectSite(state.sites[0].id);
    else if (!state.sites.length) {
      state.site = null; $('siteView').hidden = true; $('emptyState').hidden = false;
    }
  }

  async function loadModels() {
    const result = await api('/api/pages/models');
    state.models = result.models;
    const select = $('modelSelect'); clearChildren(select);
    for (const model of state.models) {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = `${model.id} · ${model.kind === 'deterministic-test' ? '仅测试本地模型' : model.model}`;
      select.appendChild(option);
    }
    updateModelNotice();
  }
  function updateModelNotice() {
    const model = state.models.find((item) => item.id === $('modelSelect').value);
    $('testModelNotice').hidden = !model || model.kind !== 'deterministic-test';
  }

  async function selectSite(id) {
    closeEvents();
    const [detail, taskResult] = await Promise.all([
      api(`/api/pages/sites/${encodeURIComponent(id)}`),
      api(`/api/pages/tasks?siteId=${encodeURIComponent(id)}`)
    ]);
    state.site = detail.site; state.tasks = taskResult.tasks;
    state.selectedPath = null; state.activeTask = null;
    $('emptyState').hidden = true; $('siteView').hidden = false;
    for (const item of $('siteList').children) item.classList.toggle('active', item.dataset.siteId === id);
    renderSite(); renderFiles(); renderVersions(); renderMaterials(); renderTasks();
    await loadBackend();
    refreshPreview();
  }

  function renderSite() {
    const site = state.site; if (!site) return;
    $('siteTitle').textContent = site.name;
    $('siteMeta').textContent = `${site.slug} · ${site.fileCount} 个文件 · 公开版本 ${site.publishedVersion || '未发布'}`;
    $('publicLink').hidden = !site.publicPath;
    if (site.publicPath) $('publicLink').href = site.publicPath;
  }
  function renderFiles() {
    const list = $('fileList'); clearChildren(list);
    for (const file of state.site.files) {
      const li = document.createElement('li');
      const item = button(file.path, () => openFile(file.path));
      item.classList.toggle('active', state.selectedPath === file.path);
      li.appendChild(item); list.appendChild(li);
    }
    if (!state.selectedPath) { $('filePath').value = ''; $('fileContent').value = ''; }
  }
  async function openFile(filePath) {
    const result = await api(`/api/pages/sites/${state.site.id}/files/${encodedPath(filePath)}`);
    state.selectedPath = filePath;
    $('filePath').value = filePath; $('fileContent').value = result.file.content;
    renderFiles();
  }
  function renderVersions() {
    const select = $('versionSelect'); clearChildren(select);
    for (const version of state.site.versions) {
      const option = document.createElement('option'); option.value = String(version.version);
      option.textContent = `v${version.version} · ${version.fileCount} 文件${version.isPublished ? ' · 当前公开' : ''}`;
      select.appendChild(option);
    }
    $('rollback').disabled = !state.site.versions.length;
  }
  function renderMaterials() {
    const list = $('materialList'); clearChildren(list);
    for (const material of state.site.materials || []) {
      const li = document.createElement('li'); const link = document.createElement('a');
      link.href = `/api/pages/sites/${state.site.id}/materials/${encodedPath(material.name)}`;
      link.textContent = `${material.name} (${material.size} bytes)`; link.download = material.name;
      li.appendChild(link); list.appendChild(li);
    }
  }
  function renderTasks() {
    clearChildren($('taskEvents'));
    const active = state.tasks.find((task) => ['queued', 'running', 'cancelling'].includes(task.status));
    const latest = state.activeTask || active || state.tasks[0] || null;
    if (latest) {
      state.activeTask = latest;
      $('taskState').textContent = latest.status;
      $('cancelTask').disabled = !['queued', 'running', 'cancelling'].includes(latest.status);
      addEventLine('status', { text: `任务 ${latest.id}：${latest.status}` });
      if (latest.error) addEventLine('error', latest.error);
      if (latest.result) showTaskResult(latest.result);
      if (['queued', 'running', 'cancelling'].includes(latest.status)) listenTask(latest.id);
    } else {
      $('taskState').textContent = '空闲'; $('cancelTask').disabled = true;
    }
  }
  function addEventLine(type, data) {
    const line = document.createElement('div'); line.className = 'event-line';
    const detail = data && (data.text || data.message || data.summary || data.status || data.code) || '';
    line.textContent = `[${type}] ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    $('taskEvents').appendChild(line);
    while ($('taskEvents').children.length > 500) $('taskEvents').firstChild.remove();
    $('taskEvents').scrollTop = $('taskEvents').scrollHeight;
  }
  function showTaskResult(result) {
    if (!result) return;
    if (result.summary) addEventLine('result', { text: result.summary });
    if (result.changedFiles) addEventLine('files', { text: result.changedFiles.map((file) => file.path).join(', ') });
    if (result.artifact && state.activeTask) {
      const existing = $('artifactLink'); if (existing) existing.remove();
      const link = document.createElement('a'); link.id = 'artifactLink';
      link.href = `/api/pages/tasks/${state.activeTask.id}/artifact`; link.textContent = '下载任务产物 result.json'; link.download = 'result.json';
      $('taskEvents').appendChild(link);
    }
  }
  function closeEvents() {
    if (state.events) { state.events.close(); state.events = null; }
  }
  function listenTask(taskId) {
    closeEvents();
    const events = new EventSource(`/api/pages/tasks/${encodeURIComponent(taskId)}/events`);
    state.events = events;
    for (const type of ['status', 'reasoning', 'output', 'progress', 'done', 'error']) {
      events.addEventListener(type, (event) => {
        let data; try { data = JSON.parse(event.data); } catch { data = { text: event.data }; }
        addEventLine(type, data);
        if (data.status) $('taskState').textContent = data.status;
        if (type === 'done') {
          closeEvents(); $('cancelTask').disabled = true;
          if (state.activeTask) { state.activeTask.status = data.status; state.activeTask.result = data.result || state.activeTask.result; }
          showTaskResult(data.result);
          refreshSite();
        }
        if (type === 'error') { closeEvents(); $('cancelTask').disabled = true; }
      });
    }
    events.addEventListener('end', () => { closeEvents(); $('cancelTask').disabled = true; refreshSite(); });
    events.onerror = () => { if (state.events === events) addEventLine('stream', { text: '事件流中断，浏览器将自动重连。' }); };
  }
  async function refreshSite() {
    if (!state.site) return;
    const id = state.site.id;
    const [detail, tasks] = await Promise.all([api(`/api/pages/sites/${id}`), api(`/api/pages/tasks?siteId=${id}`)]);
    state.site = detail.site; state.tasks = tasks.tasks;
    if (state.activeTask) state.activeTask = state.tasks.find((task) => task.id === state.activeTask.id) || state.activeTask;
    renderSite(); renderFiles(); renderVersions(); renderMaterials(); refreshPreview();
  }
  function refreshPreview() {
    if (!state.site || !state.site.previewPath) return;
    $('preview').src = `${state.site.previewPath}?t=${Date.now()}`;
  }

  async function digestFile(file) {
    const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  async function loadBackend() {
    if (!state.site) return;
    const result = await api(`/api/pages/sites/${state.site.id}/backend`);
    const backend = result.backend;
    $('backendState').textContent = backend ? backend.status : '未部署';
    $('backendRoute').textContent = backend ? `${backend.routePath} · ${backend.databaseName}` : '';
    $('stopBackend').disabled = !backend || backend.status !== 'running';
    $('startBackend').disabled = !backend || backend.status === 'running';
  }

  async function openAdmin() {
    const result = await api('/api/pages/admin/models');
    renderAdminModels(result.models); $('adminDialog').showModal();
  }
  function renderAdminModels(models) {
    const root = $('adminModels'); clearChildren(root);
    for (const model of models) {
      const row = document.createElement('div'); row.className = 'model-row';
      const description = document.createElement('span');
      description.textContent = `${model.id} · ${model.kind}${model.enabled ? '' : ' · 已停用'}${model.testOnly ? ' · 仅测试' : ''}`;
      row.append(description, button('编辑', () => editModel(model)), button('删除', async () => {
        if (!confirm(`删除模型配置 ${model.id}？不会删除任何任务或站点。`)) return;
        await api(`/api/pages/admin/models/${encodeURIComponent(model.id)}`, { method: 'DELETE' });
        await Promise.all([openAdminRefresh(), loadModels()]);
      }));
      root.appendChild(row);
    }
  }
  async function openAdminRefresh() { const result = await api('/api/pages/admin/models'); renderAdminModels(result.models); }
  function editModel(model) {
    $('modelOriginalId').value = model.id; $('modelId').value = model.id; $('modelKind').value = model.kind;
    $('modelBaseUrl').value = model.baseUrl || ''; $('modelName').value = model.model || '';
    $('modelKeyRef').value = model.keyRef || ''; $('modelEnabled').checked = model.enabled;
    $('modelFormTitle').textContent = `编辑 ${model.id}`; updateModelFields();
  }
  function resetModelForm() {
    $('modelForm').reset(); $('modelOriginalId').value = ''; $('modelEnabled').checked = true;
    $('modelFormTitle').textContent = '新增模型'; updateModelFields();
  }
  function updateModelFields() {
    const external = $('modelKind').value === 'openai-compatible';
    for (const id of ['modelBaseUrl', 'modelName', 'modelKeyRef']) $(id).disabled = !external;
    $('modelBaseUrl').required = external; $('modelName').required = external; $('modelKeyRef').required = external;
  }

  $('loginTab').addEventListener('click', () => setAuthMode('login'));
  $('registerTab').addEventListener('click', () => setAuthMode('register'));
  $('authForm').addEventListener('submit', async (event) => {
    event.preventDefault(); $('authSubmit').disabled = true;
    try {
      const credentials = { username: $('username').value, password: $('password').value };
      if (state.authMode === 'register') await api('/api/auth/register', { method: 'POST', json: credentials });
      const result = await api('/api/auth/login', { method: 'POST', json: credentials });
      $('password').value = ''; await showApp(result.user);
    } catch (error) { message('authMessage', errorText(error)); }
    finally { $('authSubmit').disabled = false; }
  });
  $('logout').addEventListener('click', async () => { try { await api('/api/auth/logout', { method: 'POST' }); } finally { closeEvents(); showAuth(); } });
  $('siteCreate').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const result = await api('/api/pages/sites', { method: 'POST', json: { name: $('siteName').value } });
      $('siteName').value = ''; await loadSites(result.site.id); message('status', '站点已创建。', false);
    } catch (error) { message('status', errorText(error)); }
  });
  $('modelSelect').addEventListener('change', updateModelNotice);
  $('taskForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.site) return;
    try {
      const result = await api(`/api/pages/sites/${state.site.id}/ai`, { method: 'POST', json: { prompt: $('prompt').value, modelId: $('modelSelect').value || undefined } });
      state.activeTask = result.task; clearChildren($('taskEvents'));
      $('taskState').textContent = result.task.status; $('cancelTask').disabled = false;
      if (result.note) addEventLine('note', { text: result.note });
      listenTask(result.task.id);
    } catch (error) { message('status', errorText(error)); }
  });
  $('cancelTask').addEventListener('click', async () => {
    if (!state.activeTask) return;
    try { const result = await api(`/api/pages/tasks/${state.activeTask.id}/cancel`, { method: 'POST' }); state.activeTask = result.task; $('taskState').textContent = result.task.status; }
    catch (error) { message('status', errorText(error)); }
  });
  $('materialForm').addEventListener('submit', async (event) => {
    event.preventDefault(); if (!state.site) return;
    try {
      for (const file of $('materialInput').files) {
        message('status', `正在上传 ${file.name}…`, false);
        const sha256 = await digestFile(file);
        await api(`/api/pages/sites/${state.site.id}/materials/${encodedPath(file.name)}`, {
          method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'x-file-size': String(file.size), 'x-file-sha256': sha256 }, body: file
        });
      }
      $('materialInput').value = ''; await refreshSite(); message('status', '材料上传完成。', false);
    } catch (error) { message('status', errorText(error)); }
  });
  $('newFile').addEventListener('click', () => { state.selectedPath = null; $('filePath').value = 'index.html'; $('fileContent').value = '<!doctype html>\n<title>新页面</title>\n<h1>新页面</h1>'; renderFiles(); });
  $('saveFile').addEventListener('click', async () => {
    if (!state.site) return;
    try {
      const filePath = $('filePath').value;
      await api(`/api/pages/sites/${state.site.id}/files/${encodedPath(filePath)}`, { method: 'PUT', json: { content: $('fileContent').value } });
      state.selectedPath = filePath; await refreshSite(); message('status', '工作文件已保存；发布后才会公开。', false);
    } catch (error) { message('status', errorText(error)); }
  });
  $('deleteFile').addEventListener('click', async () => {
    if (!state.site || !$('filePath').value || !confirm(`删除工作文件 ${$('filePath').value}？历史修订仍保留。`)) return;
    try { await api(`/api/pages/sites/${state.site.id}/files/${encodedPath($('filePath').value)}`, { method: 'DELETE' }); state.selectedPath = null; await refreshSite(); }
    catch (error) { message('status', errorText(error)); }
  });
  $('publish').addEventListener('click', async () => {
    try { const result = await api(`/api/pages/sites/${state.site.id}/publish`, { method: 'POST' }); await refreshSite(); message('status', `已发布 v${result.version}。`, false); }
    catch (error) { message('status', errorText(error)); }
  });
  $('rollback').addEventListener('click', async () => {
    if (!$('versionSelect').value) return;
    try { const result = await api(`/api/pages/sites/${state.site.id}/rollback`, { method: 'POST', json: { version: Number($('versionSelect').value) } }); await refreshSite(); message('status', `已恢复 v${result.rolledBackTo} 到工作区与公开指针。`, false); }
    catch (error) { message('status', errorText(error)); }
  });
  $('refreshSite').addEventListener('click', () => refreshSite().catch((error) => message('status', errorText(error))));
  $('loadVersions').addEventListener('click', () => refreshSite().catch((error) => message('status', errorText(error))));
  $('refreshPreview').addEventListener('click', refreshPreview);
  $('deployBackend').addEventListener('click', async () => {
    try { await api(`/api/pages/sites/${state.site.id}/backend`, { method: 'POST', json: { source: $('backendSource').value } }); await loadBackend(); message('status', '租户后端已部署并启动。', false); }
    catch (error) { message('status', errorText(error)); await loadBackend().catch(() => {}); }
  });
  $('stopBackend').addEventListener('click', async () => { try { await api(`/api/pages/sites/${state.site.id}/backend/stop`, { method: 'POST' }); await loadBackend(); } catch (error) { message('status', errorText(error)); } });
  $('startBackend').addEventListener('click', async () => { try { await api(`/api/pages/sites/${state.site.id}/backend/start`, { method: 'POST' }); await loadBackend(); } catch (error) { message('status', errorText(error)); } });
  $('adminOpen').addEventListener('click', () => openAdmin().catch((error) => message('status', errorText(error))));
  $('modelKind').addEventListener('change', updateModelFields);
  $('modelReset').addEventListener('click', resetModelForm);
  $('modelForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const kind = $('modelKind').value; const id = $('modelOriginalId').value || $('modelId').value;
      const body = { kind, enabled: $('modelEnabled').checked };
      if (kind === 'openai-compatible') Object.assign(body, { baseUrl: $('modelBaseUrl').value, model: $('modelName').value, keyRef: $('modelKeyRef').value });
      await api(`/api/pages/admin/models/${encodeURIComponent(id)}`, { method: 'PUT', json: body });
      resetModelForm(); await Promise.all([openAdminRefresh(), loadModels()]);
    } catch (error) { message('status', errorText(error)); }
  });

  setAuthMode('login'); updateModelFields();
  api('/api/me').then((result) => showApp(result.user)).catch(() => showAuth());
})();
