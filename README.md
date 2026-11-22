<div align="center">
  <img src="./web/public/favicon.svg" alt="AI-HUB Worker Logo" width="72" height="72" />
  <h1>AI-HUB Worker</h1>
  <p>基于 Cloudflare Workers + Durable Objects 的远程 AI 桌面中转与配套管理控制台</p>

  [![Version](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FXCQ0607%2FAI-HUB-worker%2Fmain%2Fpackage.json&query=%24.version&prefix=v&label=version&color=6C8CFF)](./package.json)
  [![License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
  [![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers%20%2B%20Durable%20Objects-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
  [![TypeScript](https://img.shields.io/badge/TypeScript-5.6+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
  [![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)](https://react.dev/)
  [![Vite](https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white)](https://vite.dev/)
  [![Protocol](https://img.shields.io/badge/Protocol-v2%20(0x01--0x1E)-10B981)](./worker/src/protocol.ts)
  [![GitHub stars](https://img.shields.io/github/stars/XCQ0607/AI-HUB-worker?style=flat&logo=github)](https://github.com/XCQ0607/AI-HUB-worker/stargazers)
  [![GitHub last commit](https://img.shields.io/github/last-commit/XCQ0607/AI-HUB-worker?logo=github)](https://github.com/XCQ0607/AI-HUB-worker/commits/main)
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

前置条件：Node.js ≥ 20，Cloudflare 账号（免费版即可运行 Workers + Durable Objects SQLite；如需历史密文 Blob 与插件 OTA，需在 Cloudflare 后台开通 R2）。

### 快速部署

```bash
git clone https://github.com/XCQ0607/AI-HUB-worker.git && cd AI-HUB-worker
cp env-template.json env.json      # 按需填写配置（所有 env*.json 均已被 .gitignore 忽略）
npx wrangler login                 # 若使用 OAuth 登录；改用 API Token / Global Key 时可跳过
node scripts/deploy.mjs
```

### 认证方式（三选一）

`deploy.mjs` 按以下优先级自动选择 Cloudflare 认证方式：

1. **API Token（推荐用于 CI / 自动化）**：在 `env.json` 填写 `CLOUDFLARE_API_TOKEN`。
   - 前往 Cloudflare Dashboard → **My Profile → API Tokens → Create Custom Token**，授予以下最小权限：
     - `Account` → `Workers Scripts` → `Edit`
     - `Account` → `Workers R2 Storage` → `Edit`（不使用 R2 可不给）
     - `Account` → `Account Settings` → `Read`（用于自动探测 Account ID）
     - `Zone` / `Account` → `Workers Routes` 或 `Custom Domains: Read`（可选；用于自动识别已绑定的自定义域名）
2. **Global API Key**：留空 `CLOUDFLARE_API_TOKEN`，填写 `CLOUDFLARE_EMAIL` + `CLOUDFLARE_API_KEY`。
   - 可在 Cloudflare Dashboard → **My Profile → API Tokens → Global API Key** 查看（拥有账号完整权限，仅建议本地使用）。
3. **Wrangler OAuth（最省事，适合本地）**：上述三项全留空，提前在终端运行 `npx --prefix worker wrangler login` 登录。
   - 如需在本地同时管理**多个 Cloudflare 账号**，可使用 Wrangler 原生 Profile 隔离：
     ```bash
     npx --prefix worker wrangler auth create master   # 登录第一个账号
     npx --prefix worker wrangler auth create slave    # 登录第二个账号
     ```
     部署时传入 `--profile master`（或在批量配置 `deploy.json` 中指定 `profile`）。

### 多节点批量部署（`deploy.json`）

> `deploy.json` 只负责列出「要部署哪些节点及其 `envFile` / `profile`」，每个节点的具体参数（Worker 名称、区域、密钥、主控地址等）依然写在各自的 `env*.json` 中；单节点用户无需创建 `deploy.json`。

如需一键部署多个节点（例如主控端 + 多个海外被控端），可复制 `deploy-template.json` 为 `deploy.json`（已被 `.gitignore`），为每个节点指定对应的 `envFile` 与可选 `profile`：

```bash
cp deploy-template.json deploy.json
node scripts/deploy-cluster.mjs              # 依次部署 deploy.json 中的全部节点
node scripts/deploy-cluster.mjs slave        # 仅部署指定节点
```

### GitHub Actions 自动并行部署

仓库内置了 [.github/workflows/deploy.yml](.github/workflows/deploy.yml)（**Deploy Cluster**），构建一次前端后通过 `strategy.matrix` 并行部署所有节点：

1. 在 GitHub 仓库 **Settings → Secrets and variables → Actions → Secrets** 新增 **`CLUSTER_NODES_JSON`**，值为一个 JSON 数组，每个元素对应一个节点的 `env.json` 配置（需填写 `CLOUDFLARE_API_TOKEN` 与固定 `ADMIN_TOKEN`）。
2. 在仓库 **Actions → Deploy Cluster → Run workflow** 手动触发；留空 `target` 并行部署全部节点，填写某个 `WORKER_NAME` 则仅部署该节点。

`scripts/deploy.mjs` 按顺序完成 6 个步骤：

1. **依赖与前端构建**：在 `worker/`、`web/` 安装依赖，并构建 React 管理控制台到 `worker/public/platform/`（二次部署可传 `SKIP_INSTALL=1` 跳过安装）。
2. **账号解析**：若未配置 `CLOUDFLARE_ACCOUNT_ID`，调用 Cloudflare API 自动识别唯一账号。
3. **域名探测、R2 与配置生成**：优先探测当前 Worker 已绑定的自定义域，尝试创建/复用 R2 桶（账号未开通 R2 时自动跳过），生成 `worker/wrangler.generated.json`。
4. **发布 Worker**：执行 `wrangler deploy`；若首次部署自动探测到的 `PUBLIC_BASE_URL` 尚未写入运行时变量，会自动再同步发布一次。
5. **写入密钥与配置回填**：批量写入 Worker Secrets（如 `ADMIN_TOKEN`、`TUNNEL_REGISTER_SECRET`、`APNS_*` 等），并将 `CLOUDFLARE_ACCOUNT_ID`、`PUBLIC_BASE_URL`、`R2_BUCKET`、`ADMIN_TOKEN` 回填到当前使用的 `env*.json`。
6. **初始化管理员**：等待 6 秒后调用 `POST <url>/api/platform/v1/admin/bootstrap` 创建/更新管理员账号，并把本次摘要写入 `deploy-output.json`（已被 `.gitignore` 忽略）。

**常用运行参数**：

```bash
# 指定其它配置文件（支持 --env / -e 或环境变量 ENV_FILE，默认 env.json）
node scripts/deploy.mjs --env env2.json

# 已有 node_modules 时跳过依赖安装，加快重部署
SKIP_INSTALL=1 node scripts/deploy.mjs                  # Linux / macOS
```

```powershell
# Windows PowerShell：开启本地代理并跳过依赖安装部署指定节点
$env:HTTPS_PROXY="http://127.0.0.1:10808"; $env:HTTP_PROXY="http://127.0.0.1:10808"
$env:SKIP_INSTALL="1"
node scripts/deploy.mjs --env env2.json
```

> **代理**：网络受限时设置 `HTTP_PROXY` / `HTTPS_PROXY`，`wrangler`、Cloudflare API 探测以及 Step 6 的管理员初始化请求都会自动沿用代理。若账号自动探测仍失败，直接在配置文件中显式填写 `CLOUDFLARE_ACCOUNT_ID`。

### Cloudflare 认证方式

`deploy.mjs` 支持三种认证方式，按以下优先级生效（**三选一**）：

| 优先级 | 方式 | 配置方法 | 适用场景 |
| --- | --- | --- | --- |
| 1 | API Token | 填写 `CLOUDFLARE_API_TOKEN` | 跨多账号部署、CI/CD、最小权限隔离 |
| 2 | Global API Key | 同时填写 `CLOUDFLARE_EMAIL` + `CLOUDFLARE_API_KEY`（`CLOUDFLARE_API_TOKEN` 留空） | 已有 Global Key 的个人环境 |
| 3 | Wrangler OAuth | 以上三项全留空，提前执行 `npx wrangler login` | 单账号本机交互式部署（最省心） |

- **OAuth 权限说明**：`wrangler login` 的默认权限完整覆盖账号查询、自定义域识别、R2 桶创建、Worker / Durable Object 部署与 Secrets 管理，单账号下无需额外申请 API Token。
- **自定义 API Token 最小权限**：若使用 API Token，授予 **Account Settings: Read**、**Workers Scripts: Edit**、**Workers R2 Storage: Edit**（启用 R2 时）即可。
- **凭据安全边界**：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_EMAIL`、`CLOUDFLARE_API_KEY` 仅在本地脚本内存与临时 `wrangler` 子进程环境中使用，**不会**写入 `wrangler.generated.json`、`deploy-output.json`，也**不会**上传为 Worker 环境变量或 Secrets，亦不会由脚本回填进 `env*.json`。

### 区域设置（`DO_LOCATION`）

Worker 入口代码在全球边缘节点自动就近执行；真正有区域归属的是承载隧道状态与 SQLite 数据库的单例 **Durable Object（`Hub`）**。通过 `DO_LOCATION` 可向 Cloudflare 提供 `locationHint`：

| 取值 | 区域说明 |
| --- | --- |
| `apac` | 亚太海外（通常落在东京 / 新加坡等，亚洲访问延迟较低） |
| `wnam` / `enam` | 北美西部（美西）/ 北美东部（美东） |
| `weur` / `eeur` | 西欧 / 东欧 |
| `sam` / `oc` / `afr` / `me` | 南美 / 大洋洲 / 非洲 / 中东 |

> **注意**：Cloudflare 的 `locationHint` **仅在 Durable Object 首次创建时生效**。部署并产生首次请求后，再修改 `DO_LOCATION` 不会原地迁移已有 DO；如需更换区域，请改用新的 `WORKER_NAME` 重新部署。

### 自定义域名与地址自动回填

`deploy.mjs` 解析 `PUBLIC_BASE_URL` 遵循以下优先级：

1. 配置文件中已手动填写的非 `workers.dev` 自定义域名（始终尊重，不覆盖）；
2. 自动探测到的当前 Worker 已绑定且启用的 Cloudflare Custom Domain（优先 `production` 环境）；
3. `wrangler deploy` 输出的 `https://<worker>.<subdomain>.workers.dev` 地址。

推荐流程：首次部署完成后，在 Cloudflare Dashboard → **Workers & Pages → 你的 Worker → Settings → Domains & Routes（域）** 添加自定义域，然后重新运行一次 `node scripts/deploy.mjs`（或加 `--env <文件>`）。脚本会自动识别新绑定的域名，将其同步到 Worker 的 `PUBLIC_BASE_URL` 变量，把原回填的 `*.workers.dev` 升级为自定义域名，并使用自定义域名完成 Step 6 初始化。

### 完整配置项

`deploy.mjs` 优先读取系统环境变量，其次读取指定的 `env*.json`（默认 `env.json`，支持 JSONC 注释与尾随逗号，`_` 开头的说明字段自动忽略）。

**部署、认证与安全**：

| 变量 | 说明 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token（优先级最高） |
| `CLOUDFLARE_EMAIL` / `CLOUDFLARE_API_KEY` | Cloudflare 登录邮箱与 Global API Key（需同时填写） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账号 ID；多账号、跨账号或代理环境下建议显式填写，首次部署可自动回填 |
| `WORKER_NAME` | Worker 名称，默认 `ai-hub-relay` |
| `PUBLIC_BASE_URL` | 对外地址；留空或为 `*.workers.dev` 时优先自动识别并回填已绑定的自定义域，否则回填 `workers.dev`；也可手动指定 `https://<domain>` |
| `DO_LOCATION` | Durable Object 区域提示（`apac` / `wnam` / `enam` / `weur` / `eeur` / `sam` / `oc` / `afr` / `me`），首次部署前填写生效 |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | 首个管理员账号（密码 ≥ 12 位），Step 6 自动初始化 |
| `ADMIN_TOKEN` | 管理 API Bearer 令牌（建议 ≥ 16 位）；留空时首次部署随机生成 24 字节 Base64URL 令牌并回填 |
| `TUNNEL_REGISTER_SECRET` | 设置后，宿主插件须配置相同的 `registerSecret` 才能注册隧道（作为 Secret 存储） |
| `TUNNEL_HEARTBEAT_MS` | 宿主心跳间隔（毫秒），默认 `40000`，范围 `10000`–`60000` |
| `ENABLE_R2` / `R2_BUCKET` | `1` 时自动创建并绑定 R2 桶（默认 `ai-hub-blob`，用于历史密文与 OTA）；设为 `0` 或账号未开通 R2 时跳过 |
| `ADMISSION_MODE` | `open`（默认）/ `restricted`，部署后也可在控制台实时切换 |
| `MIN_PLUGIN_VERSION` | 如 `0.5.80`；低于此版本的插件注册时返回 `plugin_too_old` |

**离线镜像 / APNs / OTA / 节点联邦**：

| 变量 | 说明 |
| --- | --- |
| `MIRROR_CACHE` / `MIRROR_FALLBACK_MS` | 离线镜像开关（默认 `1`）与慢隧道回退延迟（毫秒，默认 `0` 表示仅断线时兜底） |
| `APNS_KEY` / `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_TOPIC` | Apple APNs 令牌鉴权：`.p8` 私钥内容、Key ID、Team ID、App Bundle ID（均为 Secret） |
| `PLATFORM_OTA_CONTROL_TOKEN` | 供外部 CI / 脚本调用 `/api/desktop-plugins/ota/*` 的独立令牌（Secret） |
| `PLATFORM_MASTER_URL` | 主控端对外地址（如 `https://master.example.com`，不带 `/platform/`）；填写后本节点即运行于被控模式 |
| `PLATFORM_CLAIM_CODE` | 主控端生成的节点认领码（`NODE-XXXX-XXXX`），须与 `PLATFORM_MASTER_URL` 同时配置才会启动上报 |
| `PLATFORM_MASTER_TOKEN` | 可选的联邦共享密钥（Secret）；主控端若设置了该值，所有被控端须填完全一致的值 |
| `PLATFORM_NODE_NAME` | 被控端在主控列表中的展示名称（默认 `AI-HUB Worker`） |
| `PLATFORM_REPORT_INTERVAL_SECONDS` | 被控端上报周期（秒），默认 `300`，代码强制下限 `30` |

**脚本控制环境变量（仅命令行生效）**：

| 变量 | 说明 |
| --- | --- |
| `ENV_FILE` | 指定配置文件路径（等效于 `--env <文件>`，命令行参数优先级高于 `ENV_FILE`） |
| `SKIP_INSTALL` | 设为 `1` 时跳过 `worker/` 与 `web/` 的 `npm ci` / `npm install`（仍会重新构建前端） |
| `HTTP_PROXY` / `HTTPS_PROXY` | 代理地址（如 `http://127.0.0.1:10808`），透传给 `wrangler` 与 `deploy.mjs` 请求 |

### 多节点集群部署（节点联邦）

节点联邦采用 **主控端（Master）+ 被控端（Slave）** 结构，用于在一处集中观测多台独立中转的状态（在线隧道、地址、激活码与设备计数）并统一下发或交还准入模式（`open` / `restricted` / 自管）。

> **架构边界**：节点联邦不是流量负载均衡集群，也不会在节点间同步激活码、管理员账号、离线镜像或 R2 密文。每台节点都是独立的 Worker + DO SQLite，宿主插件与手机 App 仍各自连接所指向的那台节点（切换中转走 `0x1C` 迁移台账）。

**部署步骤**：

1. **准备主控端**：任何**未填写** `PLATFORM_MASTER_URL` 的正常部署节点默认即为主控端。如需加强上报接口校验，可在主控端填写 `PLATFORM_MASTER_TOKEN` 后重部署一次。
2. **生成认领码**：打开主控端控制台 `https://<主控域名>/platform/` → **节点联邦** → 点击 **生成认领码**，复制弹窗中生成的配置片段。
3. **创建被控端配置文件**：复制一份模板（例如 `cp env-template.json env2.json`，所有 `env*.json` 均不会入库），填入主控端给出的联邦字段，并按场景核对隔离项：
   - **同 Cloudflare 账号部署多个节点**：
     - `WORKER_NAME` **必须改名**（如 `ai-hub-relay-apac`），否则会覆盖已有 Worker；
     - `PUBLIC_BASE_URL` **留空**（自动识别自定义域或回填新地址）或填写独立域名，切勿沿用主控端 URL；
     - `R2_BUCKET` **务必使用独立桶名**（如 `ai-hub-blob-2`），因为密文对象键不含 Worker 名称，共用桶在迁移或 7 天过期清理时会互相干扰；
     - 按需填写 `DO_LOCATION`（如 `apac` / `wnam` / `weur`）。
   - **跨 Cloudflare 账号部署多个节点**：
     - 更换 `CLOUDFLARE_ACCOUNT_ID` 为目标账号 ID；
     - 为各配置文件分别填写目标账号的 `CLOUDFLARE_API_TOKEN`（推荐），或在每次部署前执行 `npx wrangler logout && npx wrangler login` 切换本机 OAuth 账号。
4. **部署被控端**：
   ```bash
   node scripts/deploy.mjs --env env2.json
   ```
5. **验证上报**：
   - DO 在首次被请求（如 Step 6 的 `bootstrap` 或访问 `/healthz`）唤醒后约 5 秒发起首次上报，随后按 `PLATFORM_REPORT_INTERVAL_SECONDS` 周期上报。
   - 在主控端控制台 **节点联邦** 页面确认该节点已显示正确的公网地址与最近上报时间；也可在被控端控制台 **概览 / 节点联邦** 检查是否存在上报错误。
   - 主控端下发准入模式后最多存在 1 个上报周期的生效延迟；接管期间被控端本地无法修改准入模式，直到主控端点「交还」。
   - 与单机节点不同，被控端在无隧道在线时不会取消 DO Alarm，按默认 `300` 秒计每天约 288 次请求，仍在免费额度安全范围内。

### 部署后的地址

| 用途 | 地址（绑定自定义域时替换为 `https://<domain>` / `wss://<domain>`） |
| --- | --- |
| 管理控制台 | `https://<worker>.workers.dev/platform/` |
| 手机 App 中转 | `https://<worker>.workers.dev` |
| 宿主插件隧道 | `wss://<worker>.workers.dev/tunnel` |
| 健康检查 | `/healthz`、`/api/mobile/v1/health` |

## 与上游协议的差异

与 [WNLUO/dsh-mobile-server](https://github.com/WNLUO/dsh-mobile-server)（基线 `v0.1.30`，commit `e729dd85`）在隧道线协议上保持兼容，架构层面按 Workers / DO 运行时做了调整。

**协议一致**：`HEADER_LEN = 9`、全部 30 个二值帧指令一致，无 `0x1F+` 私有指令；CI 运行 `npm run protocol:check` 校验锁文件与生成代码，防漂移。

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
npm run protocol:check                    # 协议锁文件与生成代码校验
```

- **密钥**：本地变量写在 `worker/.dev.vars`（已被 `.gitignore`），`wrangler dev` 自动加载。
- **静态资源**：访问 `http://127.0.0.1:8787/platform/` 前需先执行一次 `npm run build:web`。
- **Vite 代理**：`:5173` 仅把 `/api` 代理到 `:8787`；要测 `/healthz` 与 `/tunnel` WebSocket 握手，请直接用 `:8787` 访问。

## FAQ

**`workers.dev` 无法访问或初始化超时**

在 Cloudflare Dashboard → Workers & Pages → 你的 Worker → Settings → Domains & Routes 绑定自定义域名后，直接重新运行一次 `node scripts/deploy.mjs`（或 `--env <文件>`）即可自动识别并回填自定义域名、重新执行 Step 6 初始化；也可以手动执行一次初始化请求：

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
