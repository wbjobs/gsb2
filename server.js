/* 本地演示服务器：静态文件 + 一组可被录制的真实 API。
 * 用法: node server.js  → http://localhost:3000 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function sendJSON(res, status, obj, headers) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  }, headers || {}));
  res.end(body);
}

const API = {
  'GET /api/echo': function (url, body, req, res) {
    sendJSON(res, 200, {
      echo: Object.fromEntries(url.searchParams),
      method: req.method,
      headers: { 'x-trace': req.headers['x-trace'] || null },
      at: new Date().toISOString(),
    }, { 'x-trace': 'echo-' + Math.floor(Math.random() * 1e6) });
  },
  'POST /api/echo': function (url, body, req, res) {
    sendJSON(res, 200, {
      echo: Object.fromEntries(url.searchParams),
      receivedBody: body,
      contentType: req.headers['content-type'],
      at: new Date().toISOString(),
    });
  },
  'GET /api/users': function (url, body, req, res) {
    const batch = url.searchParams.get('batch');
    sendJSON(res, 200, {
      page: 'users',
      batch: batch === null ? null : Number(batch),
      items: Array.from({ length: 3 }, function (_, i) {
        return { id: (batch ? Number(batch) * 10 + i : i + 1), name: 'user-' + i };
      }),
      at: new Date().toISOString(),
    });
  },
  'GET /api/items': function (url, body, req, res) {
    sendJSON(res, 200, { items: ['a', 'b', 'c'], ts: Date.now() });
  },
  'GET /api/status': function (url, body, req, res) {
    const code = Number(url.pathname.split('/').pop()) || 500;
    sendJSON(res, code, { error: 'forced status ' + code });
  },
  'GET /api/slow': function (url, body, req, res) {
    setTimeout(function () { sendJSON(res, 200, { slow: true, waited: 3000 }); }, 3000);
  },
};

function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const chunks = [];
  req.on('data', function (c) { chunks.push(c); });
  req.on('end', function () {
    const body = Buffer.concat(chunks).toString('utf8');
    let key = req.method + ' ' + (url.pathname.startsWith('/api/status/') ? '/api/status' : url.pathname);
    if (url.pathname.startsWith('/api/')) {
      const handler = API[key];
      if (handler) return handler(url, body, req, res);
      return sendJSON(res, 404, { error: 'no such api: ' + url.pathname });
    }

    let filePath = path.join(ROOT, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
    fs.readFile(filePath, function (err, data) {
      if (err) { res.writeHead(404); return res.end('not found'); }
      const headers = { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' };
      /* SW 脚本本身绝不允许被浏览器缓存，保证 byte 更新能立即被发现 */
      if (filePath.endsWith('sw.js') || filePath.endsWith('app.js')) {
        headers['cache-control'] = 'no-cache, must-revalidate';
      }
      res.writeHead(200, headers);
      res.end(data);
    });
  });
}

const server = http.createServer(handler);

if (require.main === module) {
  server.listen(PORT, function () {
    console.log('gsb 调试台: http://localhost:' + PORT);
  });
}

module.exports = { handler: handler, server: server };
