# syl-listing-worker

`syl-listing-pro` 的服务端执行引擎（初始实现）。

## 已实现（M2）

- `POST /v1/auth/exchange`：`X-SYL-KEY` 换取 `JWT(900s)`
- `GET /v1/rules/resolve`、`POST /v1/rules/refresh`
- `GET /v1/rules/download/:tenant/:version`（鉴权后下载）
- `POST /v1/admin/tenant-rules/publish`（`X-ADMIN-TOKEN`）
- `POST /v1/admin/tenant-rules/rollback`（`X-ADMIN-TOKEN`）
- `POST /v1/generate`：异步入队，返回 `job_id`
- `GET /v1/jobs/:jobId`：查询任务状态
- `GET /v1/jobs/:jobId/result`：一次性读取并清理结果
- `BullMQ + Redis` 异步执行链路
- 真实生成链路：`fluxcode` 英文分段生成 + `deepseek` 中文逐段翻译
- 规则驱动：从租户规则包加载 `title/bullets/description/search_terms/translation` section

## 环境变量

复制模板并填写：

```bash
cp .env.example .env
```

关键变量：

- `SYL_LISTING_KEYS`：格式 `tenant_id:key,tenant2:key2`
- `JWT_SECRET`：至少 16 位
- `REDIS_URL`：BullMQ 与任务状态存储
- `ADMIN_TOKEN`：rules 发布口令
- `RULES_FS_DIR`：规则包落盘目录
- `API_PUBLIC_BASE_URL`：返回下载 URL 的前缀

## 本地启动

```bash
npm install
npm run dev        # API
npm run dev:runner # Runner
```

## 自检

```bash
npm run typecheck
npm run build
```

## 下一步

- 接入 PostgreSQL（替换/补充 Redis 任务元数据存储）
- 对接 `openai-agents-js` 的 agent 编排（当前为手工编排）
- 增加更完整的规则校验与审计报表
