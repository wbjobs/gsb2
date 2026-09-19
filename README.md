# 网络调试台（Service Worker 故障注入 + 录制重放）

一个基于 Service Worker + Cache API + postMessage + IndexedDB + BroadcastChannel 的网络调试台页面。

## 启动

```bash
node server.js
# 打开 http://localhost:3000
```

首次打开后按提示刷新一次页面，让 Service Worker 完成接管（`clients.claim` 已处理，多数情况下无需手动刷新）。

## 功能

- 故障注入规则（顺序匹配，首条命中）
  - URL 包含 / 正则匹配
  - 延迟 1–30 秒后再走网络
  - 返回指定状态码
  - 返回指定 mock JSON（可配置 Content-Type）
  - 直接断网（fetch reject，表现与真实断网一致）
  - 随机丢包（按概率注入网络错误）
- 录制真实请求：method、headers、完整二进制请求体与响应体（状态码/响应头/响应体，或网络失败）
- 离线重放：开启离线后逐条重放，自动比对状态码与响应体，网络失败的录制也会被一致地复刻
- SW 生命周期：`skipWaiting` + `clients.claim` + `updateViaCache:'none'`；新版本 activate 时删除所有旧版本 Cache
- 多标签页：规则写入 IndexedDB，经 postMessage 下发 SW，BroadcastChannel + storage 事件广播到所有标签页

## 关键实现点

- 请求体只能读一次：录制时 `request.clone()`，原请求原样 `fetch(request)`，克隆体读取 body；响应同理用 `response.clone()`。
- 缓存不污染正常请求：透传路径永远不调用 Cache API；Cache 仅保存重放快照，且使用合成 GET key（`https://debug-console.local/__debug_cache__/...`）绕开 Cache 不支持 POST 的限制。
- 重放路由：重放请求带 `X-Debug-Replay-Id` 自定义头，SW 优先识别，直接用录制快照响应，不走网络、不受规则影响。
- 响应保真：录制时剥除 `content-encoding/content-length/transfer-encoding` 等 hop-by-hop 头，存入的是已解压字节，避免重放时双重解码。
- 跨标签页一致性：SW 只持有内存配置；页面是配置的唯一写者，写 IndexedDB 后通过 `postMessage(MessageChannel)` 等 SW ACK，再由 SW 广播 `state-changed`。

## 验收步骤

1. **规则严格生效**：打开“故障注入总开关”，新增规则匹配 `/api/users` → 直接断网，点“发 1 个演示请求”，控制台/日志显示请求 reject；改 mock JSON 后响应体与配置一致；延迟规则耗时 ≥ 配置值。
2. **录制 20 个 + 断网重放一致**：开启“录制真实请求”，点“发 20 个演示请求”，等录制表出现 20 条；点“断网重放全部”，工具先打开离线开关、跑离线探针验证断网生效，再逐条重放，结果表全部为“一致”（`20/20`）。
3. **SW 更新无旧缓存残留**：修改 `sw.js` 顶部 `VERSION`，点“检查更新”后刷新；activate 阶段会 `caches.keys()` 删除所有 `debug-console-replay-*` 旧缓存（DevTools → Application → Cache Storage 可见只剩新缓存，且为空直到再次录制）。
4. **多标签页同步**：再开一个 `http://localhost:3000` 标签页，任一页改规则/开关，另一页即时同步；“受控标签页”表显示全部在线标签页。

## 文件

- `index.html` / `styles.css`：调试台 UI
- `js/db.js`：共享 IndexedDB 封装（state / records / meta）
- `js/app.js`：页面逻辑（规则、录制列表、重放比对、SW 生命周期、多标签页）
- `sw.js`：Service Worker（拦截、规则引擎、录制、重放、缓存版本清理）
- `server.js`：零依赖演示服务器
