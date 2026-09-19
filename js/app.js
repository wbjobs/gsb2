/* 调试台页面逻辑 */
(function () {
  'use strict';

  const DB = window.DebugDB;
  const Rules = window.DebugRules;

  const state = {
    config: { rules: [], recording: false, replay: false, configVersion: 0 },
    recCount: 0,
    registration: null,
    swVersion: null,
  };

  const channel = ('BroadcastChannel' in window) ? new BroadcastChannel('gsb-debug') : null;
  const tabId = 'tab-' + Math.random().toString(36).slice(2, 9);
  const peers = {};

  const $ = function (id) { return document.getElementById(id); };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function log(msg, level) {
    const box = $('eventLog');
    const line = document.createElement('div');
    line.className = 'log-line';
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false }) +
      '.' + String(Date.now() % 1000).padStart(3, '0');
    line.innerHTML = '<span class="log-time">' + t + '</span>' +
      '<span class="log-' + (level || 'info') + '">' + esc(msg) + '</span>';
    box.appendChild(line);
    while (box.children.length > 200) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
  }

  /* ---------------- SW 注册与生命周期 ---------------- */

  async function registerSW() {
    if (!('serviceWorker' in navigator)) {
      $('swStatus').textContent = 'SW: 浏览器不支持';
      return;
    }
    try {
      const reg = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
      state.registration = reg;
      markSWActive();
      if (!navigator.serviceWorker.controller && reg.installing) {
        reg.installing.addEventListener('statechange', function () {
          if (reg.installing && reg.installing.state === 'activated') postSW({ type: 'GET_STATE' });
        });
      }
      reg.addEventListener('updatefound', function () {
        const nw = reg.installing;
        if (!nw) return;
        log('发现新 SW，等待激活…', 'warn');
        nw.addEventListener('statechange', function () {
          log('新 SW 状态: ' + nw.state, 'warn');
        });
      });
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (refreshing) return;
        refreshing = true;
        log('SW 已接管页面，即将刷新以应用新版本', 'warn');
        setTimeout(function () { location.reload(); }, 600);
      });
    } catch (e) {
      $('swStatus').textContent = 'SW: 注册失败';
      log('SW 注册失败: ' + e.message + '（需要 http://localhost 或 https 打开）', 'err');
    }
  }

  function markSWActive() {
    $('swStatus').textContent = 'SW: 已激活';
    $('swStatus').className = 'badge badge-on';
    postSW({ type: 'GET_STATE' });
  }

  function postSW(msg) {
    const sw = navigator.serviceWorker.controller ||
      (state.registration && state.registration.active);
    if (sw) sw.postMessage(msg);
  }

  /* ---------------- 配置同步（SW + BroadcastChannel + storage 兜底） ---------------- */

  async function saveConfig(patch, opts) {
    const cfg = Object.assign({}, state.config, patch, {
      configVersion: (state.config.configVersion || 0) + 1,
    });
    state.config = cfg;
    await DB.setConfig(cfg);
    postSW({ type: 'SET_CONFIG', config: cfg, origin: opts && opts.origin });
    if (channel) channel.postMessage({ type: 'CONFIG_UPDATED', config: cfg, origin: tabId });
    renderAll();
  }

  /* ---------------- 规则管理 ---------------- */

  function readRuleForm() {
    return {
      id: 'rule-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      enabled: true,
      matchType: $('fMatchType').value,
      pattern: $('fPattern').value.trim(),
      method: $('fMethod').value,
      action: $('fAction').value,
      delayMs: Number($('fDelay').value) || 0,
      status: Number($('fStatus').value) || 500,
      lossPercent: Number($('fLoss').value) || 0,
      body: $('fBody').value,
    };
  }

  function ruleParams(rule) {
    if (rule.action === 'delay') return '延迟 ' + rule.delayMs + 'ms';
    if (rule.action === 'status') return '→ ' + rule.status + (rule.delayMs ? '；延迟 ' + rule.delayMs + 'ms' : '');
    if (rule.action === 'mock') return '→ ' + rule.status + ' JSON' + (rule.delayMs ? '；延迟 ' + rule.delayMs + 'ms' : '');
    if (rule.action === 'offline') return '断网' + (rule.delayMs ? '（延迟 ' + rule.delayMs + 'ms）' : '');
    if (rule.action === 'drop') return '丢包率 ' + rule.lossPercent + '%' + (rule.delayMs ? '；延迟 ' + rule.delayMs + 'ms' : '');
    return '';
  }

  function renderRules() {
    const tbody = $('ruleRows');
    tbody.innerHTML = state.config.rules.map(function (r, i) {
      return '<tr>' +
        '<td>' + (i + 1) + '</td>' +
        '<td><input type="checkbox" data-rule-toggle="' + r.id + '"' + (r.enabled !== false ? ' checked' : '') + '></td>' +
        '<td class="mono">' + esc(r.matchType + ': ' + r.pattern) + '</td>' +
        '<td>' + esc(r.method) + '</td>' +
        '<td>' + esc(r.action) + '</td>' +
        '<td class="mono">' + esc(ruleParams(r)) + '</td>' +
        '<td>' +
          '<button class="btn btn-small" data-rule-up="' + i + '">↑</button> ' +
          '<button class="btn btn-small" data-rule-down="' + i + '">↓</button> ' +
          '<button class="btn btn-small" data-rule-del="' + r.id + '">删</button>' +
        '</td>' +
      '</tr>';
    }).join('');
  }

  async function addRule() {
    const rule = readRuleForm();
    const errors = Rules.validateRule(rule);
    if (errors.length) { log('规则无效: ' + errors.join('; '), 'err'); return; }
    log('添加规则: ' + rule.action + ' / ' + rule.matchType + ' / ' + rule.pattern, 'info');
    await saveConfig({ rules: state.config.rules.concat([rule]) });
  }

  async function mutateRule(id, fn) {
    const rules = state.config.rules.map(function (r) {
      return r.id === id ? fn(JSON.parse(JSON.stringify(r))) : r;
    });
    await saveConfig({ rules: rules });
  }

  async function moveRule(index, dir) {
    const rules = state.config.rules.slice();
    const j = index + dir;
    if (j < 0 || j >= rules.length) return;
    const tmp = rules[index]; rules[index] = rules[j]; rules[j] = tmp;
    await saveConfig({ rules: rules });
  }

  document.addEventListener('click', function (e) {
    const t = e.target;
    if (t.id === 'btnAddRule') { addRule(); return; }
    const del = t.getAttribute && t.getAttribute('data-rule-del');
    const up = t.getAttribute && t.getAttribute('data-rule-up');
    const down = t.getAttribute && t.getAttribute('data-rule-down');
    if (del) {
      saveConfig({ rules: state.config.rules.filter(function (r) { return r.id !== del; }) });
    } else if (up !== null && up !== undefined && up !== false && up !== '') {
      moveRule(Number(up), -1);
    } else if (down !== null && down !== undefined && down !== false && down !== '') {
      moveRule(Number(down), 1);
    }
  });

  document.addEventListener('change', function (e) {
    const id = e.target.getAttribute && e.target.getAttribute('data-rule-toggle');
    if (id) mutateRule(id, function (r) { r.enabled = e.target.checked; return r; });
  });

  /* 导入导出 */
  $('btnExport').addEventListener('click', function () {
    const blob = new Blob([JSON.stringify(state.config.rules, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'gsb-rules.json';
    a.click();
  });
  $('btnImport').addEventListener('click', function () { $('importFile').click(); });
  $('importFile').addEventListener('change', function (e) {
    const file = e.target.files[0];
    if (!file) return;
    file.text().then(function (text) {
      const rules = JSON.parse(text);
      if (!Array.isArray(rules)) throw new Error('JSON 必须是规则数组');
      rules.forEach(function (r, i) {
        const errs = Rules.validateRule(r);
        if (errs.length) throw new Error('第 ' + (i + 1) + ' 条: ' + errs.join('; '));
        if (!r.id) r.id = 'rule-' + Date.now().toString(36) + i;
      });
      return saveConfig({ rules: rules });
    }).then(function () { log('规则导入成功', 'ok'); })
      .catch(function (err) { log('导入失败: ' + err.message, 'err'); });
  });

  /* ---------------- 测试流量 ---------------- */

  function renderResult(container, result) {
    const div = document.createElement('div');
    div.className = 'log-line';
    let cls, text;
    if (result.ok) {
      cls = 'log-ok';
      text = result.method + ' ' + result.url + ' → ' + result.status +
        ' · ' + result.duration + 'ms' + (result.note || '');
    } else {
      cls = 'log-err';
      text = result.method + ' ' + result.url + ' → 网络失败 (TypeError: ' +
        esc(result.error) + ')' + (result.note || '');
    }
    div.innerHTML = '<span class="log-time">' + result.duration + 'ms</span>' +
      '<span class="' + cls + '">' + esc(text) + '</span>' +
      (result.preview ? '<div class="log-info mono">' + esc(result.preview.slice(0, 160)) + '</div>' : '');
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  }

  async function doRequest(method, url, body) {
    const start = performance.now();
    const init = {
      method: method,
      headers: { 'x-gsb-traffic': '1' },
      cache: 'no-store',
    };
    if (body && method !== 'GET' && method !== 'HEAD') {
      init.headers['content-type'] = 'application/json';
      init.body = body;
    }
    try {
      const res = await fetch(url, init);
      const text = await res.text();
      const result = {
        ok: res.ok, status: res.status, method: method, url: url,
        duration: Math.round(performance.now() - start),
        preview: text, note: res.headers.get('x-gsb-injected') ? ' [注入]' :
          (res.headers.get('x-gsb-mock') ? ' [mock]' : ''),
      };
      log(method + ' ' + url + ' → ' + res.status + ' (' + result.duration + 'ms)' + result.note, res.ok ? 'ok' : 'warn');
      return result;
    } catch (err) {
      const result = {
        ok: false, method: method, url: url,
        duration: Math.round(performance.now() - start),
        error: err.message, note: '',
      };
      log(method + ' ' + url + ' → 失败: ' + err.message, 'err');
      return result;
    }
  }

  document.addEventListener('click', function (e) {
    const t = e.target.closest && e.target.closest('.traffic');
    if (!t) return;
    const box = $('requestResults');
    renderResult(box, { method: t.dataset.method, url: t.dataset.url, duration: 0, ok: true, status: 0, preview: '请求中…' });
    doRequest(t.dataset.method, t.dataset.url, t.dataset.body).then(function (r) {
      box.lastElementChild.remove();
      renderResult(box, r);
    });
  });

  $('btnBatch').addEventListener('click', async function () {
    log('开始批量发送 20 个请求…', 'info');
    const box = $('requestResults');
    const results = [];
    for (let i = 0; i < 20; i++) {
      const r = await doRequest('GET', '/api/users?batch=' + i + '&t=' + Date.now());
      results.push(r);
      renderResult(box, r);
    }
    const okCount = results.filter(function (r) { return r.ok; }).length;
    log('批量完成: ' + okCount + '/20 成功', okCount === 20 ? 'ok' : 'warn');
  });

  /* ---------------- 录制 / 重放 ---------------- */

  let recordings = [];
  const replayVerdicts = {};

  async function refreshRecordings() {
    recordings = await DB.listRecordings();
    state.recCount = recordings.length;
    renderRecordings();
  }

  function renderRecordings() {
    const tbody = $('recRows');
    tbody.innerHTML = recordings.map(function (r) {
      const verdict = replayVerdicts[r.id];
      let v;
      if (!verdict) v = '<span class="pill pill-wait">未重放</span>';
      else if (verdict.match) v = '<span class="pill pill-ok">一致 ✓</span>';
      else v = '<span class="pill pill-err">不一致 ✗ ' + esc(verdict.reason) + '</span>';
      const status = r.respType === 'error'
        ? '<span class="pill pill-err">' + esc(r.errorName || 'TypeError') + '</span>'
        : '<span class="pill pill-ok">' + r.status + '</span>';
      const u = r.url.replace(location.origin, '');
      return '<tr><td>' + recordings.indexOf(r) + '</td><td>' + esc(r.method) + '</td>' +
        '<td class="mono" title="' + esc(r.url) + '">' + esc(u.slice(0, 60)) + '</td>' +
        '<td>' + status + '</td><td data-verdict="' + r.id + '">' + v + '</td></tr>';
    }).join('');
    $('btnReplay').disabled = recordings.length === 0;
  }

  $('btnRecord').addEventListener('click', async function () {
    if (!state.config.recording) {
      await refreshRecordings();
    }
    await saveConfig({ recording: !state.config.recording });
    log(state.config.recording
      ? '● 开始录制（断网/丢包/状态码/mock 类规则严格生效且不触网，因此不会被录制）'
      : '录制停止，共 ' + state.recCount + ' 条', 'warn');
  });

  $('btnClearRec').addEventListener('click', function () {
    postSW({ type: 'CLEAR_RECORDINGS' });
  });

  const FORBIDDEN_HEADER_NAMES = [
    'accept-charset', 'accept-encoding', 'access-control-request-headers',
    'access-control-request-method', 'connection', 'content-length', 'cookie',
    'cookie2', 'date', 'dnt', 'expect', 'feature-policy', 'host', 'keep-alive',
    'origin', 'referer', 'set-cookie', 'te', 'trailer', 'transfer-encoding',
    'upgrade', 'via',
  ];
  const FORBIDDEN_PREFIXES = ['sec-', 'proxy-'];

  function isForbiddenHeader(name) {
    const n = name.toLowerCase();
    if (n === 'x-gsb-replay-id') return true;
    if (FORBIDDEN_HEADER_NAMES.indexOf(n) !== -1) return true;
    return FORBIDDEN_PREFIXES.some(function (p) { return n.indexOf(p) === 0; });
  }

  async function buildReplayRequest(entry) {
    const headers = new Headers();
    (entry.reqHeaders || []).forEach(function (pair) {
      if (!isForbiddenHeader(pair[0])) headers.append(pair[0], pair[1]);
    });
    headers.set('x-gsb-replay-id', entry.id);
    const init = { method: entry.method, headers: headers, cache: 'no-store', mode: 'same-origin' };
    if (entry.reqBody && entry.method !== 'GET' && entry.method !== 'HEAD') {
      /* slice 出新缓冲：ArrayBuffer 作为 body 会被 transfer，多次重放不能复用同一个 */
      init.body = entry.reqBody.slice(0);
      if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    }
    return new Request(entry.url, init);
  }

  function bytesEqual(a, b) {
    if (!a || !b || a.byteLength !== b.byteLength) return false;
    const va = new Uint8Array(a), vb = new Uint8Array(b);
    for (let i = 0; i < va.length; i++) if (va[i] !== vb[i]) return false;
    return true;
  }

  async function replayAll() {
    if (!recordings.length) return;
    await saveConfig({ replay: true });
    log('开始离线重放 ' + recordings.length + ' 条…（SW 直接读 IndexedDB/Cache，不触网）', 'warn');
    let matchCount = 0;
    const summary = [];
    for (const entry of recordings) {
      const req = await buildReplayRequest(entry);
      try {
        const res = await fetch(req);
        const buf = await res.arrayBuffer();
        let match = res.status === entry.status;
        let reason = '';
        if (!match) reason = 'status ' + res.status + '≠' + entry.status;
        if (match) {
          const cache = await caches.open('gsb-debug-cache-' + (state.swVersion || 'v1'));
          const stored = await cache.match(location.origin + '/__gsb_rec__/' + entry.id);
          const storedBuf = stored ? await stored.arrayBuffer() : null;
          if (!bytesEqual(storedBuf, buf)) {
            match = false;
            reason = '响应体字节不一致';
          }
          if (match) {
            const mismatch = (entry.respHeaders || []).find(function (pair) {
              const name = pair[0].toLowerCase();
              if (['x-gsb-replay', 'content-length', 'content-encoding'].indexOf(name) !== -1) return false;
              const actual = res.headers.get(name);
              return actual !== pair[1];
            });
            if (mismatch) {
              match = false;
              reason = '响应头不一致: ' + mismatch[0];
            }
          }
        }
        replayVerdicts[entry.id] = { match: match, reason: reason };
        if (match) matchCount++;
        summary.push({ id: entry.id, match: match, reason: reason });
      } catch (err) {
        const match = entry.respType === 'error';
        replayVerdicts[entry.id] = { match: match, reason: match ? '' : '意外网络错误: ' + err.message };
        if (match) matchCount++;
      }
      renderRecordings();
    }
    await saveConfig({ replay: false });
    $('replaySummary').innerHTML =
      '<span class="pill ' + (matchCount === recordings.length ? 'pill-ok' : 'pill-err') + '">' +
      '重放完成: ' + matchCount + '/' + recordings.length + ' 与录制一致</span>';
    log('重放完成: ' + matchCount + '/' + recordings.length + ' 一致',
      matchCount === recordings.length ? 'ok' : 'err');
  }

  $('btnReplay').addEventListener('click', replayAll);

  /* ---------------- Cache / SW 运维 ---------------- */

  async function listCaches() {
    const box = $('swLog');
    const keys = await caches.keys();
    box.innerHTML = '';
    if (!keys.length) {
      box.innerHTML = '<div class="log-line"><span class="log-ok">CacheStorage 为空（正常请求未被缓存，无污染）</span></div>';
      return;
    }
    for (const key of keys) {
      const cache = await caches.open(key);
      const entries = await cache.keys();
      const div = document.createElement('div');
      div.className = 'log-line';
      div.innerHTML = '<span class="log-info">' + esc(key) + '</span> · ' +
        entries.length + ' 个录制响应' +
        (key === 'gsb-debug-cache-' + (state.swVersion || 'v1') ? '' : ' <span class="log-err">← 旧版本残留!</span>');
      box.appendChild(div);
    }
  }

  $('btnListCaches').addEventListener('click', listCaches);
  $('btnUpdateSW').addEventListener('click', async function () {
    if (!state.registration) return;
    log('检查 SW 更新…', 'info');
    try {
      await state.registration.update();
      log('更新检查完成（若无 byte 级变化则沿用当前版本）', 'info');
    } catch (e) { log('更新失败: ' + e.message, 'err'); }
  });
  $('btnUnregister').addEventListener('click', async function () {
    const regs = await navigator.serviceWorker.getRegistrations();
    await Promise.all(regs.map(function (r) { return r.unregister(); }));
    const keys = await caches.keys();
    await Promise.all(keys.map(function (k) { return caches.delete(k); }));
    await DB.clearRecordings();
    log('已注销 SW 并清空缓存，2 秒后刷新…', 'warn');
    setTimeout(function () { location.reload(); }, 2000);
  });
  $('btnClearLog').addEventListener('click', function () { $('eventLog').innerHTML = ''; });

  /* ---------------- 跨标签页心跳 ---------------- */

  function heartbeat() {
    if (channel) channel.postMessage({ type: 'HEARTBEAT', tabId: tabId });
  }
  setInterval(heartbeat, 2000);
  setInterval(function () {
    const now = Date.now();
    Object.keys(peers).forEach(function (id) {
      if (now - peers[id] > 6000) delete peers[id];
    });
    renderTabs();
  }, 3000);

  function renderTabs() {
    $('tabCount').textContent = '受控标签页: ' + (Object.keys(peers).length + 1);
  }

  if (channel) {
    channel.onmessage = function (e) {
      const d = e.data || {};
      if (d.type === 'HEARTBEAT') {
        if (d.tabId !== tabId) peers[d.tabId] = Date.now();
      } else if (d.type === 'CONFIG_UPDATED' && d.origin !== tabId) {
        state.config = d.config;
        renderAll();
        log('收到其它标签页配置变更 (v' + d.config.configVersion + ')', 'info');
      }
    };
  }

  /* storage 事件兜底（无 BroadcastChannel 时） */
  window.addEventListener('storage', function (e) {
    if (e.key && e.key.indexOf(DB.DB_NAME) === 0) refreshRecordings();
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) postSW({ type: 'GET_STATE' });
  });

  /* ---------------- SW 消息 ---------------- */

  navigator.serviceWorker.addEventListener('message', function (event) {
    const d = event.data || {};
    if (d.type === 'STATE') {
      state.config = Object.assign(state.config, d.config);
      state.recCount = d.count;
      state.swVersion = d.swVersion;
      $('swVersion').textContent = 'SW ' + d.swVersion;
      refreshRecordings().then(renderAll);
    } else if (d.type === 'CONFIG_UPDATED' && d.origin !== tabId) {
      postSW({ type: 'GET_STATE' });
    } else if (d.type === 'RECORDING_ADDED') {
      state.recCount = d.count;
      refreshRecordings();
    } else if (d.type === 'RECORDINGS_CLEARED') {
      refreshRecordings();
      Object.keys(replayVerdicts).forEach(function (k) { delete replayVerdicts[k]; });
      $('replaySummary').textContent = '';
      log('录制已清空（IndexedDB + 专用 Cache 同步删除）', 'warn');
    } else if (d.type === 'SW_UPDATED') {
      log('SW 更新完成: ' + d.swVersion, 'warn');
      postSW({ type: 'GET_STATE' });
    } else if (d.type === 'RECORDING_ERROR') {
      log('录制失败: ' + d.message, 'err');
    }
  });

  /* ---------------- 渲染总入口 ---------------- */

  function renderStatus() {
    const rec = $('recStatus');
    rec.textContent = '录制: ' + (state.config.recording ? '开（' + state.recCount + '）' : '关');
    rec.className = 'badge ' + (state.config.recording ? 'badge-rec' : 'badge-muted');
    const rep = $('replayStatus');
    rep.textContent = '重放: ' + (state.config.replay ? '进行中' : '关');
    rep.className = 'badge ' + (state.config.replay ? 'badge-rec' : 'badge-muted');
    $('btnRecord').textContent = state.config.recording ? '■ 停止录制' : '● 开始录制';
  }

  function renderAll() {
    renderRules();
    renderStatus();
    renderTabs();
  }

  /* ---------------- 启动 ---------------- */

  (async function init() {
    heartbeat();
    const cfg = await DB.getConfig();
    state.config = Object.assign(state.config, cfg);
    renderAll();
    await registerSW();
    setTimeout(function () { postSW({ type: 'GET_STATE' }); }, 300);
    log('调试台就绪。所有页面 fetch（非导航请求）均由 SW 拦截。', 'ok');
  })();
})();
