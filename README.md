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
`.env` 仅保留：`JWT_SECRET`、`SYL_LISTING_KEYS`、`ADMIN_TOKEN`、`FLUXCODE_API_KEY`、`DEEPSEEK_API_KEY`。

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
- `FLUXCODE_API_KEY`
- `DEEPSEEK_API_KEY`

4. 启动：

```bash
bash scripts/deploy.sh
```

说明：部署脚本会自动从 `worker.config.json` 生成 `.compose.env`，并用于 `docker compose` 变量替换（`DOMAIN`、`LETSENCRYPT_EMAIL`）。

从本地直接远程部署（推荐，内置主机指纹自动修复）：

```bash
bash scripts/deploy.sh \
  --remote-host 43.135.112.167 \
  --remote-user ubuntu \
  --install-docker
```

部署脚本默认会等待 HTTPS 就绪（证书签发后自动切换 nginx 到 443）。
可选：`--skip-wait-https`、`--https-timeout`、`--https-interval`。

## Makefile 服务器清单

`Makefile` 内置服务器别名，可直接使用：

```bash
make servers
```

默认别名：

- `SERVER=syl-server`
- `REMOTE_HOST=43.135.112.167`
- `REMOTE_USER=ubuntu`
- `REMOTE_PORT=22`
- `REMOTE_DIR=/opt/syl-listing-worker`

## 部署后验证

查看容器状态：

```bash
docker compose --env-file .compose.env ps
```

服务器内诊断（推荐）：

```bash
make diagnose
```

外部诊断（从任意机器发起）：

```bash
make diagnose-external BASE_URL=https://worker.aelus.tech SYL_KEY=<SYL_LISTING_KEY>
# 可选: TIMEOUT=300 INTERVAL=2
# 本机调试可加: RESOLVE=worker.aelus.tech:443:127.0.0.1
# 需要额外检查生成链路时加: DIAGNOSE_EXTERNAL_OPTS="--with-generate"
```

说明：外部诊断默认不发起 `generate`；只检查健康、鉴权、规则接口。  
如需附加检查生成链路，增加 `--with-generate`。

说明：`/healthz` 会校验 `FLUXCODE_API_KEY` 与 `DEEPSEEK_API_KEY` 有效性（带缓存）。  
任一 key 无效时，`/healthz` 返回非 200，`diagnose` 与 `diagnose-external` 会失败。

验证 HTTP 跳转 HTTPS：

```bash
curl -i http://worker.aelus.tech/healthz
```

验证交换接口（只支持 Bearer）：

```bash
curl -i -X POST 'https://worker.aelus.tech/v1/auth/exchange' \
  -H 'Authorization: Bearer <SYL_LISTING_KEY>'
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

启动/重启：

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

升级发布（代码更新后）：

```bash
git pull
bash scripts/deploy.sh
```

下发 `.env` 到远端并重启 worker（默认走 `syl-server`）：

```bash
make push-env
```

说明：`make push-env` 在下发 `.env` 后会自动重建并重启 `worker-api`、`worker-runner`，确保新环境变量生效。

按别名下发：

```bash
make push-env SERVER=syl-server
```

远端完整部署（按别名）：

```bash
make deploy-remote SERVER=syl-server
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
- 服务器重装后 SSH 指纹变化：
  - 使用 `scripts/deploy.sh --remote-host ...`，脚本会自动修复 `known_hosts`。

## 关键接口

- `POST /v1/auth/exchange`（`Authorization: Bearer <SYL_LISTING_KEY>`）
- `GET /v1/rules/resolve`
- `POST /v1/rules/refresh`
- `GET /v1/rules/download/:tenant/:version`
- `POST /v1/generate`
- `GET /v1/jobs/:jobId`
- `GET /v1/jobs/:jobId/result`
