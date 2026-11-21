# Changelog

All notable changes to **AI-HUB-worker** (`XCQ0607/AI-HUB-worker`) will be documented in this file.

## Unreleased

### 安全加固、上游协议对齐与工程优化
- **Worker 核心与安全修复**：修复 Durable Object (`hub.ts`) 压缩响应流透传 `encodeBody: 'manual'` 缺失导致的二次压缩（外层 Worker 保持 `automatic` 匹配 `DO.fetch()` 自动解压边界）；修复手机 WebSocket 帧跨实例校验与 `cancel()` 挂起 Promise；修复 `0x1B pushSend` 读取 `pushKind`、Master 交还 Slave 权限解锁、OTA `/latest` SemVer 排序、R2 Blob 跨实例键隔离/批量删除/TTL 校验、`0x1C migrate` 校验及 Bark/SSRF/2FA 鉴权边界问题。
- **前端控制台体验与文案优化**：修正无头配置引导、节点与存储页状态文案、审计日志/激活码导出与筛选体验，完善空态加载、响应式表格及无障碍交互细节。
- **文档、模板与 CI 卫生**：移除 `env-template.json` 中的个人邮箱并补全可选环境变量；加固 `.gitignore`（覆盖 `.env*`、`.dev.vars*`、`*.tsbuildinfo`、`*.p8`/`*.pem`/`*.key`、`Thumbs.db`）；更新 `README.md`（修正 API 路径、补全环境变量/本地开发/架构差异与 FAQ）；修复 `release.yml` 打标发布时贡献者对比区间。

## v1.0.0 (2026-11-20)

### 协议与 Worker 核心优化
- **上游协议严格对齐 (`0x01`–`0x1E`)**：保持 `HEADER_LEN = 9` 与全部 30 个二值帧指令（`register` 到 `blobDelete`）与 `WNLUO/dsh-mobile-server` v0.1.27 完全一致，不新增 `0x1F+` 指令；拦截 `/api/relay/**` 控制面路径；对齐无头 `/api/mobile/v1/pair` `503` JSON 响应与 `x-dsh-relay-mirror: stale` 响应头。
- **MirrorStore 热缓存与防休眠丢失**：内存指纹去重，内容变更立即落盘、未变 `0x17 sync` 跳过 SQLite 写入，支持 1 小时保活续期与断线/Alarm 强制刷盘。
- **连接护栏与 DO 省唤醒**：单隧道 `MAX_PENDING = 256`、全局 `MAX_SSE_CONNECTIONS = 64`、单设备 `MAX_SSE_PER_DEVICE = 3`（超限顶流淘汰）、可配置心跳间隔（默认 `40s`，10–60s），无隧道且非被控模式自动取消 Alarm。
- **边缘 PoP 识别**：提取 `req.cf?.colo` / `country` 展示边缘节点位置，并剥离外部伪造 `x-aihub-*` 请求头。

### 多渠道推送、安全与运维功能
- **7 平台 Webhook 推送与运维告警**：支持 Bark、Telegram Bot（HTML 转义）、飞书（HMAC 签名校验）、钉钉、企业微信、Discord、自定义 HMAC Webhook；内置严格 SSRF 防护（HTTPS only，拦截私网/回环/CGNAT/ULA/IPv4-mapped IPv6/内网域名及凭据 URL）；支持 `0x1B pushSend` 异步桥接与 3 类运维告警（宿主断线、旧版本拦截、登录爆破）。
- **TOTP 2FA 两步验证**：基于纯 WebCrypto RFC 6238 HMAC-SHA1 实现，内置无外部依赖的 ISO 18004 QR SVG 生成器，支持 8 个一次性恢复码、90s 时间步防重放与登录挑战流程。
- **只读 `/status` 监控令牌**：支持生成/撤销 `ahm_*` 监控令牌，通过 `Authorization: Bearer` 或 `?token=` 供 Uptime Kuma / Prometheus 轮询。
- **24 小时流量遥测与免费额度监控**：缓冲记录每小时请求数、上下行字节、离线镜像命中次数及高流量实例排行，对照 Cloudflare 100k/天免费额度可视化进度。
- **三步实时诊断、接入向导与完整生命周期**：提供 `/healthz` → `/api/mobile/v1/health` → 非污染 `/tunnel?diag=` WSS 握手三步探测；激活码支持到期时间 `expires_at`、续期、多选批量操作与 CSV/TXT 导出；支持手动 `0x1C` 迁移台账与审计日志 CSV/JSON 导出。

### 现代化控制台与自动化工程
- **现代化 React 控制台**：全新品牌 SVG 图标（`web/public/favicon.svg`）、明暗主题、无原生 `alert/confirm/prompt`、隐藏边缘原生滚动条、多色语义 `Badge`、全表排序/筛选/分页/批量栏及 `<640px` 移动端卡片化布局。
- **一键部署与 GitHub Actions**：升级 `scripts/deploy.mjs`（JSONC 注释解析、代理穿透、自动回填 `env.json`），新增 `.github/upstream-baseline.json` 与 `ci.yml` / `upstream-watch.yml` / `release.yml`（支持覆盖发布并 `@XCQ0607`）。
