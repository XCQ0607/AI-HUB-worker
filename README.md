<div align="center">
  <img src="./web/public/favicon.svg" alt="AI-HUB Worker Logo" width="72" height="72" />
  <h1>AI-HUB Worker</h1>
  <p>基于 Cloudflare Workers + Durable Objects 的开源远程 AI 桌面中转服务与现代化管理控制台</p>

  [![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
  [![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers%20%2B%20Durable%20Objects-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
  [![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
  [![Protocol](https://img.shields.io/badge/Protocol-v2%20(0x01--0x1E)-10B981)](./worker/src/protocol.ts)
</div>

把 [WNLUO/dsh-mobile-server](https://github.com/WNLUO/dsh-mobile-server)（Rust 中转）重构为 **Cloudflare Workers + Durable Objects** 版本：无需服务器、无需公网 IP / 证书，可在 Cloudflare 免费版运行；配套现代化 React 管理控制台、7 平台 Webhook 推送桥接、TOTP 两步验证、24 小时流量遥测与一键部署脚本。与官方 [dsh-mobile-plugin](https://github.com/WNLUO/dsh-mobile-plugin)（桌面插件）和手机 App 使用同一隧道协议 v2（`0x01`–`0x1E`），直接对接。

```
手机 App (HTTP / SSE / WS, X-Dsh-Instance) ─┐
                                            ├─►  Worker ─► Hub (Durable Object, SQLite + Hibernation WS)
宿主插件 ── 出站 WSS /tunnel (二进制帧 v2) ──┘       ├─ 帧级透传 HTTP / SSE / WebSocket（SSE 每设备上限 3）
浏览器 ── /platform (React 管理控制台 + 2FA) ──►     ├─ 激活码准入(含到期/续期/多设备) / 注册密钥 / 最低版本
监控探针 ── /status (Bearer / ?token= 只读令牌) ─►   ├─ 离线镜像(0x17) / 迁移台账(0x1C) / R2 Blob(0x1D-0x1E)
                                                     └─ APNs 离线推送 + 7 渠道 SSRF 防护 Webhook 告警
```

## 核心功能

| 能力 | 说明 | 状态 |
| --- | --- | --- |
| 隧道协议 v2 (`0x01`–`0x1E`) | `register` / HTTP / SSE 流式 / 手机 WS 桥接 / 心跳 / `cancel` / `pause` / `resume` | ✅ |
| 多宿主分发与连接护栏 | 按 `X-Dsh-Instance` 分发；仅 `/api/mobile/v1/pair` 单宿主兜底；SSE 单设备上限 3、单隧道 pending 上限 256 | ✅ |
| 准入控制与激活码生命周期 | 开放 / 限制模式；`x-dsh-license` 校验；支持过期时间、续期、多设备绑定、批量操作与 CSV/TXT 导出 | ✅ |
| 离线镜像与历史密文 | `0x17 sync` 热缓存 + 变更落盘 + stale 兜底；`0x1D`/`0x1E` R2 密文存储（7 天 TTL 淘汰，不持密钥） | ✅ |
| 迁移台账 (`0x1C`) 与 OTA | 手机收到 `503 migrated` 自动切换中转；支持控制台手动登记台账；`/api/desktop-plugins/ota/*` 紧急分发 | ✅ 可选 R2 |
| 7 平台 Webhook 与运维告警 | Bark / Telegram / 飞书 / 钉钉 / 企业微信 / Discord / 自定义 HMAC；内置 SSRF 防护与断线/旧版本/爆破告警 | ✅ |
| 安全增强与 TOTP 2FA | PBKDF2-SHA256 + 纯 WebCrypto RFC 6238 TOTP（内置 SVG 二维码 + 8 个一次性恢复码 + 90s 防重放） | ✅ |
| 遥测监控与三步诊断 | 24h UTC 流量柱状图、Cloudflare 免费额度水位、PoP 节点 (`colo`)、三步实时诊断、只读 `/status` 监控令牌 | ✅ |
| 现代化 UI 与移动端适配 | 明暗双主题、全表搜索/筛选/排序/分页、审计日志 CSV/JSON 导出、`<640px` 移动端卡片化布局 | ✅ |

## 一键部署

前置：Node.js ≥ 20，Cloudflare 账号。

```bash
git clone https://github.com/XCQ0607/AI-HUB-worker.git && cd AI-HUB-worker
cp env-template.json env.json      # 编辑 env.json（已被 .gitignore，不会提交）
node scripts/deploy.mjs
```

### 环境变量与 `env.json` 配置

`deploy.mjs` 会优先读取系统环境变量，其次读取 `env.json`（支持 JSONC 注释，`_` 开头字段忽略），并在首次部署后自动生成缺失的 `ADMIN_TOKEN` 及回填 `CLOUDFLARE_ACCOUNT_ID`、`PUBLIC_BASE_URL`、`R2_BUCKET`。

**核心部署与安全配置**：

| 变量 | 说明 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` 或 `CLOUDFLARE_EMAIL` + `CLOUDFLARE_API_KEY` | Cloudflare 认证凭据；全留空则使用 `npx wrangler login` 的 OAuth 会话 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID（多账号或代理环境下建议显式填写） |
| `WORKER_NAME` | Worker 名称，默认 `ai-hub-relay` |
| `PUBLIC_BASE_URL` | 对外访问地址；留空时部署后回填 `workers.dev` 地址，绑定自定义域名时建议填写 `https://<domain>` |
| `DO_LOCATION` | 可选，Durable Object 区域提示（`wnam`/`enam`/`sam`/`weur`/`eeur`/`apac`/`oc`/`afr`/`me`） |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | 首个管理员账号（密码 ≥ 12 位），部署后自动调用 `POST /api/platform/v1/admin/bootstrap` 初始化 |
| `ADMIN_TOKEN` | 管理 API Bearer 令牌（建议 ≥ 16 位）；留空时首次部署自动生成 24 字节随机 Base64URL 令牌并回填到 `env.json` |
| `TUNNEL_REGISTER_SECRET` | 可选；设置后桌面插件须配置相同的 `registerSecret` 才能注册隧道 |
| `TUNNEL_HEARTBEAT_MS` | 可选；宿主心跳间隔毫秒数（默认 `40000`，范围 `10000`–`60000`） |
| `ENABLE_R2` / `R2_BUCKET` | `1` 自动创建并绑定 R2 存储桶（默认 `ai-hub-blob`，用于历史 Blob 与 OTA）；账号未开通 R2 时自动降级跳过 |
| `ADMISSION_MODE` | `open`（默认）/ `restricted`（限制模式校验激活码，亦可在控制台实时切换） |
| `MIN_PLUGIN_VERSION` | 可选，如 `0.5.80`；低于此版本的插件将被拒绝注册并返回 `plugin_too_old` |

**可选高级配置（离线镜像 / APNs / OTA / 多节点联邦）**：

| 变量 | 说明 |
| --- | --- |
| `MIRROR_CACHE` / `MIRROR_FALLBACK_MS` | 离线镜像开关（默认 `1`）与宿主未响应回退延迟毫秒数（默认 `0`，宿主离线时立即返回镜像） |
| `APNS_KEY` / `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_TOPIC` | Apple Push Notification service 令牌鉴权配置（`.p8` 私钥内容、Key ID、Team ID、App Bundle ID） |
| `PLATFORM_OTA_CONTROL_TOKEN` | 可选；用于外部 CI/脚本调用 `/api/desktop-plugins/ota/*` 管理接口的独立控制令牌 |
| `PLATFORM_MASTER_URL` / `PLATFORM_CLAIM_CODE` / `PLATFORM_MASTER_TOKEN` / `PLATFORM_NODE_NAME` / `PLATFORM_REPORT_INTERVAL_SECONDS` | 多节点联邦（被控节点向主控端汇报）配置；上报间隔默认 `300` 秒 |

> **代理提示**：在网络受限环境下，可在终端设置 `HTTPS_PROXY` / `HTTP_PROXY`（如 PowerShell 中 `$env:HTTPS_PROXY="http://127.0.0.1:10808"`）。`wrangler` 及 `deploy.mjs` 的初始化请求会使用该代理；若账号自动探测仍受网络限制，直接在 `env.json` 中填写 `CLOUDFLARE_ACCOUNT_ID` 即可。

部署完成后可用地址：
- **管理控制台**：`https://<worker>.workers.dev/platform/`
- **手机 App 中转地址**：`https://<worker>.workers.dev`
- **宿主插件隧道**：`wss://<worker>.workers.dev/tunnel`
- **健康检查**：`https://<worker>.workers.dev/healthz` 与 `/api/mobile/v1/health`

## 上游协议对齐与 Cloudflare Workers 架构差异

AI-HUB Worker 与上游 [WNLUO/dsh-mobile-server](https://github.com/WNLUO/dsh-mobile-server)（基线 `v0.1.27`）在隧道线协议上保持严格兼容，同时针对 Cloudflare Workers / Durable Objects 运行时做了必要的架构适配：

- **协议 v2 (`0x01`–`0x1E`) 完整对齐**：保持 `HEADER_LEN = 9` 与全部 30 个二值帧指令一致（无 `0x1F+` 私有指令），CI 自动运行 `sync-reference.mjs --check --ci` 防止协议漂移。
- **压缩响应透传 (`content-encoding: gzip`)**：在 Durable Object (`hub.ts`) 构造透传响应流时对已携带 `content-encoding` 的上游响应启用 `encodeBody: 'manual'`（外层入口 Worker 保持默认 `automatic` 以匹配 `DO.fetch()` 跨边界自动解压语义），避免 Cloudflare 二次压缩导致公网首次配对 `HTTP 200` 解析失败。
- **R2 Blob 与 SQLite 离线镜像**：使用 R2 (`BLOB`) 替代本地磁盘存储 `0x1D`/`0x1E` 历史密文（7 天 TTL 淘汰），使用 Durable Object 内置 SQLite + 内存热缓存（32 MB 上限、`MIRROR_FALLBACK_MS=0` 默认）替代 Rust 的 `MemAvailable/16` 内存镜像。
- **有意的 Workers / DO 架构差异**：
  - **单全局 `Hub` DO + WebSocket Hibernation**：因宿主 `instanceId` 在首帧 `0x01` 到达，所有隧道经由同一 `Hub` DO 路由；借助 Hibernation 与 `40s`/`90s` Alarm 替代 Rust 的 `15s`/`60s` 轮询循环（省唤醒，不主动每 15s ping 手机 WS）；Workers `WebSocket` 不暴露 `bufferedAmount`，因此无上传 `wait_for_feed_room` 反压。
  - **鉴权与控制台**：因 Cloudflare 边缘无法使用 loopback IP 放行，`/status` 改为管理员会话或只读 `ahm_*` 监控令牌鉴权；控制台默认常开，采用 Email + PBKDF2-SHA256 + TOTP 2FA + `ADMIN_TOKEN`，替代上游 `PLATFORM_ENABLED=1` + OIDC 与 `selfupdate`。
  - **Worker 增强能力**：内置到期/续期/多设备 `AIHUB-*` 激活码、RFC 6238 TOTP 2FA 与恢复码、7 平台 SSRF 防护 Webhook、24h 流量遥测、只读监控令牌、R2 OTA/Blob 管理面板及 `0x19` 立即应答。

## 本地开发与校验

```bash
npm run install:all
npm run build:web                         # 首次启动前构建前端到 worker/public/platform/
npm --prefix worker run dev               # 启动 wrangler dev（http://127.0.0.1:8787）
npm --prefix web run dev                  # 可选：前端 Vite 热更新（http://127.0.0.1:5173）
npm run typecheck                         # 前后端 TypeScript 类型检查
node scripts/sync-reference.mjs --check   # 协议基线与漂移校验
```

本地开发说明：
- **本地密钥**：在 `worker/.dev.vars`（已被 `.gitignore`）中配置 `ADMIN_TOKEN`、`TUNNEL_REGISTER_SECRET` 等敏感变量，`wrangler dev` 会自动加载。
- **静态资源与控制台**：访问 `http://127.0.0.1:8787/platform/` 前需先执行一次 `npm run build:web` 生成 `worker/public/platform/`。
- **Vite 代理范围**：`web` 开发服务器（`:5173`）仅将 `/api` 代理到 `:8787`；如需测试三步诊断中的 `/healthz` 或 `/tunnel` WebSocket 握手，请直接通过 `http://127.0.0.1:8787/platform/` 访问。

## 常见问题 (FAQ)

- **`workers.dev` 无法访问或初始化超时**：
  在 Cloudflare Dashboard → Workers & Pages → 你的 Worker → **Settings → Domains & Routes** 绑定自定义域名，并在 `env.json` 中填写 `PUBLIC_BASE_URL`。若首次部署时 Step 6 未能连上 `workers.dev`，绑定域名后手动执行一次初始化即可：
  ```bash
  curl -X POST https://<your-domain>/api/platform/v1/admin/bootstrap \
    -H "Authorization: Bearer <ADMIN_TOKEN>" \
    -H "Content-Type: application/json" \
    -d '{"email":"admin@example.com","password":"<密码至少12位>"}'
  ```
- **非局域网远程配对（外网手机连家里电脑）**：
  桌面插件通过出站 WSS 连接 `wss://<your-domain>/tunnel`（无需家庭公网 IP 或端口映射），手机 App 将中转地址设为 `https://<your-domain>` 后即可走 `/api/mobile/v1/pair` 远程配对。若中转下仅在线 1 台宿主会自动路由；若同时在线多台宿主，手机端需携带对应的 `X-Dsh-Instance`。如遇配对失败，请依次核对：① 宿主是否已在控制台「隧道」页显示在线；② `TUNNEL_REGISTER_SECRET` 与插件配置是否一致；③ 是否开启了 `restricted` 准入模式或设置了高于当前插件的 `MIN_PLUGIN_VERSION`。

## GitHub Actions 与协议同步

仓库内置 `.github/workflows/` 三套自动化工作流：
- `ci.yml`：每次 Push / PR 自动校验 `sync-reference.mjs --check --ci`（基于 `.github/upstream-baseline.json` 在无 `reference/` 环境下独立运行）、`typecheck` 与 `build:web`。
- `upstream-watch.yml`：定时比对上游 `WNLUO/dsh-mobile-server` 协议表变化，检测潜在协议漂移。
- `release.yml`：手动或 Tag 触发云端构建与覆盖发布，生成发布压缩包与 `SHA256SUMS.txt`，并在 Release 说明中关联 `@XCQ0607`。

## 安全与免费版建议

- **安全**：控制台密码采用 PBKDF2-SHA256（10 万次），会话与监控令牌仅存 SHA-256 哈希，支持 RFC 6238 TOTP 2FA；Webhook 强制 HTTPS 并拦截私网/内网域名/IPv4-mapped IPv6 SSRF；`/status` 仅管理员或监控令牌可见。
- **免费版**：心跳默认 `40s`（10–60s 可调），无连接时自动取消 Durable Object Alarm 节省唤醒；单 Hub 架构保障有状态 WebSocket 帧严格路由，适合个人及中小团队。

## License

MIT。上游协议与设计归 [WNLUO/dsh-mobile-server](https://github.com/WNLUO/dsh-mobile-server) 所有。
