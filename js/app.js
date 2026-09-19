/*
 * 调试台页面逻辑
 * - Service Worker 注册 / 更新 / 卸载
 * - 规则配置（延迟、状态码、mock JSON、断网、随机丢包），写入 IndexedDB 后推送给所有 SW/标签页
 * - 录制真实请求（SW 写入 IndexedDB），断网后逐条重放并比对状态码、headers、body
 * - 多标签页：BroadcastChannel 广播 + IndexedDB 持久化 + storage 事件兜底
 */
(function () {
  'use strict';

  const DB = self.DebugDB;
  const channel = new BroadcastChannel('debug-console');
  const TAB_ID = 'tab-' + Math.random().toString(36).slice(2, 10);

  const els = {};
  let state = DB.defaultState();
  let records = [];
  let applying = false;

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ---------------- 与 Service Worker 通信 ---------------- */

  function sendToSW(message) {
    return new Promise((resolve, reject) => {
      if (!navigator.serviceWorker.controller) {
        reject(new Error('Service Worker 尚未控制当前页面，请刷新页面'));
        return;
      }
      const channel = new MessageChannel();
      channel.port1.onmessage = (event) => resolve(event.data);
      channel.port1.onmessageerror = () => reject(new Error('SW 消息错误'));
      navigator.serviceWorker.controller.postMessage(message, [channel.port2]);
      setTimeout(() => reject(new Error('等待 Service Worker 响应超时')), 3000);
    });
  }

  async function registerSW() {
    if (!('serviceWorker' in navigator)) {
      throw new Error('当前浏览器不支持 Service Worker');
    }
    const reg = await navigator.serviceWorker.register('./sw.js', {
      scope: './',
      updateViaCache: 'none'
    });

    if (reg.installing) await waitForSWState(reg.installing);
    if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });

    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          log('检测到 Service Worker 新版本，刷新页面后生效', 'warn');
        }
      });
    });

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      els.swStatus.textContent = '已激活（新版本已接管）';
      els.swStatus.className = 'ok';
      log('新 Service Worker 已接管当前页面', 'ok');
      if (navigator.serviceWorker.controller) {
        sendToSW({ type: 'GET_VERSION' })
          .then((reply) => { els.swVersion.textContent = reply.version; })
          .catch(() => {});
      }
    });

    let activated = false;
    if (navigator.serviceWorker.controller) activated = true;
    await navigator.serviceWorker.ready;

    let version = '?';
    if (navigator.serviceWorker.controller) {
      try {
        const reply = await sendToSW({ type: 'GET_VERSION' });
        version = reply.version;
      } catch (err) {
        /* 刷新后可恢复 */
      }
    }
    els.swVersion.textContent = version;
    els.swStatus.textContent = activated
      ? '已激活（' + version + '）'
      : '已安装，请刷新一次页面以接管请求';
    els.swStatus.className = activated ? 'ok' : 'warn';
    return reg;
  }

  function waitForSWState(worker) {
    return new Promise((resolve) => {
      if (worker.state === 'activated' || worker.state === 'redundant') {
        resolve();
        return;
      }
      worker.addEventListener('statechange', function onState() {
        if (worker.state === 'activated' || worker.state === 'redundant') {
          worker.removeEventListener('statechange', onState);
          resolve();
        }
      });
    });
  }

  async function updateSW() {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) {
      log('没有已注册的 Service Worker', 'warn');
      return;
    }
    await reg.update();
    log('已触发 Service Worker 更新检查', 'info');
  }

  async function unregisterSW() {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) await reg.unregister();
    log('Service Worker 已注销（旧的重放缓存会在下次安装新版时清理）', 'warn');
  }

  /* ---------------- 配置同步 ---------------- */

  async function persistAndPush(nextState, options) {
    options = options || {};
    applying = true;
    try {
      state = Object.assign({}, state, nextState, {
        updatedAt: Date.now(),
        updatedBy: TAB_ID
      });
      await DB.saveState(state);

      if (navigator.serviceWorker.controller) {
        await sendToSW({ type: 'STATE_UPDATED', origin: TAB_ID });
      }
      // 兜底：其他标签页即使错过 BroadcastChannel，也能通过 storage 事件感知
      localStorage.setItem('debug-console-bump', String(Date.now()));
      if (!options.skipRender) render();
      log('配置已下发到 Service Worker', 'info');
    } finally {
      applying = false;
    }
  }

  async function reloadFromDB(origin) {
    state = await DB.loadState();
    render();
    if (origin !== TAB_ID) log('已同步其他标签页的配置', 'info');
  }

  channel.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.type === 'state-changed') {
      if (msg.origin === TAB_ID) return;
      reloadFromDB('remote');
    } else if (msg.type === 'record-added') {
      refreshRecords();
    } else if (msg.type === 'records-cleared') {
      refreshRecords();
      log('其他标签页清空了录制记录', 'warn');
    } else if (msg.type === 'sw-activated') {
      els.swVersion.textContent = msg.version;
      log('Service Worker 已激活：' + msg.version + '，旧缓存已清理', 'ok');
      registerSW().catch(() => {});
    }
  });

  window.addEventListener('storage', (event) => {
    if (event.key === 'debug-console-bump') reloadFromDB('remote');
  });

  /* ---------------- 日志 ---------------- */

  function log(text, level) {
    const line = document.createElement('div');
    line.className = 'log-line ' + (level || 'info');
    const time = new Date().toLocaleTimeString();
    line.textContent = '[' + time + '] ' + text;
    els.logBody.appendChild(line);
    els.logBody.scrollTop = els.logBody.scrollHeight;
  }

  /* ---------------- 规则编辑 ---------------- */

  function blankRule() {
    return {
      id: 'rule-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      name: '新规则',
      enabled: true,
      kind: 'includes',
      pattern: '/api/',
      action: 'delay',
      delayMs: 3000,
      statusCode: 500,
      mockContentType: 'application/json;charset=UTF-8',
      mockBody: '{\n  "code": 500,\n  "message": "mocked by debug console"\n}',
      lossPercent: 50
    };
  }

  function collectRuleFromForm(li) {
    const rule = state.rules.find((item) => item.id === li.dataset.id) || blankRule();
    rule.name = li.querySelector('.rule-name').value;
    rule.enabled = li.querySelector('.rule-enabled').checked;
    rule.kind = li.querySelector('.rule-kind').value;
    rule.pattern = li.querySelector('.rule-pattern').value;
    rule.action = li.querySelector('.rule-action').value;
    rule.delayMs = Number(li.querySelector('.rule-delay').value) || 0;
    rule.statusCode = Number(li.querySelector('.rule-status').value) || 500;
    rule.mockContentType = li.querySelector('.rule-mock-type').value;
    rule.mockBody = li.querySelector('.rule-mock-body').value;
    rule.lossPercent = Number(li.querySelector('.rule-loss').value) || 0;
    return rule;
  }

  function renderRules() {
    els.rulesList.innerHTML = '';
    state.rules.forEach((rule) => {
      const li = document.createElement('li');
      li.className = 'rule-item';
      li.dataset.id = rule.id;
      li.innerHTML =
        '<div class="rule-head">' +
        '  <input class="rule-enabled" type="checkbox" ' + (rule.enabled ? 'checked' : '') + ' title="启用规则">' +
        '  <input class="rule-name" type="text" value="' + escapeHtml(rule.name) + '" placeholder="规则名称">' +
        '  <select class="rule-kind">' +
        '    <option value="includes"' + (rule.kind === 'includes' ? ' selected' : '') + '>包含匹配</option>' +
        '    <option value="regexp"' + (rule.kind === 'regexp' ? ' selected' : '') + '>正则匹配</option>' +
        '  </select>' +
        '  <button class="btn small danger rule-del">删除</button>' +
        '</div>' +
        '<input class="rule-pattern" type="text" value="' + escapeHtml(rule.pattern) + '" placeholder="URL 片段或正则，例如 /api/ 或 ^/api/v\\d+/">' +
        '<div class="rule-grid">' +
        '  <label>动作' +
        '    <select class="rule-action">' +
        '      <option value="delay"' + (rule.action === 'delay' ? ' selected' : '') + '>延迟 (1–30s)</option>' +
        '      <option value="status"' + (rule.action === 'status' ? ' selected' : '') + '>返回状态码</option>' +
        '      <option value="mock"' + (rule.action === 'mock' ? ' selected' : '') + '>返回 mock JSON</option>' +
        '      <option value="offline"' + (rule.action === 'offline' ? ' selected' : '') + '>直接断网</option>' +
        '      <option value="loss"' + (rule.action === 'loss' ? ' selected' : '') + '>随机丢包</option>' +
        '    </select>' +
        '  </label>' +
        '  <label class="field-delay">延迟毫秒<input class="rule-delay" type="number" min="0" max="30000" step="500" value="' + Number(rule.delayMs) + '"></label>' +
        '  <label class="field-status">状态码<input class="rule-status" type="number" min="100" max="599" value="' + Number(rule.statusCode) + '"></label>' +
        '  <label class="field-loss">丢包率 %<input class="rule-loss" type="number" min="0" max="100" value="' + Number(rule.lossPercent) + '"></label>' +
        '</div>' +
        '<label class="field-mock-type">Content-Type<input class="rule-mock-type" type="text" value="' + escapeHtml(rule.mockContentType) + '"></label>' +
        '<textarea class="rule-mock-body" rows="3" placeholder="mock 响应体（JSON）">' + escapeHtml(rule.mockBody) + '</textarea>';

      li.querySelector('.rule-del').addEventListener('click', () => {
        const current = collectRulesFromDOM();
        persistAndPush({
          rules: current.filter((item) => item.id !== rule.id)
        });
      });
      li.querySelectorAll('input,select,textarea').forEach((input) => {
        input.addEventListener('change', () => {
          persistAndPush({ rules: collectRulesFromDOM() });
        });
      });
      els.rulesList.appendChild(li);
    });
  }

  function collectRulesFromDOM() {
    return Array.from(els.rulesList.querySelectorAll('.rule-item')).map(collectRuleFromForm);
  }

  /* ---------------- 录制列表 ---------------- */

  async function refreshRecords() {
    records = await DB.getAllRecords();
    renderRecords();
  }

  function formatBytes(buffer) {
    if (!buffer) return '0 B';
    const bytes = buffer.byteLength || 0;
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  }

  function previewBody(buffer) {
    if (!buffer || !buffer.byteLength) return '';
    try {
      const text = new TextDecoder('utf-8').decode(new Uint8Array(buffer).slice(0, 200));
      return text.replace(/\s+/g, ' ').slice(0, 120);
    } catch (err) {
      return '[binary]';
    }
  }

  function renderRecords() {
    els.recordCount.textContent = String(records.length);
    els.recordsBody.innerHTML = '';
    records.forEach((record) => {
      const tr = document.createElement('tr');
      const resp = record.response;
      const isError = !resp || resp.kind === 'network-error';
      tr.innerHTML =
        '<td>' + escapeHtml(record.request.method) + '</td>' +
        '<td class="url" title="' + escapeHtml(record.request.url) + '">' + escapeHtml(record.request.url) + '</td>' +
        '<td class="' + (isError ? 'status-error' : 'status-ok') + '">' +
          (isError ? 'NETWORK ERROR' : resp.status) +
        '</td>' +
        '<td>' + formatBytes(record.request.body) + '</td>' +
        '<td>' + formatBytes(isError ? null : resp.body) + '</td>' +
        '<td class="muted" title="' + escapeHtml(isError ? (resp && resp.errorMessage) || '' : previewBody(resp.body)) + '">' +
          escapeHtml(isError ? ((resp && resp.errorName) || 'Error') : previewBody(resp.body)) +
        '</td>';
      els.recordsBody.appendChild(tr);
    });
  }

  async function clearRecords() {
    if (records.length && !confirm('确认清空全部 ' + records.length + ' 条录制记录及其重放缓存？')) return;
    if (navigator.serviceWorker.controller) {
      await sendToSW({ type: 'CLEAR_RECORDS' });
    } else {
      await DB.clearStore('records');
    }
    await refreshRecords();
    log('录制记录与重放缓存已清空', 'warn');
  }

  /* ---------------- 重放 ---------------- */

  const STRIPPED_REQUEST_HEADERS = new Set([
    'content-length',
    'host',
    'connection',
    'cache-control',
    'pragma',
    'x-debug-replay-id'
  ]);

  function buildReplayRequest(record) {
    const init = {
      method: record.request.method,
      headers: {}
    };
    record.request.headers.forEach(([key, value]) => {
      if (!STRIPPED_REQUEST_HEADERS.has(key.toLowerCase())) {
        init.headers[key] = value;
      }
    });
    if (record.request.body && record.request.body.byteLength) {
      init.body = record.request.body;
    }
    // 自定义头让 SW 能精确找到录制快照，即使 URL 重复也不会错配
    init.headers['X-Debug-Replay-Id'] = record.id;
    return new Request(record.request.url, init);
  }

  function headersToObject(entries) {
    const obj = {};
    (entries || []).forEach(([key, value]) => {
      const lower = key.toLowerCase();
      if (lower === 'content-encoding' || lower === 'content-length') return;
      obj[key] = value;
    });
    return obj;
  }

  async function textFromBuffer(buffer) {
    if (!buffer) return '';
    return new TextDecoder('utf-8').decode(new Uint8Array(buffer));
  }

  async function replayAll() {
    if (!records.length) {
      log('没有可重放的录制记录', 'warn');
      return;
    }
    if (!navigator.serviceWorker.controller) {
      log('Service Worker 未接管，无法重放', 'error');
      return;
    }

    const wasOffline = !!state.offline;
    await persistAndPush({ enabled: false, offline: true, rules: [] });
    log('已进入离线模式，开始重放 ' + records.length + ' 条录制请求…', 'info');

    // 先验证离线生效：一个没有录制快照的请求必须失败
    let offlineWorks = false;
    try {
      await fetch('./api/__offline_probe__?t=' + Date.now());
    } catch (err) {
      offlineWorks = true;
    }
    if (!offlineWorks) {
      log('离线探针意外成功，中止重放以保证结果可信', 'error');
      if (!wasOffline) await persistAndPush({ offline: false });
      return;
    }

    const results = [];
    for (const record of records) {
      const expected = record.response;
      const request = buildReplayRequest(record);
      const started = performance.now();
      let actual = null;
      let failure = null;

      try {
        const response = await fetch(request);
        actual = {
          kind: 'response',
          status: response.status,
          headers: Array.from(response.headers.entries()),
          body: await response.clone().arrayBuffer()
        };
      } catch (err) {
        failure = err;
        actual = { kind: 'network-error', errorName: err.name, errorMessage: err.message };
      }

      const expectedIsError = !expected || expected.kind === 'network-error';
      const actualIsError = actual.kind === 'network-error';
      const sameKind = expectedIsError === actualIsError;

      let sameStatus = true;
      let sameBody = true;
      if (!expectedIsError && !actualIsError) {
        sameStatus = expected.status === actual.status;
        const expectedText = await textFromBuffer(expected.body);
        const actualText = await textFromBuffer(actual.body);
        sameBody = expectedText === actualText;
      }

      const match = sameKind && sameStatus && sameBody;
      results.push({
        record,
        actual,
        failure,
        match,
        durationMs: Math.round(performance.now() - started)
      });
      log(
        (match ? '✓ 一致' : '✗ 不一致') +
          ' ' + record.request.method + ' ' + record.request.url +
          (expectedIsError ? '（录制为网络错误）' : '（录制状态 ' + expected.status + '）') +
          ' ' + Math.round(performance.now() - started) + 'ms',
        match ? 'ok' : 'error'
      );
    }

    renderReplayResults(results);
    const passed = results.filter((item) => item.match).length;
    log('重放完成：' + passed + '/' + results.length + ' 条与录制一致', passed === results.length ? 'ok' : 'error');

    if (!wasOffline) {
      await persistAndPush({ offline: false });
      log('已恢复在线状态', 'info');
    }
  }

  function renderReplayResults(results) {
    els.replayBody.innerHTML = '';
    results.forEach((item) => {
      const tr = document.createElement('tr');
      const expected = item.record.response;
      const expectedText = expected && expected.kind === 'response'
        ? 'status ' + expected.status
        : 'network error';
      const actualText = item.actual.kind === 'response'
        ? 'status ' + item.actual.status
        : 'network error';
      tr.innerHTML =
        '<td>' + escapeHtml(item.record.request.method) + '</td>' +
        '<td class="url" title="' + escapeHtml(item.record.request.url) + '">' + escapeHtml(item.record.request.url) + '</td>' +
        '<td>' + escapeHtml(expectedText) + '</td>' +
        '<td>' + escapeHtml(actualText) + '</td>' +
        '<td>' + item.durationMs + 'ms</td>' +
        '<td class="' + (item.match ? 'status-ok' : 'status-error') + '">' +
          (item.match ? '一致' : '不一致') +
        '</td>';
      els.replayBody.appendChild(tr);
    });
  }

  /* ---------------- 演示流量 ---------------- */

  async function generateTraffic(count) {
    const base = /^https?:$/.test(location.protocol) ? location.origin : 'http://localhost:3000';
    const endpoints = [
      { method: 'GET', path: '/api/users' },
      { method: 'GET', path: '/api/orders' },
      { method: 'POST', path: '/api/echo', body: { hello: 'world' } },
      { method: 'PUT', path: '/api/echo', body: { updated: true } },
      { method: 'GET', path: '/api/slow' },
      { method: 'DELETE', path: '/api/items/42' }
    ];
    let ok = 0;
    for (let i = 0; i < count; i++) {
      const ep = endpoints[i % endpoints.length];
      const url = base + ep.path + '?n=' + i + '&t=' + Date.now();
      const init = {
        method: ep.method,
        headers: { 'X-Request-Index': String(i) }
      };
      if (ep.body) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(Object.assign({}, ep.body, { index: i }));
      }
      try {
        const response = await fetch(url, init);
        if (response.ok) ok++;
      } catch (err) {
        /* 故障注入下失败是预期行为 */
      }
    }
    log('已发出 ' + count + ' 个演示请求（' + ok + ' 个成功，其余按规则失败）', 'info');
    await refreshRecords();
  }

  /* ---------------- 标签页列表 ---------------- */

  async function heartbeat() {
    const tabs = await DB.loadTabs();
    const now = Date.now();
    Object.keys(tabs).forEach((id) => {
      if (now - tabs[id].at > 8000) delete tabs[id];
    });
    tabs[TAB_ID] = { at: now, title: document.title };
    await DB.saveTabs(tabs);
    renderTabs(tabs);
  }

  function renderTabs(tabs) {
    const ids = Object.keys(tabs);
    els.tabCount.textContent = String(ids.length);
    els.tabsBody.innerHTML = '';
    ids.forEach((id) => {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td>' + escapeHtml(id) + (id === TAB_ID ? '（当前）' : '') + '</td>' +
        '<td>' + new Date(tabs[id].at).toLocaleTimeString() + '</td>' +
        '<td>' + (id === state.updatedBy ? '<span class="status-ok">最近更新配置</span>' : '受控中') + '</td>';
      els.tabsBody.appendChild(tr);
    });
  }

  channel.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.type === 'tab-hello') {
      DB.loadTabs().then(renderTabs);
    }
  });

  /* ---------------- 渲染 ---------------- */

  function render() {
    els.toggleEnabled.checked = !!state.enabled;
    els.toggleOffline.checked = !!state.offline;
    els.toggleRecording.checked = !!state.recording;
    els.toggleEnabled.disabled = false;
    renderRules();

    const badges = [];
    if (state.enabled) badges.push('故障注入：开');
    if (state.offline) badges.push('离线模拟：开');
    if (state.recording) badges.push('录制中');
    els.statusBar.textContent = badges.length ? badges.join(' · ') : '全部关闭（请求正常透传）';
    els.statusBar.className = badges.length ? 'active' : 'idle';
  }

  function bindEvents() {
    els.toggleEnabled.addEventListener('change', () => {
      persistAndPush({ enabled: els.toggleEnabled.checked });
    });
    els.toggleOffline.addEventListener('change', () => {
      persistAndPush({ offline: els.toggleOffline.checked });
    });
    els.toggleRecording.addEventListener('change', () => {
      persistAndPush({ recording: els.toggleRecording.checked });
    });
    $('add-rule').addEventListener('click', () => {
      const rules = collectRulesFromDOM();
      rules.push(blankRule());
      persistAndPush({ rules });
    });
    $('clear-rules').addEventListener('click', () => {
      persistAndPush({ rules: [] });
    });
    $('clear-records').addEventListener('click', clearRecords);
    $('replay-all').addEventListener('click', () => {
      replayAll().catch((err) => log('重放失败：' + err.message, 'error'));
    });
    $('gen-traffic').addEventListener('click', () => generateTraffic(20));
    $('gen-one').addEventListener('click', () => generateTraffic(1));
    $('sw-update').addEventListener('click', () => updateSW());
    $('sw-unregister').addEventListener('click', () => unregisterSW());
  }

  function cacheElements() {
    [
      'sw-status', 'sw-version', 'rules-list', 'toggle-enabled', 'toggle-offline',
      'toggle-recording', 'status-bar', 'record-count', 'records-body',
      'replay-body', 'tab-count', 'tabs-body', 'log-body'
    ].forEach((id) => {
      const camel = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      els[camel] = $(id);
    });
  }

  async function init() {
    cacheElements();
    bindEvents();

    state = await DB.loadState();
    render();
    await refreshRecords();

    try {
      await registerSW();
      // SW 启动后立刻拉一次持久化配置，保证与其它标签页一致
      await reloadFromDB('init');
      log('调试台已就绪', 'ok');
    } catch (err) {
      els.swStatus.textContent = '注册失败：' + err.message;
      els.swStatus.className = 'error';
      log('Service Worker 注册失败：' + err.message + '（需通过 http/https 访问，不能 file://）', 'error');
    }

    await heartbeat();
    setInterval(heartbeat, 3000);
    try {
      channel.postMessage({ type: 'tab-hello' });
    } catch (err) {
      /* ignore */
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
