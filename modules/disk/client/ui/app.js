(function () {
  const tauri = window.__TAURI__;
  const invoke = tauri && tauri.core && tauri.core.invoke;
  const $ = (id) => document.getElementById(id);
  const state = { status: null, busy: false };

  function log(line) {
    const node = $('log');
    const stamp = new Date().toLocaleTimeString();
    node.textContent = `[${stamp}] ${line}\n${node.textContent === '尚未操作。' ? '' : node.textContent}`;
  }

  function showStatus() {
    const value = state.status;
    const pill = $('statusPill');
    if (!value) {
      pill.textContent = '无法连接桌面后端';
      pill.className = 'status bad';
      return;
    }
    const paired = Boolean(value.paired);
    pill.textContent = value.syncing ? '同步中…' : paired ? '已配对' : '未配对';
    pill.className = `status ${paired ? 'ok' : ''}`;
    $('pairCard').hidden = paired;
    $('syncCard').hidden = false;
    $('pairButton').hidden = paired;
    $('unpairButton').hidden = !paired;
    $('syncButton').hidden = !paired;
    $('saveButton').hidden = !paired;
    $('campusRow').hidden = !value.strategy || !value.strategy.includesCampus;
    $('factDevice').textContent = paired ? `${value.settings.deviceName || '设备'} (${value.settings.deviceId})` : '—';
    $('factStrategy').textContent = value.strategy
      ? `${value.strategy.name}${value.strategy.includesCampus ? '（含校园策略）' : '（不含校园实现）'}`
      : '—';
    $('factRoot').textContent = value.settings.root || '—';
    $('factService').textContent = value.settings.serviceUrl || '—';
    $('factCursor').textContent = value.syncState && value.syncState.cursor != null ? String(value.syncState.cursor) : '—';
    $('factPending').textContent = value.syncState ? String(value.syncState.pending) : '—';
    $('factLastSync').textContent = value.syncState && value.syncState.lastSyncAt ? String(value.syncState.lastSyncAt) : '—';
    if (document.activeElement !== $('intervalMinutes')) $('intervalMinutes').value = String(value.settings.intervalMinutes ?? 15);
    $('syncOnLaunch').checked = Boolean(value.settings.syncOnLaunch);
    $('autoStart').checked = Boolean(value.settings.autoStart);
    if (document.activeElement !== $('serviceUrl')) $('serviceUrl').value = value.settings.serviceUrl || '';
    if (document.activeElement !== $('root')) $('root').value = value.settings.root || '';
    if (document.activeElement !== $('campusEndpoint')) $('campusEndpoint').value = value.settings.campusEndpoint || '';
    if (document.activeElement !== $('deviceName')) $('deviceName').value = value.settings.deviceName || '';
  }

  async function refresh() {
    try {
      state.status = await invoke('get_status');
      showStatus();
    } catch (error) {
      $('statusPill').textContent = `状态读取失败：${error}`;
      $('statusPill').className = 'status bad';
    }
  }

  async function guarded(label, task) {
    if (state.busy) return;
    state.busy = true;
    document.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    try {
      log(`${label}…`);
      const result = await task();
      log(`${label}完成：${JSON.stringify(result)}`);
      await refresh();
    } catch (error) {
      log(`${label}失败：${error && error.message ? error.message : error}`);
    } finally {
      state.busy = false;
      document.querySelectorAll('button').forEach((button) => { button.disabled = false; });
    }
  }

  $('pairButton').addEventListener('click', () => guarded('配对', () => invoke('pair', {
    request: {
      serviceUrl: $('serviceUrl').value.trim(),
      code: $('pairCode').value.trim(),
      root: $('root').value.trim(),
      deviceName: $('deviceName').value.trim(),
      campusEndpoint: $('campusEndpoint').value.trim(),
    },
  })));

  $('unpairButton').addEventListener('click', () => {
    if (!window.confirm('解除配对会撤销本机设备令牌并停止同步，但不会删除本地文件。继续？')) return;
    guarded('解除配对', () => invoke('unpair'));
  });

  $('syncButton').addEventListener('click', () => guarded('同步', () => invoke('sync_now')));

  $('saveButton').addEventListener('click', () => guarded('保存设置', () => invoke('save_preferences', {
    input: {
      root: $('root').value.trim(),
      campusEndpoint: $('campusEndpoint').value.trim(),
      intervalMinutes: Number($('intervalMinutes').value || 0),
      syncOnLaunch: $('syncOnLaunch').checked,
    },
  })));

  $('autoStart').addEventListener('change', () => guarded('更新开机自启动', () => invoke('set_auto_start', {
    enabled: $('autoStart').checked,
  })));

  $('updateButton').addEventListener('click', async () => {
    if (!tauri || !tauri.updater) {
      log('当前构建未启用更新插件。');
      return;
    }
    try {
      const update = await tauri.updater.check();
      log(update && update.available ? `发现新版本 ${update.version}` : '已是最新版本。');
    } catch (error) {
      log(`检查更新失败（签名与更新源由部署者配置）：${error}`);
    }
  });

  if (tauri && tauri.event) {
    tauri.event.listen('sync://report', (event) => {
      log(`后台同步：${JSON.stringify(event.payload.report || event.payload)}`);
      refresh();
    });
    tauri.event.listen('sync://error', (event) => {
      log(`后台同步失败：${event.payload.message}`);
    });
  }

  if (!invoke) {
    log('未检测到 Tauri 运行时；请通过桌面客户端打开。');
    return;
  }
  refresh();
  setInterval(refresh, 5000);
})();
