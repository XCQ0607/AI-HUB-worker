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
| 离线镜像与历史密文 | `0x17 sync` 热缓存 + 变更落盘 + stale 兜底；`0x1D`/`0x1E` R2 密文存储（7 天淘汰，不持密钥） | ✅ |
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

`env.json` 关键配置项（`deploy.mjs` 支持自动生成缺失密钥并回填 `CLOUDFLARE_ACCOUNT_ID`、`PUBLIC_BASE_URL`、`R2_BUCKET`、`ADMIN_TOKEN` 等字段）：

| 变量 | 说明 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` 或 `CLOUDFLARE_EMAIL` + `CLOUDFLARE_API_KEY` | 认证凭据；全空则使用 `npx wrangler login` 的 OAuth 会话 |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID（多账号时必填） |
| `WORKER_NAME` | Worker 名称，默认 `ai-hub-relay` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | 首个管理员账号（密码 ≥ 12 位），部署后自动通过 `/admin/bootstrap` 创建 |
| `ADMIN_TOKEN` | 管理 API 令牌（≥ 16 位），留空自动生成并回填到 `env.json` |
| `TUNNEL_REGISTER_SECRET` | 可选；设置后桌面插件须配置同一注册密钥 |
| `ENABLE_R2` / `R2_BUCKET` | `1` 自动创建并绑定 R2 存储桶（用于历史 Blob 与 OTA）；未开通 R2 时自动降级跳过 |
| `ADMISSION_MODE` | `open`（默认）/ `restricted`（也可在控制台实时切换） |
| `MIN_PLUGIN_VERSION` | 可选，如 `0.5.80`，低于此版本拒绝注册并返回 `plugin_too_old` |
| `PUBLIC_BASE_URL` | 部署后自动回填为 `https://<worker>.workers.dev` 或自定义域名 |

> 网络受限时：在 PowerShell 中设置 `$env:HTTPS_PROXY="http://127.0.0.1:10808"` 后再运行，`deploy.mjs` 会自动通过 `undici.ProxyAgent` 完成管理员初始化请求。

部署完成后可用地址：
- **管理控制台**：`https://<worker>.workers.dev/platform/`
- **手机 App 中转地址**：`https://<worker>.workers.dev`
- **宿主插件隧道**：`wss://<worker>.workers.dev/tunnel`
- **健康检查**：`https://<worker>.workers.dev/healthz` 与 `/api/mobile/v1/health`

## 本地开发与自动化测试

```bash
npm run install:all
npm --prefix worker run dev          # wrangler dev，http://127.0.0.1:8787
npm --prefix web run dev             # 控制台热更新（代理 /api 到 8787）
npm run typecheck                    # 前后端 TypeScript 检查
npm run build:web                    # 构建前端静态资源到 worker/public/platform/
node scripts/sync-reference.mjs --check   # 协议基线与漂移校验
node .dev/e2e-full.cjs               # 本地与云端全量 E2E 接口测试
```

## GitHub Actions 与协议同步

仓库内置 `.github/workflows/` 三套自动化工作流：
- `ci.yml`：每次 Push / PR 自动校验 `sync-reference.mjs --check`（基于 `.github/upstream-baseline.json` 在无 `reference/` 环境下独立运行）、`typecheck` 与 `build:web`。
- `upstream-watch.yml`：定时比对上游 `WNLUO/dsh-mobile-server` 协议表变化，检测潜在协议漂移。
- `release.yml`：手动或 Tag 触发云端构建与覆盖发布，生成发布压缩包与 `SHA256SUMS.txt`，并在 Release 说明中关联 `@XCQ0607`。

## 安全与免费版建议

- **安全**：控制台密码采用 PBKDF2-SHA256（10 万次），会话与监控令牌仅存 SHA-256 哈希，支持 RFC 6238 TOTP 2FA；Webhook 强制 HTTPS 并拦截私网/内网域名/IPv4-mapped IPv6 SSRF；`/status` 仅管理员或监控令牌可见。
- **免费版**：心跳默认 `40s`（10–60s 可调），无连接时自动取消 Durable Object Alarm 节省唤醒；单 Hub 架构保障有状态 WebSocket 帧严格路由，适合个人及中小团队。

## License

MIT。上游协议与设计归 [WNLUO/dsh-mobile-server](https://github.com/WNLUO/dsh-mobile-server) 所有。
