/*
 * 调试台 Service Worker
 *
 * 职责：
 *  1. 按规则拦截页面 fetch/XHR：延迟、状态码、mock JSON、断网、随机丢包
 *  2. 录制真实请求（method/headers/body）与真实响应（状态/headers/二进制 body）
 *  3. 离线状态下按录制记录重放，结果与录制时一致（网络错误也会被复刻）
 *  4. SW 升级时清理全部旧版本 Cache，杜绝缓存残留
 *
 * 设计要点：
 *  - 真正透传的请求绝不进入 Cache API（避免污染正常请求），Cache 仅存重放快照
 *  - 录制前先 request.clone()，响应也用 clone 消费，原请求/原响应原样透传
 *  - 配置只在内存中持有副本，持久化由页面侧完成，跨标签页经 BroadcastChannel 同步
 */

const VERSION = 'v1.0.0';
const CACHE_PREFIX = 'debug-console-replay-';
const CACHE_NAME = CACHE_PREFIX + VERSION;
const CACHE_KEY_BASE = 'https://debug-console.local/__debug_cache__/';
const REPLAY_HEADER = 'x-debug-replay-id';

importScripts('./js/db.js');

let state = DebugDB.defaultState();
let channel = null;

function uid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function broadcast(type, payload) {
  try {
    if (!channel) channel = new BroadcastChannel('debug-console');
    channel.postMessage(Object.assign({ type, source: 'sw' }, payload || {}));
  } catch (err) {
    /* BroadcastChannel 不可用时静默退化 */
  }
}

async function refreshState() {
  state = await DebugDB.loadState();
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    await refreshState();
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 删除所有非当前版本的 Cache，并清空当前版本 Cache（可能是旧 SW 写入的结构）
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
        .map((name) => caches.delete(name))
    );
    await caches.delete(CACHE_NAME);

    await DebugDB.putKey('meta', 'swVersion', {
      version: VERSION,
      activatedAt: Date.now()
    });
    await refreshState();
    await self.clients.claim();
    broadcast('sw-activated', { version: VERSION, deletedCaches: names });
  })());
});

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  const reply = (type, payload) => {
    const data = Object.assign({ type }, payload || {});
    // 页面通过 MessageChannel 转移了 port 时优先回 port，否则回 client
    const port = event.ports && event.ports[0];
    if (port) {
      port.postMessage(data);
    } else if (event.source && event.source.postMessage) {
      event.source.postMessage(data);
    }
  };

  switch (msg.type) {
    case 'PING':
      reply('PONG', { version: VERSION });
      break;

    case 'GET_VERSION':
      reply('VERSION', { version: VERSION });
      break;

    case 'GET_STATE':
      event.waitUntil(
        refreshState().then(() => reply('STATE', { state }))
      );
      break;

    // 页面已经把配置写入 IndexedDB，这里让 SW 重新加载并通知其他标签页
    case 'STATE_UPDATED':
      event.waitUntil(
        refreshState().then(() => {
          broadcast('state-changed', { state, origin: msg.origin || 'page' });
          reply('STATE_APPLIED', { version: VERSION });
        })
      );
      break;

    case 'CLEAR_RECORDS':
      event.waitUntil(
        (async () => {
          await DebugDB.clearStore('records');
          await caches.delete(CACHE_NAME);
          broadcast('records-cleared', {});
          reply('RECORDS_CLEARED', {});
        })()
      );
      break;
  }
});

/* ---------------- 规则引擎 ---------------- */

function matchRule(rule, url) {
  if (!rule || rule.enabled === false) return false;
  const pattern = rule.pattern || '';
  if (!pattern) return false;
  if (rule.kind === 'regexp') {
    try {
      return new RegExp(pattern).test(url);
    } catch (err) {
      return false;
    }
  }
  return url.includes(pattern);
}

function networkError(message) {
  // 与浏览器真实断网表现一致：fetch 返回 reject（TypeError）
  return Promise.reject(new TypeError(message || 'NetworkError: debug console injected failure'));
}

function delay(ms) {
  const duration = Math.min(30000, Math.max(0, Number(ms) || 0));
  if (!duration) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, duration));
}

function buildMockResponse(rule) {
  const status = Math.min(599, Math.max(100, Number(rule.statusCode) || 200));
  const body = rule.mockBody == null ? '' : rule.mockBody;
  return new Response(body, {
    status,
    statusText: rule.statusText || '',
    headers: {
      'Content-Type': rule.mockContentType || 'application/json;charset=UTF-8',
      'X-Debug-Injected': rule.action
    }
  });
}

/*
 * 返回 Response 表示直接产出响应；
 * 返回 'network' 表示做完前置动作后继续走真实网络；
 * throw / reject 表示按断网失败。
 */
async function applyInterception(url) {
  if (state.offline) {
    return networkError('NetworkError: offline mode');
  }

  const rule = (state.rules || []).find((item) => matchRule(item, url));
  if (!rule || rule.action === 'passthrough') {
    return 'network';
  }

  switch (rule.action) {
    case 'offline':
      return networkError('NetworkError: rule "' + rule.name + '" cut the network');

    case 'loss': {
      const percent = Math.min(100, Math.max(0, Number(rule.lossPercent) || 0));
      if (Math.random() * 100 < percent) {
        return networkError('NetworkError: rule "' + rule.name + '" dropped packet');
      }
      return 'network';
    }

    case 'delay':
      await delay(rule.delayMs);
      return state.offline ? networkError('NetworkError: offline mode') : 'network';

    case 'status':
      return new Response('', {
        status: Math.min(599, Math.max(100, Number(rule.statusCode) || 500)),
        headers: { 'X-Debug-Injected': 'status' }
      });

    case 'mock':
      return buildMockResponse(rule);

    default:
      return 'network';
  }
}

/* ---------------- 录制 ---------------- */

const HOP_BY_HOP = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'x-debug-replay-id'
]);

async function headerEntries(headers) {
  const result = [];
  try {
    for (const [key, value] of headers.entries()) {
      if (!HOP_BY_HOP.has(key.toLowerCase())) result.push([key, value]);
    }
  } catch (err) {
    /* 某些跨域响应头不可访问，忽略 */
  }
  return result;
}

function isControllableRequest(request) {
  const url = request.url;
  if (!/^https?:/.test(url)) return false;
  // 只拦截 fetch/XHR 发出的请求（destination 为空），避免影响脚本、样式与导航
  if (request.destination !== '') return false;
  if (url.endsWith('/sw.js') || url.includes('/js/db.js')) return false;
  return true;
}

async function recordAndPass(request) {
  // 关键：先克隆，再用原请求发起网络，克隆体用于读取 body（请求体只能读一次）
  const requestClone = request.clone();

  let reqBody = null;
  if (requestClone.method !== 'GET' && requestClone.method !== 'HEAD') {
    try {
      reqBody = await requestClone.arrayBuffer();
    } catch (err) {
      reqBody = null;
    }
  }

  const record = {
    id: uid(),
    createdAt: Date.now(),
    request: {
      method: requestClone.method,
      url: requestClone.url,
      headers: await headerEntries(requestClone.headers),
      body: reqBody
    },
    response: null
  };

  try {
    // 透传始终使用原始 request，正常请求完全不触碰 Cache API
    const response = await fetch(request);
    const responseClone = response.clone();

    let body = null;
    try {
      body = await responseClone.arrayBuffer();
    } catch (err) {
      body = null;
    }

    record.response = {
      kind: 'response',
      status: response.status,
      statusText: response.statusText,
      headers: await headerEntries(responseClone.headers),
      body
    };

    // 异步写入，不阻塞返回给页面的原始响应
    persistRecord(record).catch(() => {});
    return response;
  } catch (err) {
    record.response = {
      kind: 'network-error',
      errorName: err && err.name ? err.name : 'TypeError',
      errorMessage: String((err && err.message) || err),
      status: 0,
      headers: [],
      body: null
    };
    await persistRecord(record);
    throw err;
  }
}

async function persistRecord(record) {
  await DebugDB.putRecord(record);

  // 把可重放的响应快照写入 Cache API（用合成 GET key，绕开 Cache 不支持 POST 的限制）
  if (record.response && record.response.kind === 'response') {
    try {
      const cache = await caches.open(CACHE_NAME);
      const key = CACHE_KEY_BASE + record.id;
      const init = {
        status: record.response.status,
        statusText: record.response.statusText,
        headers: record.response.headers
      };
      const snapshot = new Response(record.response.body || null, init);
      await cache.put(key, snapshot);
    } catch (err) {
      // 个别状态码（如 206）无法入 Cache，重放时回退到 IndexedDB 重建
    }
  }
  broadcast('record-added', { id: record.id });
}

/* ---------------- 重放 ---------------- */

async function serveReplay(recordId) {
  const record = await DebugDB.getRecord(recordId);
  if (!record) {
    return networkError('NetworkError: replay record not found: ' + recordId);
  }

  if (!record.response || record.response.kind === 'network-error') {
    // 录制时就是网络失败，离线重放必须一致地失败
    return networkError(
      'Replay of recorded network error: ' +
        (record.response ? record.response.errorMessage : 'unknown')
    );
  }

  const key = CACHE_KEY_BASE + record.id;
  const cached = await caches.match(key, { cacheName: CACHE_NAME });
  if (cached) return cached;

  // Cache 未命中（如 SW 刚升级）时从 IndexedDB 重建
  const resp = record.response;
  return new Response(resp.body || null, {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers
  });
}

/* ---------------- fetch 主流程 ---------------- */

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (!/^https?:/.test(request.url)) return;

  const replayId = request.headers.get(REPLAY_HEADER);
  if (replayId) {
    event.respondWith(serveReplay(replayId));
    return;
  }

  if (!isControllableRequest(request)) return;

  const active =
    state.enabled || state.offline || state.recording;
  if (!active) return; // 总开关全关：完全透传，不产生任何缓存/克隆开销

  event.respondWith(
    (async () => {
      if (state.enabled || state.offline) {
        const result = await applyInterception(request.url);
        if (result !== 'network') return result;
      }
      // 到达这里：规则放行 / 仅延迟 / 仅录制 —— 走真实网络
      if (state.recording) {
        return recordAndPass(request);
      }
      return fetch(request);
    })()
  );
});
