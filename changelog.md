# Changelog

All notable changes to **AI-HUB-worker** (`XCQ0607/AI-HUB-worker`) will be documented in this file.

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
