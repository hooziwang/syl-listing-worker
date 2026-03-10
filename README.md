# syl-listing-worker

`syl-listing-worker` 是 `syl-listing-pro` 的服务端执行引擎源码仓库。

这个仓库不再提供本地容器开发/调试入口。  
所有运行验证、部署、诊断、日志查看，统一通过 `syl-listing-pro-x` 在远端 `syl-server` 上执行。

## 用途边界

- 本仓库负责：
  - 保存 worker 源码
  - 保存 `Dockerfile`、`docker-compose.yml`、`worker.config.json`
  - 本地执行静态检查与构建
- 本仓库不再负责：
  - 本地启动容器
  - 本地查看容器日志
  - 本地诊断
  - 远端部署脚本

## 配置模型

- 非敏感配置：`worker.config.json`
- 敏感配置：`.env`
- compose 变量文件：`.compose.env`

说明：
- `worker.config.json` 纳入仓库管理
- `.env` 不入库
- `.compose.env` 由远端部署流程自动生成，不手工维护

## 本地可执行命令

本地只保留两类命令：

```bash
make test
make build
```

对应：

```bash
npm run typecheck
npm run build
```

推荐在每次提交前至少执行：

```bash
make test
make build
```

## 远端运维

远端运维统一使用 `syl-listing-pro-x`：

```bash
syl-listing-pro-x worker deploy --server syl-server
syl-listing-pro-x worker push-env --server syl-server
syl-listing-pro-x worker diagnose --server syl-server
syl-listing-pro-x worker diagnose-external --key <SYL_LISTING_KEY>
syl-listing-pro-x worker logs --server syl-server --service worker-api --tail 50 --since 10m
```

如果修改了 worker 代码，推荐固定流程：

```bash
cd /Users/wxy/syl-listing-pro/worker
make test
make build

cd /Users/wxy/syl-listing-pro/syl-listing-pro-x
syl-listing-pro-x worker deploy --server syl-server
syl-listing-pro-x worker diagnose --server syl-server
```

## 架构

- `worker-api`：HTTP API
- `worker-runner`：异步任务执行
- `redis`：队列与任务状态
- `nginx`：公网入口
- `certbot`：证书签发与续期

## 关键接口

- `POST /v1/auth/exchange`
- `GET /v1/rules/resolve`
- `POST /v1/rules/refresh`
- `GET /v1/rules/download/:tenant/:version`
- `POST /v1/generate`
- `GET /v1/jobs/:jobId`
- `GET /v1/jobs/:jobId/result`
- `GET /v1/admin/logs/trace/:jobId`
