'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const { handler } = require('../server.js');

function call(method, urlPath, bodyText, headers) {
  return new Promise(function (resolve) {
    const req = new EventEmitter();
    req.method = method;
    req.url = urlPath;
    req.headers = Object.assign({ host: 'localhost' }, headers || {});
    const res = {
      statusCode: 200,
      _headers: {},
      _chunks: [],
      writeHead(code, h) { this.statusCode = code; Object.assign(this._headers, h || {}); },
      setHeader(k, v) { this._headers[k.toLowerCase()] = v; },
      write(c) { this._chunks.push(Buffer.from(c)); },
      end(c) {
        if (c) this._chunks.push(Buffer.from(c));
        resolve({ status: this.statusCode, headers: this._headers, body: Buffer.concat(this._chunks).toString('utf8') });
      },
    };
    handler(req, res);
    if (bodyText) req.emit('data', Buffer.from(bodyText));
    req.emit('end');
  });
}

test('静态资源: 首页可访问', async () => {
  const r = await call('GET', '/');
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.includes('gsb 调试台'));
});

test('静态资源: sw.js / app.js 带 no-cache，保证 SW 更新可被发现', async () => {
  const sw = await call('GET', '/sw.js');
  assert.strictEqual(sw.status, 200);
  assert.match(sw.headers['cache-control'], /no-cache/);
  assert.ok(sw.body.includes("SW_VERSION"));
  const app = await call('GET', '/js/app.js');
  assert.match(app.headers['cache-control'], /no-cache/);
});

test('API GET echo 回显查询参数', async () => {
  const r = await call('GET', '/api/echo?q=hello');
  assert.strictEqual(r.status, 200);
  const data = JSON.parse(r.body);
  assert.strictEqual(data.echo.q, 'hello');
  assert.strictEqual(data.method, 'GET');
});

test('API POST echo 回显请求体', async () => {
  const r = await call('POST', '/api/echo', JSON.stringify({ n: 1 }), { 'content-type': 'application/json' });
  const data = JSON.parse(r.body);
  assert.deepStrictEqual(JSON.parse(data.receivedBody), { n: 1 });
  assert.strictEqual(data.contentType, 'application/json');
});

test('API users 支持 batch 参数（20 条批量录制验证用）', async () => {
  const r = await call('GET', '/api/users?batch=7');
  const data = JSON.parse(r.body);
  assert.strictEqual(data.batch, 7);
  assert.strictEqual(data.items[0].id, 70);
});

test('API 自定义状态码 503', async () => {
  const r = await call('GET', '/api/status/503');
  assert.strictEqual(r.status, 503);
  assert.strictEqual(JSON.parse(r.body).error, 'forced status 503');
});

test('未知 API 路径返回 404', async () => {
  const r = await call('GET', '/api/nope');
  assert.strictEqual(r.status, 404);
});
