'use strict';

/* 用最小浏览器 mock 加载 sw.js，驱动 install/activate/fetch，
 * 验证故障注入、录制（克隆 body）、离线重放、旧缓存清理等核心行为。 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

/* ---------- 极简 Request/Response/Headers ---------- */
class MiniHeaders {
  constructor(init) {
    this._m = new Map();
    if (init instanceof MiniHeaders) {
      init.forEach((v, k) => this._m.set(k.toLowerCase(), v));
    } else if (Array.isArray(init)) {
      init.forEach(([k, v]) => this._m.set(String(k).toLowerCase(), String(v)));
    } else if (init) {
      Object.keys(init).forEach((k) => this._m.set(k.toLowerCase(), String(init[k])));
    }
  }
  set(k, v) { this._m.set(k.toLowerCase(), String(v)); }
  append(k, v) { this.set(k, v); }
  get(k) { return this._m.has(k.toLowerCase()) ? this._m.get(k.toLowerCase()) : null; }
  has(k) { return this._m.has(k.toLowerCase()); }
  forEach(fn) { this._m.forEach((v, k) => fn(v, k)); }
}

let bodyId = 0;
class MiniBody {
  constructor(body, headers) {
    let buf;
    if (body == null) buf = Buffer.alloc(0);
    else if (Buffer.isBuffer(body)) buf = body;
    else if (body instanceof ArrayBuffer) buf = Buffer.from(body);
    else if (ArrayBuffer.isView(body)) buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    else buf = Buffer.from(String(body));
    this._buf = buf;
    this._consumed = false;
    this.headers = headers || new MiniHeaders();
    if (this.headers && !this.headers.has('content-type') && typeof body === 'string') {
      /* 不强加 content-type，由构造处决定 */
    }
  }
  clone() {
    const copy = new MiniBody(Buffer.from(this._buf), new MiniHeaders(this.headers));
    copy.status = this.status;
    copy.ok = this.ok;
    copy.statusText = this.statusText;
    copy.method = this.method;
    copy.url = this.url;
    copy.mode = this.mode;
    return copy;
  }
  async arrayBuffer() {
    if (this._consumed) throw new TypeError('body already consumed');
    this._consumed = true;
    return this._buf.buffer.slice(this._buf.byteOffset, this._buf.byteOffset + this._buf.byteLength);
  }
  async text() {
    if (this._consumed) throw new TypeError('body already consumed');
    this._consumed = true;
    return this._buf.toString('utf8');
  }
}

class MiniRequest extends MiniBody {
  constructor(url, init) {
    init = init || {};
    super(init.body != null ? init.body : null, init.headers instanceof MiniHeaders ? init.headers : new MiniHeaders(init.headers));
    this.url = url;
    this.method = (init.method || 'GET').toUpperCase();
    this.mode = init.mode || 'cors';
  }
}

class MiniResponse extends MiniBody {
  constructor(body, init) {
    init = init || {};
    super(body != null ? body : null, init.headers instanceof MiniHeaders ? init.headers : new MiniHeaders(init.headers));
    this.status = init.status || 200;
    this.statusText = init.statusText || '';
    this.ok = this.status >= 200 && this.status < 300;
  }
}

/* ---------- 极简 CacheStorage ---------- */
class MiniCache {
  constructor() { this.map = new Map(); }
  async put(request, response) {
    const key = typeof request === 'string' ? request : request.url;
    this.map.set(key, response.clone());
  }
  async match(request) {
    const key = typeof request === 'string' ? (request.url || request) : request.url;
    if (request instanceof URL) { /* handled by caller */ }
    const r = this.map.get(String(key));
    return r ? r.clone() : undefined;
  }
  async keys() { return Array.from(this.map.keys()); }
  async delete(key) { this.map.delete(typeof key === 'string' ? key : key.url); }
}
const cachesMap = new Map();
const miniCaches = {
  async open(name) {
    if (!cachesMap.has(name)) cachesMap.set(name, new MiniCache());
    return cachesMap.get(name);
  },
  async keys() { return Array.from(cachesMap.keys()); },
  async delete(name) { return cachesMap.delete(name); },
};

/* ---------- 极简 IndexedDB ---------- */
const kvStore = new Map();
const recStore = new Map();
const sharedDB = {
    DB_NAME: 'gsb-debug-db',
    KV_META: 'meta',
    async getKV(k, fb) { return kvStore.has(k) ? JSON.parse(JSON.stringify(kvStore.get(k))) : fb; },
    async setKV(k, v) { kvStore.set(k, JSON.parse(JSON.stringify(v))); },
    async getConfig() {
      return kvStore.has('config')
        ? JSON.parse(JSON.stringify(kvStore.get('config')))
        : { rules: [], recording: false, replay: false, configVersion: 0 };
    },
    async setConfig(c) { kvStore.set('config', JSON.parse(JSON.stringify(c))); },
    async putRecording(r) { recStore.set(r.id, r); },
    async getRecording(id) { return recStore.get(id) || null; },
    async listRecordings() { return Array.from(recStore.values()).sort((a, b) => a.createdAt - b.createdAt); },
    async countRecordings() { return recStore.size; },
    async clearRecordings() { recStore.clear(); },
  };
function fakeDB() { return sharedDB; }

/* ---------- 加载 SW ---------- */
const fetchListeners = [];
const messageListeners = [];
const waitUntilOps = [];
const clientsList = [];

function loadSW() {
  fetchListeners.length = 0;
  messageListeners.length = 0;
  kvStore.clear();
  recStore.clear();
  cachesMap.clear();
  const sandbox = {
    Headers: MiniHeaders,
    Request: MiniRequest,
    Response: MiniResponse,
    URL: URL,
    TextEncoder, TextDecoder,
    setTimeout, clearTimeout,
    console: console,
    Math: Math, JSON: JSON, Date: Date, Error: Error, TypeError: TypeError,
    Promise: Promise, ArrayBuffer: ArrayBuffer, Uint8Array: Uint8Array, Buffer: Buffer,
    fetch: globalFetch,
    caches: miniCaches,
    indexedDB: {},
    importScripts: function (...files) {
      files.forEach((f) => {
        if (f === 'js/db.js') {
          sandbox.DebugDB = fakeDB();
        } else {
          const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
          vm.runInContext(code, sandbox, { filename: f });
        }
      });
    },
    self: null,
    clients: {
      async matchAll() { return clientsList; },
      async claim() {},
    },
    registration: { scope: 'http://localhost:3000/' },
  };
  sandbox.self = sandbox;
  sandbox.addEventListener = function (type, fn) {
    if (type === 'fetch') fetchListeners.push(fn);
    if (type === 'message') messageListeners.push(fn);
    if (type === 'install' || type === 'activate') sandbox['__' + type] = fn;
  };
  vm.createContext(sandbox);
  const swCode = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  vm.runInContext(swCode, sandbox, { filename: 'sw.js' });
  return sandbox;
}

/* 网络层 mock：默认返回 JSON；部分 URL 返回失败 */
function globalFetch(request) {
  if (request.url.includes('/network-down')) {
    return Promise.reject(new TypeError('Failed to fetch (mock network down)'));
  }
  const body = JSON.stringify({ ok: true, url: request.url, echoAt: 1 });
  return Promise.resolve(new MiniResponse(body, {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-real': '1' },
  }));
}

function dispatchFetch(sandbox, request) {
  let responder;
  const event = {
    request: request,
    respondWith(p) { responder = p; },
  };
  fetchListeners.forEach((fn) => fn(event));
  return responder;
}

function setConfig(sandbox, config) {
  return new Promise((resolve) => {
    messageListeners.forEach((fn) => fn({
      data: { type: 'SET_CONFIG', config: config, origin: 'test' },
      source: null,
    }));
    setTimeout(resolve, 5);
  });
}

/* ---------- 测试 ---------- */

test('无规则: 请求透传真实网络，响应头保留', async () => {
  const sw = loadSW();
  const req = new MiniRequest('http://localhost:3000/api/echo?q=1');
  const res = await dispatchFetch(sw, req);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('x-real'), '1');
});

test('延迟规则: 至少等待配置的毫秒数', async () => {
  const sw = loadSW();
  await setConfig(sw, {
    rules: [{ id: 'r1', enabled: true, matchType: 'includes', pattern: '/api/echo',
      method: 'ANY', action: 'delay', delayMs: 200 }],
    recording: false, replay: false, configVersion: 1,
  });
  const t = Date.now();
  const res = await dispatchFetch(sw, new MiniRequest('http://localhost:3000/api/echo'));
  assert.ok(Date.now() - t >= 190, '应等待约 200ms');
  assert.strictEqual(res.status, 200);
});

test('指定状态码规则: 严格返回注入状态', async () => {
  const sw = loadSW();
  await setConfig(sw, {
    rules: [{ id: 'r1', enabled: true, matchType: 'includes', pattern: '/api/users',
      method: 'ANY', action: 'status', status: 503, delayMs: 0 }],
    recording: false, replay: false, configVersion: 1,
  });
  const res = await dispatchFetch(sw, new MiniRequest('http://localhost:3000/api/users'));
  assert.strictEqual(res.status, 503);
  assert.strictEqual(res.headers.get('x-gsb-injected'), '1');
});

test('Mock JSON 规则: 返回配置的 JSON 与状态码', async () => {
  const sw = loadSW();
  await setConfig(sw, {
    rules: [{ id: 'r1', enabled: true, matchType: 'prefix', pattern: 'http://localhost:3000/api/items',
      method: 'GET', action: 'mock', status: 200, delayMs: 0, body: JSON.stringify({ mocked: true }) }],
    recording: false, replay: false, configVersion: 1,
  });
  const res = await dispatchFetch(sw, new MiniRequest('http://localhost:3000/api/items'));
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(JSON.parse(await res.text()), { mocked: true });
});

test('直接断网规则: fetch 以 TypeError reject', async () => {
  const sw = loadSW();
  await setConfig(sw, {
    rules: [{ id: 'r1', enabled: true, matchType: 'exact', pattern: 'http://localhost:3000/api/users',
      method: 'ANY', action: 'offline', delayMs: 0 }],
    recording: false, replay: false, configVersion: 1,
  });
  await assert.rejects(
    () => dispatchFetch(sw, new MiniRequest('http://localhost:3000/api/users')),
    /forced offline/
  );
});

test('随机丢包: 概率 100% 必失败, 0% 必通过', async () => {
  const sw = loadSW();
  await setConfig(sw, {
    rules: [{ id: 'r1', enabled: true, matchType: 'includes', pattern: '/api',
      method: 'ANY', action: 'drop', lossPercent: 100, delayMs: 0 }],
    recording: false, replay: false, configVersion: 1,
  });
  await assert.rejects(() => dispatchFetch(sw, new MiniRequest('http://localhost:3000/api/a')), /packet loss/);
  await new Promise((r) => setTimeout(r, 0));
  await setConfig(sw, {
    rules: [{ id: 'r1', enabled: true, matchType: 'includes', pattern: '/api',
      method: 'ANY', action: 'drop', lossPercent: 0, delayMs: 0 }],
    recording: false, replay: false, configVersion: 2,
  });
  const res = await dispatchFetch(sw, new MiniRequest('http://localhost:3000/api/b'));
  assert.strictEqual(res.status, 200);
});

test('method 不匹配的规则不生效', async () => {
  const sw = loadSW();
  await setConfig(sw, {
    rules: [{ id: 'r1', enabled: true, matchType: 'includes', pattern: '/api',
      method: 'POST', action: 'offline', delayMs: 0 }],
    recording: false, replay: false, configVersion: 1,
  });
  const res = await dispatchFetch(sw, new MiniRequest('http://localhost:3000/api/get-only'));
  assert.strictEqual(res.status, 200);
});

test('录制: 请求体可重复读取（克隆），响应被持久化且返回页面的 body 未被消费', async () => {
  const sw = loadSW();
  await setConfig(sw, { rules: [], recording: true, replay: false, configVersion: 1 });
  const req = new MiniRequest('http://localhost:3000/api/echo', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ n: 42 }),
  });
  const pageResponse = await dispatchFetch(sw, req);
  assert.strictEqual(pageResponse.status, 200);
  const pageText = await pageResponse.text();
  assert.ok(pageText.includes('"ok":true'), '页面必须拿到未消费的真实响应体');

  /* 同一个请求对象若再读 body 会抛错（模拟真实规范），录制内部用的是 clone，不影响此请求 */
  await new Promise((r) => setTimeout(r, 5));
  const list = await sw.DebugDB.listRecordings();
  assert.strictEqual(list.length, 1);
  const entry = list[0];
  assert.strictEqual(entry.method, 'POST');
  assert.strictEqual(JSON.parse(Buffer.from(entry.reqBody).toString('utf8')).n, 42);
  assert.strictEqual(entry.status, 200);

  /* 录制响应体进了专用 Cache */
  const cache = await miniCaches.open('gsb-debug-cache-v1');
  const cached = await cache.match('http://localhost:3000/__gsb_rec__/' + entry.id);
  assert.ok(cached, 'Cache 中应存在录制响应');
  assert.ok((await cached.text()).includes('"ok":true'));
  assert.strictEqual(cached.headers.get('content-encoding'), null, 'content-encoding 必须剥除');
});

test('录制网络失败: 记录 error，离线重放同样失败', async () => {
  const sw = loadSW();
  await setConfig(sw, { rules: [], recording: true, replay: false, configVersion: 1 });
  await assert.rejects(
    () => dispatchFetch(sw, new MiniRequest('http://localhost:3000/network-down')),
    /mock network down/
  );
  await new Promise((r) => setTimeout(r, 5));
  const list = await sw.DebugDB.listRecordings();
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].respType, 'error');

  /* 离线重放（即使全局 fetch 被禁用，SW 也不应触网） */
  sw.fetch = async function () { throw new Error('offline: must not touch network'); };
  const replayReq = new MiniRequest('http://localhost:3000/network-down', {
    headers: { 'x-gsb-replay-id': list[0].id },
  });
  await assert.rejects(() => dispatchFetch(sw, replayReq), /replay of recorded failure/);
});

test('录制 20 个请求后断网重放: 状态与响应体逐一一致', async () => {
  const sw = loadSW();
  await setConfig(sw, { rules: [], recording: true, replay: false, configVersion: 1 });
  const originals = [];
  for (let i = 0; i < 20; i++) {
    const res = await dispatchFetch(sw, new MiniRequest('http://localhost:3000/api/users?batch=' + i));
    originals.push({ status: res.status, body: await res.text() });
  }
  await new Promise((r) => setTimeout(r, 10));
  const list = await sw.DebugDB.listRecordings();
  assert.strictEqual(list.length, 20);

  /* 断网：任何真实 fetch 调用都视为失败 */
  sw.fetch = async function () { throw new Error('OFFLINE'); };
  for (let i = 0; i < 20; i++) {
    const replayReq = new MiniRequest(list[i].url, { headers: { 'x-gsb-replay-id': list[i].id } });
    const res = await dispatchFetch(sw, replayReq);
    assert.strictEqual(res.status, originals[i].status, '第 ' + i + ' 条状态码一致');
    const text = await res.text();
    assert.strictEqual(text, originals[i].body, '第 ' + i + ' 条响应体字节一致');
    assert.strictEqual(res.headers.get('x-gsb-replay'), list[i].id);
  }
});

test('重放不存在的录制 id: 502 miss，不触网', async () => {
  const sw = loadSW();
  sw.fetch = async function () { throw new Error('OFFLINE'); };
  const req = new MiniRequest('http://localhost:3000/api/x', {
    headers: { 'x-gsb-replay-id': 'missing' },
  });
  const res = await dispatchFetch(sw, req);
  assert.strictEqual(res.status, 502);
  assert.strictEqual(res.headers.get('x-gsb-replay'), 'miss');
});

test('导航请求与非 http(s) 协议不拦截', async () => {
  const sw = loadSW();
  const event = {
    request: new MiniRequest('http://localhost:3000/'),
    respondWith() { throw new Error('导航请求不应 respondWith'); },
  };
  event.request.mode = 'navigate';
  fetchListeners.forEach((fn) => fn(event));
  const event2 = {
    request: new MiniRequest('chrome-extension://abc/script.js'),
    respondWith() { throw new Error('扩展请求不应 respondWith'); },
  };
  fetchListeners.forEach((fn) => fn(event2));
});

test('SW activate: 首次激活不清理；检测到旧版本时旧缓存与录制全部清除', async () => {
  /* ---- 场景 1: 首次激活（meta 为空），当前缓存/录制保留 ---- */
  const sw1 = loadSW();
  const c1 = await miniCaches.open('gsb-debug-cache-v1');
  await c1.put('http://localhost:3000/__gsb_rec__/keep', new MiniResponse('keep', { status: 200 }));
  await sw1.DebugDB.putRecording({ id: 'rec1', createdAt: 1, seq: 1 });
  await sw1.__gsbActivate();
  assert.ok((await miniCaches.keys()).includes('gsb-debug-cache-v1'));
  assert.strictEqual((await sw1.DebugDB.listRecordings()).length, 1, '首次激活保留录制');

  /* ---- 场景 2: 从 v0 升级到 v1 ---- */
  await sw1.DebugDB.setKV('meta', { swVersion: 'v0' });
  await (await miniCaches.open('gsb-debug-cache-v0'))
    .put('http://localhost:3000/__gsb_rec__/old1', new MiniResponse('old', { status: 200 }));
  await (await miniCaches.open('unrelated-cache'))
    .put('http://x/y', new MiniResponse('z', { status: 200 }));

  /* 新版 SW 启动：快照并恢复持久层，模拟同一浏览器内的版本升级 */
  const cacheSnapshot = Array.from(cachesMap.entries());
  const kvSnapshot = Array.from(kvStore.entries());
  const recSnapshot = Array.from(recStore.entries());
  const sw2 = loadSW();
  cachesMap.clear();
  cacheSnapshot.forEach(([k, v]) => cachesMap.set(k, v));
  kvStore.clear();
  kvSnapshot.forEach(([k, v]) => kvStore.set(k, v));
  recStore.clear();
  recSnapshot.forEach(([k, v]) => recStore.set(k, v));

  await sw2.__gsbActivate();

  const keys = await miniCaches.keys();
  assert.ok(!keys.includes('gsb-debug-cache-v0'), '旧版本缓存桶必须删除');
  assert.ok(keys.includes('gsb-debug-cache-v1'), '当前版本缓存桶保留（桶内旧条目会被清空）');
  assert.ok(keys.includes('unrelated-cache'), '非本工具的缓存桶不动');
  const v1 = await miniCaches.open('gsb-debug-cache-v1');
  assert.strictEqual((await v1.keys()).length, 0, '版本升级后桶内旧录制响应全部清空');
  assert.strictEqual((await sw2.DebugDB.listRecordings()).length, 0, '版本升级后 IndexedDB 旧录制清空');
  assert.deepStrictEqual(await sw2.DebugDB.getKV('meta', {}), { swVersion: 'v1' }, 'meta 更新为新版本');
});
