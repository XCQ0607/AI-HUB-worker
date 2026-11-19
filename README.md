# AI-HUB Worker

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers%20%2B%20Durable%20Objects-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)

把 [WNLUO/dsh-mobile-server](https://github.com/WNLUO/dsh-mobile-server)（Rust 中转）重构为 **Cloudflare Workers + Durable Objects** 版本：无需服务器、无需公网 IP / 证书，可在 Cloudflare 免费版运行；配套现代化 React 管理控制台与一键部署脚本。与官方 [dsh-mobile-plugin](https://github.com/WNLUO/dsh-mobile-plugin)（桌面插件）和手机 App 使用同一隧道协议 v2，直接对接。

```
手机 App (HTTP / SSE / WS, X-Dsh-Instance) ─┐
                                            ├─►  Worker ─► Hub (Durable Object, SQLite + Hibernation WS)
宿主插件 ── 出站 WSS /tunnel (二进制帧 v2) ──┘       ├─ 帧级透传 HTTP / SSE / WebSocket
浏览器 ── /platform (管理控制台) ─────────────►       ├─ 激活码准入 / 注册密钥 / 最低插件版本
                                                     ├─ 实例迁移台账 (0x1C)
                                                     └─ 历史密文 Blob (可选 R2, 0x1D/0x1E)
```

## 功能

| 能力 | 状态 |
| --- | --- |
| 隧道协议 v2：register / HTTP / SSE 流式 / 手机 WS 桥接 / 心跳 / cancel / pause / resume | ✅ |
| 按 `X-Dsh-Instance` 多宿主分发；无实例头仅 `/api/mobile/v1/pair` 单宿主兜底；未知路径统一 404 | ✅ |
| 同实例重连顶替旧隧道、在途请求回 502 | ✅ |
| 路径规范化（双斜杠、尾斜杠、部署前缀 `/relay/...`） | ✅ |
| 准入：开放 / 限制（`x-dsh-license` 握手前校验 + 首次使用绑定设备） | ✅ |
| `TUNNEL_REGISTER_SECRET` 注册密钥、`MIN_PLUGIN_VERSION` 版本门槛 | ✅ |
| 实例迁移台账（手机收到 503 `migrated` 自动换中转） | ✅ |
| 历史密文 Blob（Cloudflare R2，7 天过期 / 单实例 64MB） | ✅ 可选 |
| 镜像离线兜底（`0x17 sync`，断线/超时回 stale 快照，按设备凭据 sha256 鉴权） | ✅ |
| iOS APNs 离线推送（WebCrypto ES256 JWT + 分级静音偏好 + `/api/mobile/v1/push-token`） | ✅ 可选 |
| 插件紧急 OTA 分发（`/api/desktop-plugins/ota/*`，基于 R2） | ✅ 可选 |
| 主控端 / 被控端多节点联邦（认领码 `NODE-XXXX-XXXX` 与远程准入下发） | ✅ |
| 控制台管理：概览 / 在线隧道 / 激活码(多设备绑定解绑) / 节点联邦 / 存储与推送 / OTA / 审计日志 / 设置 | ✅ |
| 微信 OIDC 登录 / Linux 二进制自更新 | ⛔ 按架构改用邮箱密码登录与 `deploy.mjs` 部署 |

> 注：控制台登录方式已按 Worker 自建场景简化为「管理员邮箱 + 密码（PBKDF2）」，无需微信开放平台三件套即可开箱使用。

## 一键部署

前置：Node.js ≥ 20，Cloudflare 账号（本项目默认部署到 `xcq0607@gmail.com` 账号）。

```bash
git clone https://github.com/XCQ0607/AI-HUB-worker.git && cd AI-HUB-worker
cp env-template.json env.json      # 编辑 env.json（已被 .gitignore）
node scripts/deploy.mjs
```

`env.json` 关键项：

| 变量 | 说明 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` 或 `CLOUDFLARE_EMAIL` + `CLOUDFLARE_API_KEY` | 认证；全空则使用 `npx wrangler login` 的 OAuth 会话 |
| `CLOUDFLARE_ACCOUNT_ID` | 多账号时必填 |
| `WORKER_NAME` | 默认 `ai-hub-relay` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | 首个管理员（密码 ≥ 12 位），部署后自动创建 |
| `ADMIN_TOKEN` | 管理 API 令牌（≥16 位），留空自动生成并回填 |
| `TUNNEL_REGISTER_SECRET` | 可选；设置后插件必须配置同一注册密钥 |
| `ENABLE_R2` / `R2_BUCKET` | `1` 自动创建并绑定 R2 桶；账号未开通 R2 自动跳过 |
| `ADMISSION_MODE` | `open`（默认）/ `restricted`（也可在控制台切换） |
| `MIN_PLUGIN_VERSION` | 可选，如 `0.4.8` |

脚本流程：安装依赖 → 构建控制台 → 解析账号 → 创建 R2 → 生成 `wrangler.generated.json` → `wrangler deploy` → 写入 secrets → 创建管理员 → 输出 `deploy-output.json`。

> 网络受限时：`$env:HTTPS_PROXY="http://127.0.0.1:10808"`（PowerShell）后再运行。

部署后：
- 管理控制台：`https://<worker>.workers.dev/platform/`
- 手机 App 中转地址：`https://<worker>.workers.dev`
- 宿主插件隧道：`wss://<worker>.workers.dev/tunnel`

建议在 Cloudflare 控制台为 Worker 绑定自定义域名（Workers & Pages → Settings → Domains）。

## 本地开发

```bash
npm run install:all
npm --prefix worker run dev          # wrangler dev，http://127.0.0.1:8787
npm --prefix web run dev             # 控制台热更新（代理 /api 到 8787）
npm run typecheck
```

本地创建管理员：在 `worker/.dev.vars` 写入 `ADMIN_TOKEN=local-dev-token-1234`，然后
`curl -X POST http://127.0.0.1:8787/api/platform/v1/admin/bootstrap -H "Authorization: Bearer local-dev-token-1234" -H "Content-Type: application/json" -d '{"email":"a@b.co","password":"change-me-12345"}'`。

## 同步上游参考

将官方仓库克隆到 `reference/`（已 gitignore）：

```bash
git clone https://github.com/WNLUO/dsh-mobile-server reference/dsh-mobile-server
git clone https://github.com/WNLUO/dsh-mobile-plugin  reference/dsh-mobile-plugin
node scripts/sync-reference.mjs        # git pull（失败自动走 127.0.0.1:10808）+ 协议漂移检测
node scripts/sync-reference.mjs --check
```

脚本把 `worker/src/protocol.ts` 的帧类型表 / 自有路径与上游 `protocol-types.js` 对比，上游新增或改号会报错并列出，结果写入 `.dev/reference-sync.json`。

## 免费版注意

- 每日 10 万请求 / 13,000 GB-s：宿主空闲时 WebSocket 休眠不计时长；心跳每 30s 唤醒一次。
- 单 Hub：宿主的 `instanceId` 在首帧才出现，已接受的 WebSocket 无法在 Durable Object 间迁移，因此使用单个全局 Hub，适合个人 / 小团队。
- Worker 单请求内存 128MB：请求体按 256KiB 分块流式转发，上限 64MB。

## 安全

- 控制台密码 PBKDF2-SHA256（10 万次），会话令牌仅存哈希，Cookie `HttpOnly; Secure; SameSite=Lax`，登录限流。
- `/status` 仅管理员可见，其余未认领路径统一 `404 not found`，健康检查只返回服务名。
- 中转不持有任何会话密钥；Blob 仅存宿主加密后的密文，按设备凭据摘要放行拉取。

## License

MIT。上游协议与设计归 [WNLUO/dsh-mobile-server](https://github.com/WNLUO/dsh-mobile-server) 所有。
