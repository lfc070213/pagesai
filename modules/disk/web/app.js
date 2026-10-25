'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const state = {
    authMode: 'login', user: null, files: [], quota: null, selected: null,
    includeDeleted: false, activeUpload: null, shareToken: null, shares: []
  };

  function message(id, value, isError = true) {
    const node = $(id);
    if (!node) return;
    node.textContent = value || '';
    node.classList.toggle('error', Boolean(isError && value));
    node.classList.toggle('success', Boolean(!isError && value));
  }
  function clearChildren(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function button(label, onClick, className = '') {
    const node = document.createElement('button');
    node.type = 'button'; node.textContent = label; node.className = className;
    node.addEventListener('click', onClick);
    return node;
  }
  function link(label, href, className = 'button') {
    const node = document.createElement('a');
    node.textContent = label; node.href = href; node.className = className;
    return node;
  }
  function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KiB', 'MiB', 'GiB', 'TiB'];
    let size = bytes / 1024;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
    return `${size.toFixed(size >= 10 ? 1 : 2)} ${units[unit]}`;
  }
  function formatTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }

  async function api(path, options = {}) {
    const request = { credentials: 'same-origin', ...options, headers: { ...(options.headers || {}) } };
    if (request.json !== undefined) {
      request.headers['content-type'] = 'application/json';
      request.body = JSON.stringify(request.json);
      delete request.json;
    }
    const response = await fetch(path, request);
    if (response.status === 401 && !path.startsWith('/api/auth/') && path !== '/api/me' && !path.startsWith('/api/disk/shares/')) {
      showAuth('会话已失效，请重新登录。');
    }
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) {
      const failure = new Error(payload && payload.message ? payload.message : `HTTP ${response.status}`);
      failure.code = payload && payload.code;
      failure.status = response.status;
      failure.details = payload && payload.details;
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
    state.user = null;
    $('appView').hidden = true; $('shareView').hidden = true; $('authView').hidden = false;
    if (note) message('authMessage', note);
  }
  async function showApp(user) {
    state.user = user;
    $('authView').hidden = true; $('shareView').hidden = true; $('appView').hidden = false;
    $('currentUser').textContent = `${user.username} · ${user.role}`;
    await loadFiles();
  }

  async function loadFiles() {
    const query = state.includeDeleted ? '?includeDeleted=1' : '';
    const result = await api(`/api/disk/files${query}`);
    state.files = result.files;
    state.quota = result.quota;
    $('chunkInfo').textContent = `${formatBytes(result.chunkSizeBytes)} / 上限 ${formatBytes(result.maxChunkBytes)}`;
    $('regionName').textContent = (result.regions && result.regions[0]) || 'disk.user-files';
    renderQuota();
    renderFiles();
    if (state.selected) {
      const fresh = state.files.find((file) => file.fileId === state.selected.fileId);
      if (fresh) { state.selected = fresh; renderDetail(); }
      else { state.selected = null; $('detailCard').hidden = true; }
    }
  }

  function renderQuota() {
    const quota = state.quota;
    if (!quota) return;
    $('quotaText').textContent = `${formatBytes(quota.usedBytes)} / ${formatBytes(quota.quotaBytes)} · ${quota.fileCount} 个文件`;
    const ratio = quota.quotaBytes > 0 ? Math.min(100, (quota.usedBytes / quota.quotaBytes) * 100) : 0;
    $('quotaBar').style.width = `${ratio.toFixed(1)}%`;
    $('quotaBar').classList.toggle('warn', ratio > 85);
  }

  function renderFiles() {
    const rows = $('fileRows');
    clearChildren(rows);
    for (const file of state.files) {
      const row = document.createElement('tr');
      row.classList.toggle('deleted', file.status === 'deleted');
      const name = document.createElement('td');
      const nameButton = button(file.name, () => selectFile(file.fileId), 'link-button');
      name.appendChild(nameButton);
      row.appendChild(name);
      row.appendChild(cell(formatBytes(file.size)));
      row.appendChild(cell(file.status === 'active' ? '正常' : '已删除'));
      row.appendChild(cell(String(file.revision)));
      row.appendChild(cell(formatTime(file.updatedAt)));
      const actions = document.createElement('td');
      const actionWrap = document.createElement('div');
      actionWrap.className = 'row-actions';
      if (file.status === 'active') {
        actionWrap.appendChild(link('下载', `/api/disk/files/${encodeURIComponent(file.fileId)}/content`, 'button small'));
        actionWrap.appendChild(button('删除', () => deleteFile(file), 'small'));
      } else {
        actionWrap.appendChild(button('恢复', () => restoreFile(file), 'small primary'));
      }
      actions.appendChild(actionWrap);
      row.appendChild(actions);
      rows.appendChild(row);
    }
    $('emptyFiles').hidden = state.files.length > 0;
  }
  function cell(text) {
    const node = document.createElement('td');
    node.textContent = text;
    return node;
  }

  async function selectFile(fileId) {
    const result = await api(`/api/disk/files/${encodeURIComponent(fileId)}`);
    state.selected = result.file;
    $('newShareLink').hidden = true;
    $('newShareLink').textContent = '';
    renderDetail();
    await loadShares(fileId);
  }
  function renderDetail() {
    const file = state.selected;
    if (!file) { $('detailCard').hidden = true; return; }
    $('detailCard').hidden = false;
    $('detailName').textContent = file.name;
    $('detailId').textContent = file.fileId;
    $('detailSize').textContent = formatBytes(file.size);
    $('detailRevision').textContent = String(file.revision);
    $('detailHash').textContent = file.sha256 || file.contentHash || '—';
    $('detailStatus').textContent = file.status === 'active' ? '正常' : `已删除 · ${formatTime(file.deletedAt)}`;
    $('detailDownload').href = `/api/disk/files/${encodeURIComponent(file.fileId)}/content`;
    $('detailNewVersion').hidden = file.status !== 'active';
    $('detailDelete').hidden = file.status !== 'active';
    $('detailRestore').hidden = file.status === 'active';
    $('createShare').disabled = file.status !== 'active';
  }

  async function loadShares(fileId) {
    try {
      const result = await api(`/api/disk/files/${encodeURIComponent(fileId)}/shares`);
      state.shares = result.shares;
    } catch { state.shares = []; }
    renderShares();
  }
  function renderShares() {
    const list = $('shareList');
    clearChildren(list);
    for (const share of state.shares) {
      const item = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = `有效期至 ${formatTime(share.expiresAt)}${share.revokedAt ? ' · 已撤销' : ''}`;
      item.appendChild(label);
      if (!share.revokedAt) item.appendChild(button('撤销', () => revokeShare(share.shareId), 'small'));
      list.appendChild(item);
    }
    if (!state.shares.length) {
      const item = document.createElement('li');
      item.className = 'muted';
      item.textContent = '暂无分享';
      list.appendChild(item);
    }
  }

  async function deleteFile(file) {
    if (!window.confirm(`删除“${file.name}”？内容会保留，可恢复。`)) return;
    try {
      await api(`/api/disk/files/${encodeURIComponent(file.fileId)}`, { method: 'DELETE', json: {} });
      message('status', '文件已软删，内容与配额保留。', false);
      await loadFiles();
    } catch (error) { message('status', error.message); }
  }
  async function restoreFile(file) {
    try {
      await api(`/api/disk/files/${encodeURIComponent(file.fileId)}/restore`, { method: 'POST', json: {} });
      message('status', '文件已恢复。', false);
      await loadFiles();
    } catch (error) { message('status', error.message); }
  }

  async function sha256Hex(file) {
    if (!window.crypto || !window.crypto.subtle) throw new Error('浏览器不支持 SHA-256 计算，请使用现代浏览器');
    const buffer = await file.arrayBuffer();
    const digest = await window.crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function setProgress(offset, size, label) {
    $('uploadProgress').hidden = false;
    const ratio = size > 0 ? Math.min(100, (offset / size) * 100) : 100;
    $('uploadBar').style.width = `${ratio.toFixed(1)}%`;
    $('uploadText').textContent = `${label || '上传中'} · ${formatBytes(offset)} / ${formatBytes(size)}`;
  }

  async function startUpload(file, target = null) {
    if (!file) return;
    message('status', '');
    $('retryUpload').hidden = true;
    try {
      const sha256 = await sha256Hex(file);
      setProgress(0, file.size, '初始化');
      const init = await api('/api/disk/uploads/init', {
        method: 'POST',
        json: {
          name: target ? target.name : file.name,
          size: file.size,
          sha256,
          mimeType: file.type || 'application/octet-stream',
          ...(target ? { fileId: target.fileId, baseRevision: target.revision } : {})
        }
      });
      state.activeUpload = { uploadId: init.uploadId, file, chunkSize: init.chunkSize, target };
      await continueUpload();
    } catch (error) {
      state.activeUpload = null;
      $('uploadProgress').hidden = true;
      message('status', `上传失败：${error.message}`);
    }
  }

  async function continueUpload() {
    const current = state.activeUpload;
    if (!current) return;
    const { uploadId, file } = current;
    $('retryUpload').hidden = true;
    $('cancelUpload').disabled = false;
    try {
      const status = await api(`/api/disk/uploads/${encodeURIComponent(uploadId)}`);
      let offset = status.upload.nextOffset;
      let index = status.upload.receivedChunks;
      const chunkSize = Math.max(1, Math.min(current.chunkSize, 64 * 1024 * 1024));
      while (offset < file.size) {
        const end = Math.min(offset + chunkSize, file.size);
        const slice = file.slice(offset, end);
        setProgress(offset, file.size, `分块 ${index + 1}`);
        await api(`/api/disk/uploads/${encodeURIComponent(uploadId)}/chunks/${index}/data`, {
          method: 'PUT',
          body: slice,
          headers: { 'content-type': 'application/octet-stream' }
        });
        offset = end;
        index += 1;
      }
      setProgress(file.size, file.size, '提交');
      const completed = await api(`/api/disk/uploads/${encodeURIComponent(uploadId)}/complete`, { method: 'POST', json: {} });
      state.activeUpload = null;
      setProgress(file.size, file.size, '完成');
      message('status', `已保存 ${completed.file.name}（修订 ${completed.file.revision}）。`, false);
      await loadFiles();
      if (state.selected && state.selected.fileId === completed.file.fileId) await selectFile(completed.file.fileId);
      setTimeout(() => { $('uploadProgress').hidden = true; }, 1200);
    } catch (error) {
      $('cancelUpload').disabled = true;
      if (error.status === 413) {
        state.activeUpload = null;
        message('status', `上传失败：${error.message}`);
        return;
      }
      message('status', `上传中断：${error.message}。可点击“继续上传”从中断处恢复。`);
      $('retryUpload').hidden = false;
      $('retryUpload').onclick = () => continueUpload();
    }
  }

  async function cancelUpload() {
    const current = state.activeUpload;
    if (!current) return;
    try { await api(`/api/disk/uploads/${encodeURIComponent(current.uploadId)}`, { method: 'DELETE' }); }
    catch { /* 已提交或已清理 */ }
    state.activeUpload = null;
    $('uploadProgress').hidden = true;
    message('status', '上传已取消，预留配额已释放。', false);
  }

  async function createShare() {
    if (!state.selected) return;
    try {
      const result = await api(`/api/disk/files/${encodeURIComponent(state.selected.fileId)}/shares`, { method: 'POST', json: {} });
      const absolute = new URL(result.urlPath, window.location.origin).toString();
      $('newShareLink').hidden = false;
      $('newShareLink').textContent = `分享链接（仅本次显示令牌）：${absolute}`;
      await loadShares(state.selected.fileId);
    } catch (error) { message('status', error.message); }
  }
  async function revokeShare(shareId) {
    try {
      await api(`/api/disk/shares/${encodeURIComponent(shareId)}`, { method: 'DELETE' });
      message('status', '分享已撤销。', false);
      if (state.selected) await loadShares(state.selected.fileId);
    } catch (error) { message('status', error.message); }
  }

  async function showShare(token) {
    $('authView').hidden = true; $('appView').hidden = true; $('shareView').hidden = false;
    state.shareToken = token;
    message('shareMessage', '');
    $('shareDownload').hidden = true;
    try {
      const result = await api(`/api/disk/shares/${encodeURIComponent(token)}`);
      $('shareName').textContent = result.file.name;
      $('shareMeta').textContent = `${formatBytes(result.file.size)} · 有效期至 ${formatTime(result.expiresAt)} · 只读`;
      $('shareDownload').href = `/api/disk/shares/${encodeURIComponent(token)}/content`;
      $('shareDownload').hidden = false;
    } catch (error) {
      $('shareName').textContent = '分享不可用';
      $('shareMeta').textContent = '';
      message('shareMessage', error.message);
    }
  }

  // -- 绑定 -----------------------------------------------------------------

  $('loginTab').addEventListener('click', () => setAuthMode('login'));
  $('registerTab').addEventListener('click', () => setAuthMode('register'));
  $('authForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    message('authMessage', '');
    const credentials = { username: $('username').value.trim(), password: $('password').value };
    try {
      if (state.authMode === 'register') await api('/api/auth/register', { method: 'POST', json: credentials });
      const result = await api('/api/auth/login', { method: 'POST', json: credentials });
      $('password').value = '';
      await showApp(result.user);
    } catch (error) { message('authMessage', error.message); }
  });
  $('logout').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* 会话可能已失效 */ }
    showAuth();
  });
  $('refreshFiles').addEventListener('click', () => loadFiles().catch((error) => message('status', error.message)));
  $('includeDeleted').addEventListener('change', (event) => {
    state.includeDeleted = event.target.checked;
    loadFiles().catch((error) => message('status', error.message));
  });
  $('fileInput').addEventListener('change', async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    for (const file of files) await startUpload(file);
  });
  $('dropzone').addEventListener('dragover', (event) => { event.preventDefault(); $('dropzone').classList.add('dragover'); });
  $('dropzone').addEventListener('dragleave', () => $('dropzone').classList.remove('dragover'));
  $('dropzone').addEventListener('drop', async (event) => {
    event.preventDefault(); $('dropzone').classList.remove('dragover');
    const files = Array.from(event.dataTransfer && event.dataTransfer.files || []);
    for (const file of files) await startUpload(file);
  });
  $('cancelUpload').addEventListener('click', cancelUpload);
  $('closeDetail').addEventListener('click', () => { state.selected = null; $('detailCard').hidden = true; });
  $('detailNewVersion').addEventListener('click', () => {
    if (!state.selected) return;
    $('versionInput').click();
  });
  $('versionInput').addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (file && state.selected) await startUpload(file, state.selected);
  });
  $('detailDelete').addEventListener('click', () => { if (state.selected) deleteFile(state.selected); });
  $('detailRestore').addEventListener('click', () => { if (state.selected) restoreFile(state.selected); });
  $('createShare').addEventListener('click', createShare);

  const shareMatch = /^#share=(.+)$/.exec(window.location.hash || '');
  if (shareMatch) {
    showShare(decodeURIComponent(shareMatch[1]));
  } else {
    $('authView').hidden = false;
    api('/api/me').then((result) => showApp(result.user)).catch(() => showAuth());
  }
})();
