# syl-listing-worker

`syl-listing-pro` 的服务端执行引擎，采用全容器化部署，目标是可快速迁移到任意新服务器。

## 架构

- `worker-api`：HTTP API
- `worker-runner`：异步任务执行
- `redis`：队列与任务状态
- `nginx`：公网入口（80/443）
- `certbot`：证书签发与自动续期

## 部署前准备

- 域名 A 记录指向服务器公网 IP（例如 `worker.aelus.tech`）。
- 云防火墙/安全组放通 `80`、`443`。
- 服务器安装 Docker Engine + Compose v2（推荐 Ubuntu 24.04）。

Ubuntu 安装示例：

```bash
sudo apt-get update -y
sudo apt-get install -y docker.io docker-compose-v2
sudo systemctl enable --now docker
docker --version
docker compose version
```

## 首次部署

1. 准备配置：

```bash
cp .env.example .env
```

2. 编辑 `.env` 必填项：

- `DOMAIN`：域名，例如 `worker.aelus.tech`
- `SYL_LISTING_KEYS`：租户 Key 映射，格式 `tenant_id:key,tenant2:key2`
- `JWT_SECRET`：至少 16 位
- `ADMIN_TOKEN`：规则发布鉴权口令
- `FLUXCODE_API_KEY`
- `DEEPSEEK_API_KEY`

可选项：

- `LETSENCRYPT_EMAIL`：留空时会使用 `--register-unsafely-without-email`

3. 启动：

```bash
mkdir -p data/rules data/redis data/letsencrypt data/certbot-webroot
docker compose up -d --build
```

或直接使用部署脚本：

```bash
bash scripts/deploy.sh
```

从本地直接远程部署（推荐，内置主机指纹自动修复）：

```bash
bash scripts/deploy.sh \
  --remote-host 43.135.112.167 \
  --remote-user ubuntu \
  --install-docker
```

首次重装服务器后，若主机指纹变化，脚本会自动清理旧 `known_hosts` 指纹并拉取新指纹，再继续部署。

远程目录默认 `/opt/syl-listing-worker`，可通过 `--remote-dir` 覆盖。

## 部署后验证

查看容器状态：

```bash
docker compose ps
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

说明：外部诊断默认不发起 `generate` 任务；仅检查健康、鉴权、规则接口。  
如需附加检查生成链路，可加 `--with-generate`，这会发起一次真实 `generate` 任务。

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

1. 将仓库和 `data/` 一并迁移（尤其是规则与证书数据）：

- `data/rules`
- `data/redis`
- `data/letsencrypt`
- `data/certbot-webroot`

2. 在新服务器重复“部署前准备 + 首次部署”步骤。

3. 启动后执行“部署后验证”。

## 从旧 systemd 方案切换（同机迁移）

如果此前使用宿主机 `systemd + nginx`：

1. 停止旧服务：

```bash
sudo systemctl stop syl-listing-worker-api.service syl-listing-worker-runner.service nginx
sudo systemctl disable syl-listing-worker-api.service syl-listing-worker-runner.service nginx
```

2. 将旧数据复制到当前项目 `data/`：

- 规则目录复制到 `data/rules`
- 证书目录复制到 `data/letsencrypt`

3. 运行 `docker compose up -d --build`。

## 运维命令

启动/重启：

```bash
docker compose up -d
docker compose restart
```

停止/删除容器：

```bash
docker compose down
```

查看日志：

```bash
docker compose logs -f --tail=200
docker compose logs -f --tail=200 worker-api worker-runner nginx certbot
```

升级发布（代码更新后）：

```bash
git pull
docker compose up -d --build
```

## 数据与备份

关键数据均在项目内：

- `data/rules`
- `data/redis`
- `data/letsencrypt`
- `data/certbot-webroot`

建议定期打包备份 `data/`。

## 常见故障

- `certbot` 持续重启：
  - 检查 `DOMAIN` 是否正确解析到本机公网 IP。
  - 检查 `80` 端口是否被云防火墙拦截。
- HTTPS 超时：
  - 检查 `docker compose ps` 中 `nginx` 是否 `Up`。
  - 检查 `443` 端口放通。
- `docker compose` 不存在：
  - 安装 `docker-compose-v2`，使用 `docker compose` 命令。
- 服务器重装后 SSH 指纹变化：
  - 使用 `scripts/deploy.sh --remote-host ...`，会自动清理旧 `known_hosts` 指纹并拉取新指纹后重试连接。

## 关键接口

- `POST /v1/auth/exchange`（`Authorization: Bearer <SYL_LISTING_KEY>`）
- `GET /v1/rules/resolve`
- `POST /v1/rules/refresh`
- `GET /v1/rules/download/:tenant/:version`
- `POST /v1/generate`
- `GET /v1/jobs/:jobId`
- `GET /v1/jobs/:jobId/result`

## 本地开发（非容器）

```bash
npm install
npm run dev
npm run dev:runner
```

## 自检

```bash
npm run typecheck
npm run build
```
