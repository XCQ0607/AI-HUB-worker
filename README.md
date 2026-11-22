<div align="center">
  <img src="./web/public/favicon.svg" alt="AI-HUB Worker Logo" width="72" height="72" />
  <h1>AI-HUB Worker</h1>
  <p>基于 Cloudflare Workers + Durable Objects 的远程 AI 桌面中转与配套管理控制台</p>

  [![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
  [![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers%20%2B%20Durable%20Objects-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
  [![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
  [![Protocol](https://img.shields.io/badge/Protocol-v2%20(0x01--0x1E)-10B981)](./worker/src/protocol.ts)
</div>

上游 [WNLUO/dsh-mobile-server](https://github.com/WNLUO/dsh-mobile-server) 用 Rust 实现中转，需要一台常驻服务器并自行处理证书与端口暴露。本项目把中转层改写为 Cloudflare Workers + Durable Objects：不需要自有服务器、公网 IP 或证书，可在 Cloudflare 免费额度内运行。

配套内容：React 管理控制台、7 平台 Webhook 推送桥接、TOTP 两步验证、24 小时流量遥测、一键部署脚本。隧道协议与官方 [dsh-mobile-plugin](https://github.com/WNLUO/dsh-mobile-plugin)（桌面插件）及手机 App 的 v2 实现（`0x01`–`0x1E`）保持一致，可直接对接。

```
手机 App (HTTP / SSE / WS, X-Dsh-Instance) ─┐
                                            ├─►  Worker ─► Hub (Durable Object, SQLite + Hibernation WS)
宿主插件 ── 出站 WSS /tunnel (二进制帧 v2) ──┘       ├─ 帧级透传 HTTP / SSE / WebSocket（SSE 每设备上限 3）
浏览器 ── /platform (React 管理控制台 + 2FA) ──►     ├─ 激活码准入(含到期/续期/多设备) / 注册密钥 / 最低版本
监控探针 ── /status (Bearer / ?token= 只读令牌) ─►   ├─ 离线镜像(0x17) / 迁移台账(0x1C) / R2 Blob(0x1D-0x1E)
                                                     └─ APNs 离线推送 + 7 渠道 SSRF 防护 Webhook 告警
```

## 功能

### 隧道与路由

| 能力 | 说明 |
| --- | --- |
| 协议 v2（`0x01`–`0x1E`） | `register` / HTTP / SSE 流式 / 手机 WS 桥接 / 心跳 / `cancel` / `pause` / `resume` |
| 多宿主分发 | 按 `X-Dsh-Instance` 分发；仅 `/api/mobile/v1/pair` 在单宿主时兜底 |
| 连接护栏 | SSE 单设备上限 3、单隧道 pending 上限 256；同实例重连自动顶替旧连接 |

### 准入与分发

| 能力 | 说明 |
| --- | --- |
| 准入模式 | 开放 / 限制；限制模式下校验 `x-dsh-license` |
| 激活码 | 有效期、续期、多设备绑定、批量吊销与导出（CSV / TXT） |
| 插件 OTA | `/api/desktop-plugins/ota/*` 分发紧急完整包，按平台与渠道取 SemVer 最新版 |
| 节点联邦 | 多台中转时由主控端集中查看状态、下发准入模式；被控端按周期上报 |
| 版本门槛 | `MIN_PLUGIN_VERSION` 以下的插件注册时返回 `plugin_too_old` |

### 断线兜底与通知

| 能力 | 说明 |
| --- | --- |
| 离线镜像（`0x17`） | DO SQLite 热缓存 + 变更落盘；宿主断线时返回带 `stale` 标记的清单 |
| 历史密文（`0x1D` / `0x1E`） | R2 存储宿主端到端加密后的密文，7 天 TTL 淘汰，中转不持有密钥 |
| 迁移台账（`0x1C`） | 手机收到 `503 migrated` 与 `x-dsh-migrated-to` 后自动切换中转，支持控制台手动登记 |
| APNs 推送 | ES256 令牌鉴权直连 Apple APNs，用于锁屏提醒 |
| Webhook 告警 | Bark / Telegram / 飞书 / 钉钉 / 企业微信 / Discord / 自定义 HMAC；断线、旧版本、登录爆破三类事件，带冷却与 SSRF 防护 |

### 控制台

| 能力 | 说明 |
| --- | --- |
| 认证 | Email + PBKDF2-SHA256（10 万次）+ RFC 6238 TOTP 2FA（8 个一次性恢复码，90 秒防重放） |
| 运行监控 | 24h UTC 流量柱状图、免费额度水位、PoP 节点、三步连接诊断 |
| 只读监控令牌 | `ahm_*` 令牌供 Uptime Kuma / Prometheus 轮询 `/status`，仅存 SHA-256 哈希，可撤销 |
| 审计日志 | 最近 200 条管理动作，按类别筛选，导出 CSV / JSON |
| 移动端 | `<640px` 卡片化布局；明暗主题 |

## 部署

前置条件：Node.js ≥ 20，Cloudflare 账号。

```bash
git clone https://github.com/XCQ0607/AI-HUB-worker.git && cd AI-HUB-worker
cp env-template.json env.json      # 编辑 env.json（已被 .gitignore，不会提交）
node scripts/deploy.mjs
```

### 配置

`deploy.mjs` 优先读系统环境变量，其次读 `env.json`（支持 JSONC 注释，`_` 开头的字段忽略）。首次部署后自动生成缺失的 `ADMIN_TOKEN`，并回填 `CLOUDFLARE_ACCOUNT_ID`、`PUBLIC_BASE_URL`、`R2_BUCKET`。

**部署与安全**：

| 变量 | 说明 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` 或 `CLOUDFLARE_EMAIL` + `CLOUDFLARE_API_KEY` | Cloudflare 凭据；全留空则使用 `npx wrangler login` 的 OAuth 会话 |
| `CLOUDFLARE_ACCOUNT_ID` | 账号 ID；多账号或代理环境下建议显式填写 |
| `WORKER_NAME` | Worker 名称，默认 `ai-hub-relay` |
| `PUBLIC_BASE_URL` | 对外地址；留空时部署后回填 `workers.dev` 地址，绑定自定义域名时填 `https://<domain>` |
| `DO_LOCATION` | Durable Object 区域提示（`wnam` / `enam` / `sam` / `weur` / `eeur` / `apac` / `oc` / `afr` / `me`） |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | 首个管理员账号（密码 ≥ 12 位），部署后调用 `POST /api/platform/v1/admin/bootstrap` 初始化 |
| `ADMIN_TOKEN` | 管理 API Bearer 令牌（建议 ≥ 16 位）；留空时自动生成 24 字节随机 Base64URL 令牌并回填 |
| `TUNNEL_REGISTER_SECRET` | 设置后，插件须配置相同的 `registerSecret` 才能注册隧道 |
| `TUNNEL_HEARTBEAT_MS` | 宿主心跳间隔，默认 `40000`，范围 `10000`–`60000` |
| `ENABLE_R2` / `R2_BUCKET` | `1` 时自动创建并绑定 R2 桶（默认 `ai-hub-blob`，用于历史密文与 OTA）；账号未开通 R2 时跳过 |
| `ADMISSION_MODE` | `open`（默认）/ `restricted`，也可在控制台实时切换 |
| `MIN_PLUGIN_VERSION` | 如 `0.5.80`；低于此版本的插件注册时返回 `plugin_too_old` |

**离线镜像 / APNs / OTA / 节点联邦**：

| 变量 | 说明 |
| --- | --- |
| `MIRROR_CACHE` / `MIRROR_FALLBACK_MS` | 镜像开关（默认 `1`）与慢隧道回退延迟（默认 `0`，宿主离线时立即返回镜像） |
| `APNS_KEY` / `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_TOPIC` | APNs 令牌鉴权：`.p8` 私钥内容、Key ID、Team ID、App Bundle ID |
| `PLATFORM_OTA_CONTROL_TOKEN` | 供外部 CI / 脚本调用 `/api/desktop-plugins/ota/*` 的独立令牌 |
| `PLATFORM_MASTER_URL` / `PLATFORM_CLAIM_CODE` / `PLATFORM_MASTER_TOKEN` / `PLATFORM_NODE_NAME` / `PLATFORM_REPORT_INTERVAL_SECONDS` | 节点联邦配置；上报间隔默认 `300` 秒 |

> **代理**：网络受限时设置 `HTTP_PROXY` / `HTTPS_PROXY`（PowerShell 写法 `$env:HTTPS_PROXY="http://127.0.0.1:10808"`），`wrangler` 与 `deploy.mjs` 的初始化请求会沿用。若账号自动探测仍失败，直接在 `env.json` 填写 `CLOUDFLARE_ACCOUNT_ID`。

### 部署后的地址

| 用途 | 地址 |
| --- | --- |
| 管理控制台 | `https://<worker>.workers.dev/platform/` |
| 手机 App 中转 | `https://<worker>.workers.dev` |
| 宿主插件隧道 | `wss://<worker>.workers.dev/tunnel` |
| 健康检查 | `/healthz`、`/api/mobile/v1/health` |

## 与上游协议的差异

与 [WNLUO/dsh-mobile-server](https://github.com/WNLUO/dsh-mobile-server)（基线 `v0.1.30`，commit `e729dd85`）在隧道线协议上保持兼容，架构层面按 Workers / DO 运行时做了调整。

**协议一致**：`HEADER_LEN = 9`、全部 30 个二值帧指令一致，无 `0x1F+` 私有指令；CI 运行 `sync-reference.mjs --check --ci` 防漂移。

### 已跟进的上游行为

| 上游行为 | 本地实现 |
| --- | --- |
| `0x01 register` 携带 `secret` / `version` / `license`，不再发 `pairingCode` | `hub.ts` 依次校验注册密钥、最低版本、实例归属 |
| `0x0C wsError` 在 `id=0` 时表示中转拒绝，可带 `code` | 返回 `bad_register_secret` / `plugin_too_old` / `instance_mismatch` |
| `0x0F wsClose` 的载荷为 2 字节 code + 可选 UTF-8 reason | 已解析并透传给手机侧 |
| `stripDeployPrefix` 优先按 `MOBILE_PREFIX` 切分，避免被 `/status` 等短路径抢答 | `protocol.ts` 逻辑与上游一致 |

### 分片上传与镜像兜底

上游 `v0.1.28`–`v0.1.30` 引入的两项能力已对齐，实现位置均在 `worker/src/hub.ts`：

**分片上传（`0x02` + `0x1D`）**。绑定 R2 时，`registered` 帧附带 `blobUpload: { maxChunkBytes: 49152, maxBlobBytes: 5242880 }`，宿主据此启用分片；未绑定 R2 时不下发该字段，宿主自动回退到旧 `blobPut id=0` 整包语义。

分片仍用 `0x1D`，宿主以非零 `u32` 递增 id 标识上传，每条隧道最多一条在途上传。首片携带 `{scope, key, creds, offset: 0, total, final, cipher}`，后续片只需 `{offset, total, final, cipher}`；中转以相同 type/id 回 `{ok, nextOffset, done}`。校验规则与上游一致：每片从上次确认的 `nextOffset` 续传、解码后非空且不超过 `maxChunkBytes`、非尾片满足 `offset + 片长 < total` 且 `final:false`、尾片满足 `offset + 片长 === total` 且 `final:true`。

失败时丢弃临时上传，旧完整 blob 保持可读，宿主以新 id 从零重推；片间空闲超过 90 秒由 `alarm()` 回收。这与上游 `blobstore/upload.rs` 的语义一致，区别在于中转把分片累加在 DO 内存中而非临时文件——单条上限 5 MiB，与 `MAX_BLOB` 相同。

**上游 5xx 镜像回退**。可缓存的列表读请求（`mirror.parseRead` 命中）在收到上游 5xx 时，于写出响应头之前改用自己的旧镜像响应，返回 `200` + `x-dsh-relay-mirror: stale`，并取消上游请求。与弱网超时回退的区别是本路径不等待：上游已经明确失败。`fresh`、分页、归档、写操作、无缓存及凭据无效的请求仍保留原 5xx 响应。

### 保留的中转侧差异

- `HOST` 监听地址与 `TRUSTED_PROXY_CIDRS`：Workers 无监听地址，客户端 IP 由 `cf-connecting-ip` 提供，无需可信代理白名单。
- `MAX_BLOB_TOTAL_BYTES`（上游默认 512 MB 全局淘汰）：本仓库按实例 64 MB + 7 天 TTL 淘汰，全局上限交给 R2 自身配额。
- `MIRROR_FALLBACK_MS` 默认 `0`（上游 `2500`）：默认只在宿主断线时兜底，弱网兜底需显式开启。

**压缩响应透传**：`hub.ts` 在构造透传流时，对已带 `content-encoding` 的上游响应启用 `encodeBody: 'manual'`（外层 Worker 保持默认 `automatic`，以匹配 `DO.fetch()` 跨边界自动解压语义），避免二次压缩导致首次配对 `HTTP 200` 解析失败。

**存储映射**：R2（`BLOB`）替代本地磁盘存储 `0x1D` / `0x1E` 密文（7 天 TTL）；DO 内置 SQLite + 32 MB 内存热缓存（`MIRROR_FALLBACK_MS=0` 默认）替代 Rust 的 `MemAvailable/16` 内存镜像。

**有意的架构差异**：

- **单全局 `Hub` DO + WebSocket Hibernation**：`instanceId` 在首帧 `0x01` 才到达，因此所有隧道经同一 `Hub` DO 路由；用 Hibernation 与 `40s` / `90s` Alarm 替代 Rust 的 `15s` / `60s` 轮询，减少唤醒且不主动 ping 手机 WS。Workers `WebSocket` 不暴露 `bufferedAmount`，故无上传侧 `wait_for_feed_room` 反压。
- **鉴权与控制台**：边缘环境无法用 loopback IP 放行，`/status` 改为管理员会话或 `ahm_*` 只读令牌；控制台默认常开，采用 Email + PBKDF2-SHA256 + TOTP 2FA + `ADMIN_TOKEN`，替代上游 `PLATFORM_ENABLED=1` + OIDC 与 `selfupdate`。
- **额外能力**：到期 / 续期 / 多设备激活码、RFC 6238 TOTP 2FA 与恢复码、7 平台 SSRF 防护 Webhook、24h 遥测、只读监控令牌、R2 OTA / Blob 面板、`0x19` 立即应答。

## 本地开发

```bash
npm run install:all
npm run build:web                         # 首次启动前构建前端到 worker/public/platform/
npm --prefix worker run dev               # wrangler dev，http://127.0.0.1:8787
npm --prefix web run dev                  # 可选：Vite 热更新，http://127.0.0.1:5173
npm run typecheck                         # 前后端 TypeScript 类型检查
node scripts/sync-reference.mjs --check   # 协议基线与漂移校验
```

- **密钥**：本地变量写在 `worker/.dev.vars`（已被 `.gitignore`），`wrangler dev` 自动加载。
- **静态资源**：访问 `http://127.0.0.1:8787/platform/` 前需先执行一次 `npm run build:web`。
- **Vite 代理**：`:5173` 仅把 `/api` 代理到 `:8787`；要测 `/healthz` 与 `/tunnel` WebSocket 握手，请直接用 `:8787` 访问。

## FAQ

**`workers.dev` 无法访问或初始化超时**

在 Cloudflare Dashboard → Workers & Pages → 你的 Worker → Settings → Domains & Routes 绑定自定义域名，并在 `env.json` 填写 `PUBLIC_BASE_URL`。若首次部署的 Step 6 未连上 `workers.dev`，绑定域名后手动初始化一次：

```bash
curl -X POST https://<your-domain>/api/platform/v1/admin/bootstrap \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"<密码至少12位>"}'
```

**外网手机连家里电脑**

插件出站连接 `wss://<your-domain>/tunnel`，家庭网络无需公网 IP 或端口映射；手机把中转地址设为 `https://<your-domain>` 后通过 `/api/mobile/v1/pair` 远程配对。中转下仅 1 台宿主在线时自动路由，多台时手机需携带对应的 `X-Dsh-Instance`。

配对失败时依次核对：① 宿主是否在控制台「在线隧道」显示在线；② `TUNNEL_REGISTER_SECRET` 与插件配置是否一致；③ 是否启用 `restricted` 准入，或 `MIN_PLUGIN_VERSION` 高于当前插件版本。

## 安全与免费额度

- 控制台密码使用 PBKDF2-SHA256（10 万次）；会话与监控令牌仅存 SHA-256 哈希；支持 RFC 6238 TOTP 2FA。
- Webhook 强制 HTTPS，并拦截私网域名、内网地址与 IPv4-mapped IPv6（SSRF）。
- `/status` 仅管理员会话或 `ahm_*` 令牌可读。
- 心跳默认 `40s`（10–60s 可调）；无连接时自动取消 DO Alarm 以减少唤醒。单 Hub 架构保证有状态 WebSocket 帧严格路由，适用于个人与中小团队。

## License

MIT。上游协议与设计归 [WNLUO/dsh-mobile-server](https://github.com/WNLUO/dsh-mobile-server)。
