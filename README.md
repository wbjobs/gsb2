# gsb 调试台 · Service Worker 故障注入 / 录制重放

一个纯前端调试台：注册 Service Worker 拦截页面**所有** fetch（非导航）请求，支持
按 URL 规则注入故障、录制真实请求、断网后离线重放，并支持多标签页同步控制。

## 启动

```bash
node server.js        # 或 npm start
# 打开 http://localhost:3000
```

> Service Worker 要求 `http://localhost` 或 HTTPS，不能用 `file://` 直接打开。
> 服务器对 `sw.js` / `app.js` 返回 `no-cache`，注册时也使用 `updateViaCache: 'none'`，
> 保证 SW 字节更新后刷新页面即可被发现。

测试：

```bash
npm test              # 规则引擎单测 + 服务器单测 + SW 集成测试（共 27 个用例）
npm run check         # 全部 JS 语法检查
```

SW 集成测试在 Node 中用最小 Request/Response/Cache/IndexedDB mock 直接驱动 `sw.js`
的 fetch/activate 逻辑，无需浏览器。

## 页面操作

1. **故障注入规则**：选择匹配方式（包含/前缀/精确/正则）、URL、Method，动作可选
   - `延迟`：命中后延迟 0–30000ms 再透传
   - `指定状态码`：直接合成该状态码响应（不触网）
   - `Mock JSON`：返回自定义 JSON 与状态码（不触网）
   - `直接断网`：请求以 `TypeError` 失败（等价于网络断开）
   - `随机丢包`：按百分比概率失败，未命中则正常透传（可叠加延迟）
   - 规则按顺序匹配，命中第一条生效；可启停、排序、导入/导出 JSON
2. **测试流量**：一组同源接口按钮 + “批量 20 个请求”
3. **录制 & 重放**：开始录制后发真实请求；在 DevTools → Network 勾选 Offline 后点
   “离线重放全部”，逐条比对状态码、响应头、响应体字节（失败请求比对失败语义）
4. **缓存与生命周期**：检查 CacheStorage、触发 SW 更新检查、注销并重置

## 目录结构

| 文件 | 职责 |
| --- | --- |
| `sw.js` | SW：规则匹配/故障注入、录制持久化、离线重放、生命周期清理、跨客户端广播 |
| `js/rules.js` | 规则引擎（页面/SW/Node 单测三方共用，UMD） |
| `js/db.js` | IndexedDB 封装：`kv`（配置/meta）+ `recordings`（录制元数据） |
| `js/app.js` | 调试台 UI、SW 注册更新、规则管理、录制/重放/校验、多标签页 |
| `server.js` | 零依赖静态服务器 + 演示 API（echo/users/items/status/slow） |
| `test/` | `rules.test.js` / `server.test.js` / `sw.test.js` |

## 关键设计

### 请求体只能读一次
- SW 中对真实网络发出的是 `fetch(request.clone())`，原始 `request` 的 body 留给
  录制读取；读取时再 `request.clone().arrayBuffer()`，任何分支都不消费原始 body。
- 响应同理：录制读取的是 `networkResponse.clone().arrayBuffer()`，返回页面的
  `networkResponse` 保持未消费状态。
- 重放构造请求时 `entry.reqBody.slice(0)` 复制 ArrayBuffer，避免被浏览器
  transfer 后无法二次重放。

### 缓存不污染正常请求
- 只有录制响应进入 Cache API，且使用独立桶 `gsb-debug-cache-<SW_VERSION>`，
  key 是合成路径 `/__gsb_rec__/<recordingId>`，从不执行 `cache.add/match(fetch)`。
- 普通透传/注入请求**没有任何缓存代码路径**；测试流量本身也带 `cache: 'no-store'`。

### 录制 → 离线重放一致性
- 录制内容：method、完整 URL、请求头、请求体（ArrayBuffer）、响应状态、响应头、
  响应体字节（Cache）、网络失败（记录 `errorName`，重放时同样 reject）。
- 重放请求带自定义头 `x-gsb-replay-id`，SW 直接从 IndexedDB + Cache 合成响应，
  **零网络访问**；因此 DevTools Offline 下也能工作。
- 页面逐条比对状态码、关键响应头、响应体字节，失败的录制要求重放也失败。
- 存储响应时剥除 `content-encoding/content-length/transfer-encoding`，避免
  “存的是解压字节但头声称 gzip”导致的损坏。
- 说明：录制时若同时启用了“断网/丢包/状态码/mock”这类**不触网**的硬规则，
  页面严格按规则失败，该请求不存在真实响应，因此不会产生录制（延迟类规则不影响录制）。

### SW 生命周期 / 旧缓存不残留
- `install` 阶段 `skipWaiting()`，`activate` 阶段 `clients.claim()` 并：
  - 删除所有 `gsb-debug-cache-*` 中不等于当前版本的缓存桶；
  - 若 IndexedDB 记录的旧 SW 版本与当前不同，清空旧录制（IDB + 当前缓存桶内容）；
  - 非本工具创建的缓存桶（如 `unrelated-cache`）保持不动。
- 页面监听 `controllerchange` 自动刷新；`updateViaCache: 'none'` + 服务器
  `no-cache` 保证改了 `sw.js` 后“更新检查”立即生效。

### 跨标签页控制
- 配置以 IndexedDB 为单一事实源；任一标签页改规则后：
  1. `postMessage` 推给 SW（SW 更新内存配置并持久化）；
  2. `BroadcastChannel('gsb-debug')` 广播给其它标签页即时刷新 UI；
  3. SW 也会向所有受控客户端广播 `CONFIG_UPDATED` 作为双保险；
  4. 标签页回到前台时主动 `GET_STATE` 全量同步（兜底）。
- 顶栏“受控标签页”数量通过 2s 心跳 + 6s 超时统计。

## 验收标准对照

| 验收项 | 实现/验证 |
| --- | --- |
| 开启故障注入后严格按规则失败 | 硬规则（断网/丢包命中/状态码/mock）不触网；延迟规则先等待；`test/sw.test.js` 覆盖全部动作 |
| 录制 20 个请求后断网重放一致 | “批量 20 个请求”→录制→Offline→重放；集成测试断言 20 条状态码+响应体逐一相等 |
| SW 更新后旧缓存不残留 | `activate` 按版本清桶+清录制；`test/sw.test.js` 模拟 v0→v1 升级 |
| 多标签页同时受控且规则同步 | SW 广播 + BroadcastChannel + IDB 持久化；开两个页面任意一个改规则即可观察 |
