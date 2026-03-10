# syl-listing-worker

`syl-listing-pro` 的服务端执行引擎，采用全容器化部署，目标是可快速迁移到任意新服务器。

## 架构

- `worker-api`：HTTP API
- `worker-runner`：异步任务执行
- `redis`：队列与任务状态
- `nginx`：公网入口（80/443）
- `certbot`：证书签发与自动续期

## 配置模型

- 非敏感配置：`worker.config.json`（纳入仓库管理）
- 敏感配置：`.env`（不入库，只保存密钥与口令）
- compose 变量文件：`.compose.env`（脚本自动生成，不手改）

`worker.config.json` 负责：域名、端口、重试参数、模型非密钥参数等。  
`.env` 仅保留：`JWT_SECRET`、`SYL_LISTING_KEYS`、`ADMIN_TOKEN`、`DEEPSEEK_API_KEY`。

## 部署前准备

- 域名 A 记录指向服务器公网 IP（例如 `worker.aelus.tech`）。
- 云防火墙/安全组放通 `80`、`443`。
- 服务器安装 Docker Engine + Compose v2（推荐 Ubuntu 24.04）。

Ubuntu 安装示例：

```bash
sudo apt-get update -y
sudo apt-get install -y docker.io docker-compose-v2 python3
sudo systemctl enable --now docker
docker --version
docker compose version
```

## 首次部署

1. 编辑非敏感配置 `worker.config.json`（至少确认 `server.domain`、`server.api_public_base_url`）。
2. 准备敏感配置：

```bash
cp .env.example .env
```

3. 编辑 `.env` 必填项：

- `SYL_LISTING_KEYS`：租户 Key 映射，格式 `tenant_id:key,tenant2:key2`
- `JWT_SECRET`：至少 16 位
- `ADMIN_TOKEN`：规则发布鉴权口令
- `DEEPSEEK_API_KEY`

4. 远端部署统一使用 `syl-listing-pro-x`：

```bash
syl-listing-pro-x worker deploy --server syl-server
```

说明：`syl-listing-pro-x` 会自动从 `worker.config.json` 生成 `.compose.env`，并用于 `docker compose` 变量替换（`DOMAIN`、`LETSENCRYPT_EMAIL`）。

## 部署后验证

查看容器状态：

```bash
docker compose --env-file .compose.env ps
```

服务器内诊断（推荐）：

```bash
syl-listing-pro-x worker diagnose --server syl-server
```

外部诊断（从任意机器发起）：

```bash
syl-listing-pro-x worker diagnose-external --key <SYL_LISTING_KEY>
```

说明：`/healthz` 会校验 `DEEPSEEK_API_KEY` 有效性（带缓存）。  
若切换 `generation.provider=fluxcode`，同时会校验 `FLUXCODE_API_KEY`。

验证 HTTP 跳转 HTTPS：

```bash
curl -i http://worker.aelus.tech/healthz
```

验证交换接口（只支持 Bearer）：

```bash
curl -i -X POST 'https://worker.aelus.tech/v1/auth/exchange' \
  -H 'Authorization: Bearer <SYL_LISTING_KEY>'
```

查询任务全链路日志（管理员接口）：

```bash
curl -sS 'https://worker.aelus.tech/v1/admin/logs/trace/<job_id>?limit=500&offset=0' \
  -H 'Authorization: Bearer <ADMIN_TOKEN>'
```

也支持：

```bash
curl -sS 'https://worker.aelus.tech/v1/admin/logs/trace/<job_id>' \
  -H 'x-admin-token: <ADMIN_TOKEN>'
```

## 迁移到新服务器

1. 将仓库和 `data/` 一并迁移（尤其规则和证书数据）：

- `data/rules`
- `data/redis`
- `data/letsencrypt`
- `data/certbot-webroot`

2. 在新服务器重复“部署前准备 + 首次部署”。
3. 启动后执行“部署后验证”。

## 运维命令

本地容器启动/重启：

```bash
make docker-up
docker compose --env-file .compose.env restart
```

停止/删除容器：

```bash
make docker-down
```

查看日志：

```bash
make docker-logs
docker compose --env-file .compose.env logs -f --tail=200 worker-api worker-runner nginx certbot
```

远端运维统一使用 `syl-listing-pro-x`：

```bash
syl-listing-pro-x worker deploy --server syl-server
syl-listing-pro-x worker push-env --server syl-server
syl-listing-pro-x worker diagnose --server syl-server
syl-listing-pro-x worker diagnose-external --key <SYL_LISTING_KEY>
syl-listing-pro-x worker logs --server syl-server --service worker-api --tail 50 --since 10m
```

## 常见故障

- `certbot` 持续重启：
  - 检查 `worker.config.json` 中 `server.domain` 是否正确解析到本机公网 IP。
  - 检查 `80` 端口是否被云防火墙拦截。
- HTTPS 超时：
  - 检查 `docker compose --env-file .compose.env ps` 中 `nginx` 是否 `Up`。
  - 检查 `443` 端口放通。
- `docker compose` 不存在：
  - 安装 `docker-compose-v2`，使用 `docker compose` 命令。

## 关键接口

- `POST /v1/auth/exchange`（`Authorization: Bearer <SYL_LISTING_KEY>`）
- `GET /v1/rules/resolve`
- `POST /v1/rules/refresh`
- `GET /v1/rules/download/:tenant/:version`
- `POST /v1/generate`
- `GET /v1/jobs/:jobId`
- `GET /v1/jobs/:jobId/result`
- `GET /v1/admin/logs/trace/:jobId`（管理员接口，`Authorization: Bearer <ADMIN_TOKEN>` 或 `x-admin-token: <ADMIN_TOKEN>`）
