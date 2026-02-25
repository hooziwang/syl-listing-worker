# syl-listing-worker 设计文档（v3，部署于 syl-server）

## 1. 目标
- 建立三仓架构：
  - `syl-listing-pro`：本地 CLI（public）
  - `syl-listing-worker`：服务端执行引擎（private）
  - `syl-listing-pro-rules`：租户规则中心源码仓（private）
- `worker` 统一部署到 `syl-server (43.135.112.167)`。
- 用户端仅使用 `SYL_LISTING_KEY`。
- 仅支持租户规则，每个租户独立规则集、独立版本。

## 2. 职责边界

### 2.1 CLI（`syl-listing-pro`）
- 本地命令入口、文件扫描、任务提交、结果落盘。
- `gen` 启动前强制检查规则更新并同步本地规则缓存。
- 不负责模型调用、规则解析、计费与安全策略。

### 2.2 Worker（`syl-listing-worker`）
- 鉴权：`SYL_LISTING_KEY -> access_token`。
- 规则装载：按租户与版本装载规则快照。
- 任务编排：生成、校验、修复、翻译。
- 模型调用：生成走 `fluxcode`，翻译走 `deepseek`。
- 审计与计费（租户限流与配额首发不实现）。

### 2.3 Rules（`syl-listing-pro-rules`）
- 维护规则 schema、校验器、发布流水线。
- 发布租户完整规则快照到 `syl-server` 规则目录并登记版本。
- 不在 Git 仓库直接保存生产租户规则明文。

## 3. 部署架构（syl-server）

### 3.1 部署形态
- 服务器：`43.135.112.167`
- 形态：`Docker Compose + systemd`
- 入口：`Nginx/Caddy + TLS`

### 3.2 服务组件
1. `api`：HTTP API 服务（Node.js + TypeScript + Fastify + openai-agents-js）
2. `job-runner`：独立异步任务执行进程
3. `postgres`：主数据（租户、keys、任务、审计、计费）
4. `redis`：必选，BullMQ 队列 + 缓存
5. `rules-fs`：本地规则目录（固定 `/data/syl-listing/rules`）

### 3.3 拓扑
```text
CLI (Go)
  -> https://api.syl-server/... (43.135.112.167)
       -> API Service
       -> Redis Queue
       -> Job Runner
       -> fluxcode (https://flux-code.cc, responses, generation)
       -> deepseek (https://api.deepseek.com, chat_completions, translation)
       -> PostgreSQL
       -> Local Rules Filesystem (/data/syl-listing/rules)
```

## 4. 关键决策（已定）
1. 任务接口固定异步；CLI 默认阻塞轮询，提供同步体验。
2. 生成模型固定 `fluxcode`，翻译模型固定 `deepseek`。
3. 规则发布必须是“完整快照发布”。
4. 规则中心不可达时：
   - 非首次运行：回退本地规则继续执行并提示。
   - 首次运行且本地无规则：失败退出。
5. 规则目录固定：`/data/syl-listing/rules`。
6. 保留 `job-runner` 与 `redis`，API 不直接执行长任务。
7. 服务端不保存结果文件，仅返回结果内容给 CLI。

## 5. 模型与配置

### 5.1 默认模型分工
- 生成：`fluxcode / gpt-5.3-codex / reasoning=high`
- 翻译：`deepseek / deepseek-chat`

### 5.2 固定默认配置
```toml
model_provider = "fluxcode"
model = "gpt-5.3-codex"
model_reasoning_effort = "high"
translation_model_provider = "deepseek"
translation_model = "deepseek-chat"

[model_providers.fluxcode]
name = "fluxcode"
base_url = "https://flux-code.cc"
wire_api = "responses"
requires_openai_auth = true

[model_providers.deepseek]
name = "deepseek"
base_url = "https://api.deepseek.com"
wire_api = "chat_completions"
requires_openai_auth = false
```

### 5.3 密钥边界
- 厂商 Key 仅在服务端环境变量/密钥管理器。
- CLI 永不接触厂商 Key。

## 6. 规则模型

### 6.1 规则结构
- 每个 section 一个规则文件（如 `title.yaml`、`bullets.yaml`）。
- 单文件同时包含：
  - 生成指令（模型可读）
  - 结构化约束（程序可校验）
  - 执行策略（重试/修复/fallback）

### 6.2 版本
- 版本格式：`tenant-<tenant_id>-vN` 或 `tenant-<tenant_id>-<hash>`。
- 每个任务记录 `rules_version`，保证可追溯与可回放。

## 7. 任务执行模型

### 7.1 工作流
- EN：`title`、`bullets`、`description`、`search_terms`
- CN（翻译）：`category_keywords_cn`、`title_cn`、`bullets_cn`、`description_cn`、`search_terms_cn`
- 依赖：EN 对应 section 完成后立刻触发对应 CN 翻译。

### 7.2 执行器（统一）
1. `generate`
2. `validate`
3. `repair`（`whole` / `item`）
4. `fallback`
5. `emit event`（日志 + trace）

### 7.3 并发与可靠性
- 能并发就并发。
- 并发控制由 BullMQ 队列消费实现（租户限流/配额后续再引入）。
- 外部调用统一指数退避：`base 300~500ms / max 8s / jitter 0.25`。
- 重试上限：生成 `3` 次、翻译 `2` 次。

## 8. API 契约（v1）

### 8.1 Auth
- `POST /v1/auth/exchange`
  - 入参：`X-SYL-KEY`
  - 出参：`access_token`, `expires_in(900s)`, `tenant_id`

### 8.2 Rules
- `GET /v1/rules/resolve?current=<version>`
  - 出参：`up_to_date`, `rules_version`, `manifest_sha256`, `download_url`
- `POST /v1/rules/refresh`
  - 行为：强制刷新并返回最新版本

### 8.3 CLI 规则同步（强制）
1. `gen` 启动先调用 `rules/resolve`。
2. 有新版本先下载规则包。
3. 校验 `sha256 + 签名` 通过后原子替换本地缓存。
4. 下载失败：
   - 非首次运行：提示并回退本地规则继续执行。
   - 首次运行：失败退出。

### 8.4 Generate
- `POST /v1/generate` -> `job_id`
- `GET /v1/jobs/{job_id}` -> `queued|running|succeeded|failed`
- `GET /v1/jobs/{job_id}/result` -> EN/CN 内容、校验报告、耗时、计费摘要（一次性读取；首次成功返回后立即清理任务结果与任务记录）

### 8.5 Admin（内部）
- `POST /v1/admin/tenant-rules/publish`
- `POST /v1/admin/tenant-rules/rollback`
- `POST /v1/admin/keys`
- `POST /v1/admin/keys/revoke`

## 9. 数据与文件

### 9.1 PostgreSQL
- `tenants`
- `api_keys`
- `tenant_rule_releases`
- `tenant_rule_bindings`
- `jobs`
- `job_items`
- `audit_logs`
- `billing_usage`

### 9.2 Redis
- 队列（`BullMQ`）
- 规则快照缓存 / token 黑名单

### 9.3 本地文件（仅规则）
- `/data/syl-listing/rules/<tenant_id>/<rules_version>/rules.tar.gz`
- 不保存 `listing_*.md` 结果文件。

## 10. 安全与可观测性

### 10.1 安全
- 全链路 HTTPS。
- `SYL_LISTING_KEY` 只存哈希（Argon2id/bcrypt）。
- Token 最小权限（scope）。
- 租户隔离：SQL 条件 + 路径前缀双约束。

### 10.2 日志与追踪
- 日志：统一 NDJSON（`ts, level, tenant_id, job_id, step, event, latency_ms, error`）。
- Trace：generation / validation / repair / translation。

## 11. 发布与运维

### 11.1 发布流程
1. rules 发布：生成租户完整规则快照 -> 调用 `syl-server` 管理接口上传规则包 -> 写入 `tenant_rule_releases`
2. worker 发布：镜像构建 -> `docker compose up -d` -> 冒烟测试
3. cli 发布：多平台二进制与包管理渠道

### 11.2 回滚
- 服务按镜像 tag 回滚。
- 规则按 `rules_version` 回滚。
- 失败任务支持重放。

### 11.3 运维基线
- 进程守护：`systemd`
- 备份：PostgreSQL + `/data/syl-listing/rules`
- 告警：CPU、内存、磁盘、队列堆积、错误率

## 12. 迁移计划
1. 冻结旧仓库：`syl-listing`、`syl-listing-rules`。
2. 新 worker 上线最小闭环：`exchange + resolve + generate(job)`。
3. CLI 接入新 API，保持命令体验。
4. 灰度租户验证质量、时延、成本。
5. 全量切换并下线旧链路。
