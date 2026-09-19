/*
 * 零依赖演示服务器：
 *   静态托管调试台 + 提供 /api/* 测试接口（含 GET/POST/PUT/DELETE 与慢响应）
 * 运行：node server.js  然后访问 http://localhost:3000
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const pathname = url.pathname;

  // ---------- API ----------
  if (pathname.startsWith('/api/')) {
    // 故意给 API 响应打标记，方便录制/重放一致性比对
    res.setHeader('X-Server-Timestamp', String(Date.now()));

    if (pathname === '/api/users') {
      return sendJSON(res, 200, [
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' }
      ]);
    }

    if (pathname === '/api/orders') {
      return sendJSON(res, 200, {
        orders: [
          { id: 100, item: 'keyboard', qty: 1 },
          { id: 101, item: 'mouse', qty: 2 }
        ],
        page: url.searchParams.get('n') || 0
      });
    }

    if (pathname === '/api/echo' && (req.method === 'POST' || req.method === 'PUT')) {
      const raw = await readBody(req);
      let parsed = raw;
      try { parsed = JSON.parse(raw); } catch (err) { /* 原样返回 */ }
      return sendJSON(res, req.method === 'POST' ? 201 : 200, {
        echoed: parsed,
        method: req.method,
        requestIndex: req.headers['x-request-index'] || null
      });
    }

    if (pathname === '/api/slow') {
      setTimeout(() => sendJSON(res, 200, { slow: true }), 800);
      return;
    }

    const match = pathname.match(/^\/api\/items\/(\d+)$/);
    if (match && req.method === 'DELETE') {
      return sendJSON(res, 200, { deleted: Number(match[1]) });
    }

    return sendJSON(res, 404, { error: 'not found', path: pathname });
  }

  // ---------- 静态文件 ----------
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.join(ROOT, filePath);
  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(fullPath)] || 'application/octet-stream',
      // SW 文件禁止 HTTP 缓存，配合 updateViaCache:'none' 保证更新即时
      'Cache-Control': fullPath.endsWith('sw.js') ? 'no-store' : 'no-cache'
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('调试台已启动: http://localhost:' + PORT);
});
