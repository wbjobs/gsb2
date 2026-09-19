/* gsb 调试台 Service Worker
 * 职责：故障注入（延迟/状态码/mock/断网/丢包）、真实请求录制、离线重放、跨标签页广播。
 * 响应体存 Cache API（专用缓存），元数据存 IndexedDB；正常透传请求绝不进入缓存。 */
'use strict';

const SW_VERSION = 'v1';
const CACHE_PREFIX = 'gsb-debug-cache-';
const CACHE_NAME = CACHE_PREFIX + SW_VERSION;
const REC_KEY_PREFIX = '/__gsb_rec__/';
const REPLAY_HEADER = 'x-gsb-replay-id';
const STRIP_RESP_HEADERS = ['content-encoding', 'content-length', 'transfer-encoding'];

function recCacheKey(id) {
  return new URL(REC_KEY_PREFIX + id, self.registration.scope).href;
}

importScripts('js/rules.js', 'js/db.js');

let configPromise = null;
let currentConfig = { rules: [], recording: false, replay: false, configVersion: 0 };

const Rules = self.DebugRules;
const DB = self.DebugDB;

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function loadConfig() {
  if (!configPromise) {
    configPromise = DB.getConfig().then(function (cfg) {
      currentConfig = Object.assign(currentConfig, cfg);
      return currentConfig;
    }).catch(function () { return currentConfig; });
  }
  return configPromise;
}

async function broadcast(msg) {
  const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  clients.forEach(function (client) {
    client.postMessage(Object.assign({}, msg, { from: 'sw' }));
  });
}

async function persistConfig(config, origin) {
  currentConfig = config;
  configPromise = Promise.resolve(config);
  await DB.setConfig(config);
  await broadcast({ type: 'CONFIG_UPDATED', config: config, origin: origin || null });
}

/* ---------------- 录制 ---------------- */

function headersToArray(headers) {
  const out = [];
  headers.forEach(function (value, name) { out.push([name, value]); });
  return out;
}

async function readBody(requestOrResponse) {
  try {
    const buf = await requestOrResponse.clone().arrayBuffer();
    return buf.byteLength > 0 ? buf : null;
  } catch (e) {
    return null;
  }
}

function buildStoredResponse(entry) {
  const headers = {};
  (entry.respHeaders || []).forEach(function (pair) {
    if (STRIP_RESP_HEADERS.indexOf(pair[0]) === -1) headers[pair[0]] = pair[1];
  });
  return new Response(entry.respBody, {
    status: entry.status || 200,
    headers: headers,
  });
}

async function persistRecording(entry, respBody) {
  entry.respBody = respBody;
  const cache = await caches.open(CACHE_NAME);
  await cache.put(new Request(recCacheKey(entry.id)), buildStoredResponse(entry));
  delete entry.respBody;
  await DB.putRecording(entry);
  const count = await DB.countRecordings();
  broadcast({ type: 'RECORDING_ADDED', entry: summary(entry), count: count });
}

function summary(entry) {
  return {
    id: entry.id, seq: entry.seq, createdAt: entry.createdAt,
    method: entry.method, url: entry.url, status: entry.status,
    respType: entry.respType, errorName: entry.errorName,
  };
}

async function captureAndRecord(request, networkResult) {
  const now = Date.now();
  const id = 'r' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const entry = {
    id: id,
    seq: now,
    createdAt: now,
    method: request.method,
    url: request.url,
    reqHeaders: headersToArray(request.headers),
    reqBody: await readBody(request),
  };

  if (networkResult.error) {
    entry.respType = 'error';
    entry.status = 0;
    entry.respHeaders = [];
    entry.errorName = networkResult.error.name || 'TypeError';
    entry.errorMessage = String(networkResult.error.message || 'network error');
    await persistRecording(entry, null);
    return entry;
  }

  const response = networkResult.response;
  entry.respType = 'body';
  entry.status = response.status;
  entry.ok = response.ok;
  entry.respHeaders = headersToArray(response.headers);
  entry.errorName = null;
  const buf = await response.arrayBuffer();
  await persistRecording(entry, buf);
  return entry;
}

/* ---------------- 故障注入 ---------------- */

function synthResponse(decision) {
  if (decision.action === 'mock') {
    return new Response(decision.body, {
      status: decision.status,
      headers: { 'content-type': 'application/json;charset=utf-8', 'x-gsb-mock': '1' },
    });
  }
  return new Response('gsb-debug: injected status ' + decision.status, {
    status: decision.status,
    headers: { 'content-type': 'text/plain;charset=utf-8', 'x-gsb-injected': '1' },
  });
}

async function applyDecision(decision) {
  if (decision.delayMs) await sleep(decision.delayMs);
  if (decision.action === 'offline') {
    throw new TypeError('gsb-debug: forced offline (rule ' + decision.ruleId + ')');
  }
  if (decision.action === 'drop' && decision.dropped) {
    throw new TypeError('gsb-debug: random packet loss (rule ' + decision.ruleId + ')');
  }
  if (decision.action === 'status' || decision.action === 'mock') {
    return synthResponse(decision);
  }
  return null;
}

/* ---------------- 离线重放 ---------------- */

async function serveReplay(request) {
  const replayId = request.headers.get(REPLAY_HEADER);
  const entry = await DB.getRecording(replayId);
  if (!entry) {
    return new Response(JSON.stringify({ error: 'recording not found', id: replayId }), {
      status: 502,
      headers: { 'content-type': 'application/json', 'x-gsb-replay': 'miss' },
    });
  }
  if (entry.respType === 'error') {
    throw new TypeError('gsb-debug: replay of recorded failure: ' + (entry.errorName || 'TypeError'));
  }
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(recCacheKey(entry.id));
  if (!cached) {
    return new Response(JSON.stringify({ error: 'response body cache missing' }), {
      status: 502,
      headers: { 'content-type': 'application/json', 'x-gsb-replay': 'miss' },
    });
  }
  const headers = new Headers(cached.headers);
  headers.set('x-gsb-replay', entry.id);
  const bodyBuf = await cached.arrayBuffer();
  /* 204/305/304 等空体状态码携带 body 会抛 TypeError */
  const body = (cached.status === 204 || cached.status === 304) ? null : bodyBuf;
  return new Response(body, {
    status: cached.status,
    statusText: cached.statusText,
    headers: headers,
  });
}

/* ---------------- fetch 主流程 ---------------- */

function isHandled(url) {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

self.addEventListener('fetch', function (event) {
  const request = event.request;
  const url = new URL(request.url);
  if (!isHandled(url) || request.mode === 'navigate') return;

  if (request.headers.get(REPLAY_HEADER)) {
    event.respondWith(serveReplay(request));
    return;
  }

  event.respondWith((async function () {
    const cfg = await loadConfig();
    const rule = Rules.findRule(cfg.rules, request);
    const decision = rule ? Rules.evalDecision(rule) : null;

    /* 硬故障：严格按规则失败，且不再触网（录制也录不到此类请求） */
    if (decision && (decision.action === 'offline' ||
      (decision.action === 'drop' && decision.dropped))) {
      if (decision.delayMs) await sleep(decision.delayMs);
      throw new TypeError('gsb-debug: ' +
        (decision.action === 'offline' ? 'forced offline' : 'random packet loss') +
        ' (rule ' + decision.ruleId + ')');
    }

    /* 合成响应：指定状态码 / mock JSON，不触网 */
    if (decision && (decision.action === 'status' || decision.action === 'mock')) {
      if (decision.delayMs) await sleep(decision.delayMs);
      return synthResponse(decision);
    }

    /* 透传动作（无规则、仅延迟、丢包未命中）：录制模式下先抓真实结果 */
    let networkResponse = null;
    let networkError = null;
    try {
      /* request.clone() 解决请求体只能消费一次：原始 request 的 body 留给读取录制 */
      networkResponse = await fetch(request.clone());
    } catch (e) {
      networkError = e;
    }

    if (cfg.recording) {
      try {
        /* 响应也必须克隆：arrayBuffer() 会消费 body，页面拿到的响应需保持未消费 */
        await captureAndRecord(request, networkError
          ? { error: networkError }
          : { response: networkResponse.clone() });
      } catch (persistErr) {
        broadcast({ type: 'RECORDING_ERROR', message: String(persistErr && persistErr.message) });
      }
    }

    if (decision && decision.delayMs) await sleep(decision.delayMs);
    if (networkError) throw networkError;
    return networkResponse;
  })());
});

/* ---------------- 消息与生命周期 ---------------- */

self.addEventListener('message', function (event) {
  const data = event.data || {};
  (async function () {
    if (data.type === 'GET_STATE') {
      const cfg = await loadConfig();
      const count = await DB.countRecordings();
      event.source && event.source.postMessage({
        type: 'STATE',
        config: cfg,
        count: count,
        swVersion: SW_VERSION,
        from: 'sw',
      });
    } else if (data.type === 'SET_CONFIG') {
      await persistConfig(data.config, data.origin);
    } else if (data.type === 'CLEAR_RECORDINGS') {
      await DB.clearRecordings();
      const keys = await caches.keys();
      await Promise.all(keys
        .filter(function (k) { return k === CACHE_NAME; })
        .map(function (k) { return caches.delete(k); }));
      event.source && event.source.postMessage({ type: 'RECORDINGS_CLEARED', from: 'sw' });
    } else if (data.type === 'PING') {
      event.source && event.source.postMessage({ type: 'PONG', from: 'sw' });
    }
  })();
});

async function wipeOldData(oldVersion) {
  const keys = await caches.keys();
  await Promise.all(keys
    .filter(function (k) { return k.indexOf(CACHE_PREFIX) === 0 && k !== CACHE_NAME; })
    .map(function (k) { return caches.delete(k); }));
  if (oldVersion && oldVersion !== SW_VERSION) {
    await DB.clearRecordings();
    const current = await caches.open(CACHE_NAME);
    const recKeys = await current.keys();
    await Promise.all(recKeys.map(function (k) { return current.delete(k); }));
  }
}

self.addEventListener('install', function () {
  self.skipWaiting();
});

async function activateSW() {
  const meta = await DB.getKV(DB.KV_META, {});
  await wipeOldData(meta.swVersion);
  await DB.setKV(DB.KV_META, { swVersion: SW_VERSION });
  configPromise = null;
  await self.clients.claim();
  await broadcast({ type: 'SW_UPDATED', swVersion: SW_VERSION });
}

self.addEventListener('activate', function (event) {
  event.waitUntil(activateSW());
});

self.__gsbActivate = activateSW;
