# Changelog

All notable changes to **AI-HUB-worker** (`XCQ0607/AI-HUB-worker`) will be documented in this file.

## v1.0.0 (2026-11-22)

### 协议对齐与隧道核心

- **上游协议 v0.1.30 对齐（`0x01`–`0x1E`）**：保持 `HEADER_LEN = 9` 与全部 30 个二值帧指令，不新增 `0x1F+` 私有指令；`.github/upstream-baseline.json` 基线为 `e729dd85 / v0.1.30`。拦截 `/api/relay/**` 控制面路径，对齐无头 `/api/mobile/v1/pair` 的 `503` JSON 响应。
- **注册帧与拒绝语义**：`0x01 register` 支持 `secret` / `version` / `license` 校验（不再读 `pairingCode`）；`0x0C wsError` 在 `id=0` 时返回 `bad_register_secret` / `plugin_too_old` / `instance_mismatch`；`0x0F wsClose` 解析 2 字节 code 与可选 UTF-8 reason。
- **压缩响应透传**：Durable Object 侧对已带 `content-encoding` 的上游响应启用 `encodeBody: 'manual'`（外层 Worker 保持 `automatic` 以匹配 `DO.fetch()` 跨边界自动解压），修复二次压缩导致首次配对 `HTTP 200` 解析失败。
- **blob 分片上传**：绑定 R2 时 `0x02 registered` 下发 `blobUpload: { maxChunkBytes, maxBlobBytes }`；`0x1D blobPut` 支持非零 `id` 的逐片收片与 ack，校验首片 `offset = 0`、`offset === nextOffset`、非尾片 `offset + 片长 < total`、尾片 `offset + 片长 === total`。未绑定 R2 或宿主不支持时回退 `id=0` 整包语义。
- **R2 multipart 存储**：单条密文上限提升到 64 MiB，按 5 MiB 等长分片通过 R2 multipart 流式写入（`uploadPart` / `complete` / `abort`），不再占用 DO 内存；每实例总量 256 MiB，超限先淘汰该实例最旧条目，7 天 TTL 自动过期。
- **分片上传生命周期**：失败 ack 丢弃临时上传并保留旧完整 blob，宿主以新 id 从零重推；片间空闲 90 秒由 `alarm()` 回收，断线时 `dropTunnel` 一并 `abort` 未完成的 multipart 会话。
- **上游 5xx 镜像回退**：可缓存的列表读请求在上游返回 5xx 时，于写出响应头之前改用旧镜像响应（`200` + `x-dsh-relay-mirror: stale`）并取消上游请求；`fresh`、分页、归档、写操作、无缓存及凭据无效的请求保留原响应。
- **MirrorStore 热缓存**：内存指纹去重，内容变更立即落盘、未变的 `0x17 sync` 跳过 SQLite 写入，支持 1 小时保活续期与断线 / Alarm 强制刷盘，避免 DO 休眠丢失变更。
- **连接护栏与 DO 省唤醒**：单隧道 `MAX_PENDING = 256`、全局 `MAX_SSE_CONNECTIONS = 64`、单设备 `MAX_SSE_PER_DEVICE = 3`（超限顶流淘汰）；心跳间隔可配置（默认 `40s`，范围 10–60s），无隧道且非被控模式时自动取消 Alarm。
- **其他核心修复**：修复手机 WebSocket 帧跨实例校验与 `cancel()` 挂起 Promise；修复 `0x1B pushSend` 读取 `pushKind`、Master 交还 Slave 权限解锁、OTA `/latest` SemVer 排序、R2 Blob 跨实例键隔离与批量删除、`0x1C migrate` 校验。
- **边缘 PoP 识别**：提取 `req.cf?.colo` / `country` 展示边缘节点位置，并剥离外部伪造的 `x-aihub-*` 请求头。

### 准入、分发与运维

- **激活码生命周期**：开放 / 限制两种准入模式，`x-dsh-license` 校验；支持到期时间 `expires_at`、续期、多机配额、吊销与恢复、批量操作及 CSV / TXT 导出。
- **7 平台 Webhook 与告警**：Bark、Telegram Bot（HTML 转义）、飞书（HMAC 签名）、钉钉、企业微信、Discord、自定义 HMAC Webhook；严格 SSRF 防护（HTTPS only，拦截私网 / 回环 / CGNAT / ULA / IPv4-mapped IPv6 / 内网域名 / 带凭据 URL）；支持 `0x1B pushSend` 异步桥接与三类运维告警（宿主断线、旧版本拦截、登录爆破），带冷却去重与投递日志。
- **TOTP 2FA**：纯 WebCrypto RFC 6238 HMAC-SHA1 实现，内置 ISO 18004 QR SVG 生成器，支持 8 个一次性恢复码、90 秒时间步防重放与登录挑战流程。
- **只读 `/status` 监控令牌**：生成 / 撤销 `ahm_*` 令牌，通过 `Authorization: Bearer` 或 `?token=` 供 Uptime Kuma / Prometheus 轮询，令牌仅存 SHA-256 哈希。
- **24 小时流量遥测**：按小时记录请求数、上下行字节、离线镜像命中与高流量实例排行，对照 Cloudflare 每日 100k 免费额度可视化水位。
- **连接诊断与接入向导**：`/healthz` → `/api/mobile/v1/health` → 非污染 `/tunnel?diag=` WSS 握手三步探测；接入向导输出桌面插件与无头 CLI 两种配置方式。
- **迁移台账（`0x1C`）**：宿主换中转前登记目标地址，手机收到 `503 migrated` 与 `x-dsh-migrated-to` 后自动切换；支持控制台手动登记与撤销。
- **节点联邦**：主控端生成认领码集中查看被控节点状态并下发准入模式，被控端按周期上报。
- **审计日志**：记录管理动作、登录与准入变更，支持按类别筛选与 CSV / JSON 导出。

### 控制台

- React 19 控制台：品牌 SVG 图标、明暗主题、无原生 `alert` / `confirm` / `prompt`、语义化 `Badge`、全表排序 / 筛选 / 分页 / 批量操作，`<640px` 卡片化布局。
- 文案与可读性整理：标题统一为名词、实现细节下沉到文档，移除无实际信息量的修饰语。

### 工程与发布

- **部署脚本**：`scripts/deploy.mjs` 支持 JSONC 注释解析、代理穿透、自动回填 `env.json` 与 `deploy-output.json`，首次部署自动生成 `ADMIN_TOKEN` 并初始化管理员。
- **协议守护**：`.github/upstream-baseline.json` 快照 + `scripts/sync-reference.mjs`（`--ci` / `--ref-dir` / `--remote` / `--update-baseline`）检测协议漂移。
- **GitHub Actions**：`ci.yml` 执行依赖安装、脚本语法、协议基线、类型检查、前端构建与 `wrangler deploy --dry-run`；`upstream-watch.yml` 每日比对上游并在变化或漂移时开 issue；`release.yml` 支持 Tag 与手动覆盖发布，产出可部署包与源码包及 `SHA256SUMS.txt`。
- **发布包修正**：可部署包只包含 `scripts/deploy.mjs`，`sync-reference.mjs` 改随源码包分发（部署包内缺基线快照与 `reference/`，运行必报找不到基线）。
- **模板与卫生**：`env-template.json` 移除个人邮箱并补全可选变量；`.gitignore` 覆盖 `.env*`、`.dev.vars*`、`*.tsbuildinfo`、`*.p8` / `*.pem` / `*.key`、`Thumbs.db`；修复 `release.yml` 打标发布时的贡献者对比区间。
