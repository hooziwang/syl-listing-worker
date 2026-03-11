# syl-listing-worker

`syl-listing-worker` 是 `syl-listing-pro` 的服务端执行引擎源码仓库。

这个仓库不再提供本地容器开发/调试入口。  
所有运行验证、部署、诊断、日志查看，统一通过 `syl-listing-pro-x` 在远端 `syl-server` 上执行。

本 README 维护 `worker` 仓自身的服务边界、配置模型、运行架构与 API 接口。

跨仓内容分工：

- 规则契约见 `rules/README.md`
- 远端运维与 `e2e` 验证入口见 `syl-listing-pro-x/README.md`
- 终端 CLI 使用入口见 `cli/README.md`

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

## 执行模型

worker 现在是通用 workflow 执行引擎，不再内置固定的 `title/bullets/description` 主流程。

运行时流程：

1. 从规则包读取 `input.yaml`
2. 从规则包读取 `workflow.yaml`
3. 解析输入契约 `file_discovery + fields`
4. 按 `workflow.nodes` 构建 DAG
5. 通过 `WorkflowEngine + ExecutorRegistry` 执行节点

当前支持的节点类型：

- `generate`
- `translate`
- `derive`
- `judge`
- `render`

说明：

- `judge.inputs` 定义审查阶段读取哪些 slot，并用哪些 section 名回报问题
- `render.inputs` 定义模板可使用哪些变量，以及变量从哪个 slot 取值
- slot 之间的数据传递由 `ExecutionContext` 管理
- section 规则、输入字段、展示标签、模板变量都来自规则包，不在 worker 中硬编码

## 规则契约

### `input.yaml`

使用字段驱动结构：

```yaml
file_discovery:
  marker: "===Listing Requirements==="

fields:
  - key: brand
    type: scalar
    capture: inline_label
    labels: ["品牌名", "品牌"]

  - key: keywords
    type: list
    capture: heading_section
    heading_aliases: ["关键词"]
```

### `workflow.yaml`

核心是 `nodes`：

```yaml
nodes:
  - id: title_en
    type: generate
    section: title
    output_to: title_en

  - id: render_en
    type: render
    depends_on: [title_en]
    inputs:
      title_en: title_en
    template: en
    output_to: en_markdown
```

`render.inputs` 和 `judge.inputs` 都属于规则的一部分，worker 只负责执行。

## 关键接口

- `POST /v1/auth/exchange`
- `GET /v1/rules/resolve`
- `POST /v1/rules/refresh`
- `GET /v1/rules/download/:tenant/:version`
- `POST /v1/generate`
- `GET /v1/jobs/:jobId`
- `GET /v1/jobs/:jobId/result`
- `GET /v1/admin/version`
- `GET /v1/admin/logs/trace/:jobId`

工程侧验证说明：

- `release-gate` 继续验证真实规则发布与生成链路。
- `architecture-gate` 负责把私钥来源、worker 地址透传、artifact 完整性等工程治理改动纳入验收。

### `GET /v1/admin/version`

用途：

- 仅供工程侧检查远端 worker 部署版本
- 必须使用 `Authorization: Bearer <ADMIN_TOKEN>`

返回示例：

```json
{
  "ok": true,
  "tenant_id": "admin",
  "service": "syl-listing-worker",
  "git_commit": "e4dae0b",
  "build_time": "2026-03-11T04:59:31Z",
  "deployed_at": "2026-03-11T04:59:31Z",
  "rules_versions": {
    "demo": "tenant-demo-v2-20260227-4",
    "syl": "rules-syl-20260311-034844-nj98ic"
  }
}
```

说明：

- `git_commit` 用于判断远端 worker 是否已部署为本地最新代码
- `rules_versions` 返回服务器上所有租户当前激活的规则版本映射
