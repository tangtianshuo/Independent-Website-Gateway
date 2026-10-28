# Independent Website Gateway

独立站网关项目，目标是让每家公司自行部署 CMS 与 Gateway：CMS 提交不可变内容 Release，Gateway 管理站点发布、域名及公网流量。当前处于单机 MVP 开发阶段，**尚不可用于生产环境**。

## 目标架构

- Next.js 控制 API：验证 CMS 服务身份、站点归属，接收 Release 和发布请求；不访问 Docker Socket。
- PostgreSQL：保存 workspace、站点、模板版本、Release 元数据、发布操作与活动部署状态。Release 快照存放在持久卷。
- 独立部署 worker：唯一允许通过受限 Docker 控制通道管理站点容器的服务；公开模板按固定 GHCR 仓库和不可变 digest 拉取，旧本地镜像仍由 `GATEWAY_APPROVED_IMAGE_DIGEST` 批准；候选实例通过健康检查后才切流，失败时保留旧版本。
- Traefik：唯一公网入口，按已验证的域名路由并终止 HTTPS；ACME HTTP-01 负责证书签发与续期。

站点必须使用不可变的模板版本、manifest checksum、镜像 digest 和内容 Release。模板升级需要显式批准。HTTP-01 要求域名解析到网关且公网 80/443 可达，不支持通配符证书。

## 当前状态

2026-10-27 已完成 Linux Docker 单机部署及 GitHub Actions 到服务器的首次自动发布验证。`release/v1.0.0` 的流水线 `40461546661` 已完成测试、镜像证明验证、数据库备份与迁移、control/worker 更新及线上页面检查。线上服务采用不可变镜像 digest；高可用、多主机调度和完整灾备恢复演练仍需另行规划。

## 开发顺序

1. 验证数据库迁移和 Release 的认证、隔离、校验、幂等及快照持久化。
2. 实现持久化发布操作与独立 worker，并验证失败不影响活动站点。
3. 接入 Traefik、多域名和 HTTP-01，在 Linux 公网环境完成证书、恢复和安全边界验收。

本仓库不包含 CMS 草稿预览、多主机调度、高可用集群或自动模板升级。

## CI 与服务器发布

Gateway 的 CI 在 PR 指向 `master`、推送 `master` 或 `release/vMAJOR.MINOR.PATCH` 分支时运行；也可从 Actions 页面手动运行。验证作业使用 PostgreSQL 18，执行迁移、工作区测试（其中控制台测试会构建 Next.js）和 TypeScript 检查。`master` 用于验证；版本化发布分支通过 `production` 环境构建、验证并部署 GHCR 镜像。

发布镜像按提交 SHA 和版本加提交 SHA 标记，并附带 OCI 修订版本、版本及 GitHub provenance。部署脚本先验证镜像证明，再将不可变镜像 digest 和版本交给现有服务器部署流程。服务器发布使用仓库变量 `DEPLOY_HOST`、`DEPLOY_USER`，以及 `production` 环境 Secrets `DEPLOY_SSH_KEY`、`DEPLOY_KNOWN_HOSTS`。不要将 SSH 凭据放入变量或仓库文件。

发布时先更新 `master`，从该提交创建下一个 `release/vMAJOR.MINOR.PATCH` 分支并推送，检查该分支的 Actions 作业直到服务器部署完成。手动运行仅执行验证；重试同一提交的发布应重新运行原始 push 作业。

## Docker Desktop 本地验收

worker 直接入口使用标准文件 URL 比较，支持绝对路径启动。在 ARM 主机测试当前仅提供 amd64 的公开模板镜像时，可设置 `GATEWAY_DOCKER_PLATFORM=linux/amd64`，由 Docker Desktop 仿真运行；仅允许 `linux/amd64` 或 `linux/arm64`，不设置时保持 Docker 默认架构选择。架构配置同时用于拉取与创建候选实例，镜像 digest 和容器隔离限制仍保持校验。

2026-10-28 的 CMS 三件套本地验收脚本与报告在相邻 CMS 仓库 `ops/e2e/`、`docs/verification/2026-10-28-docker-e2e.md`，worker 仍按现有单机设计作为宿主进程运行。


## 站点容器自动退役

worker 启动后以及空闲轮询期间约每 5 秒扫描一次，只回收匹配本数据库 Release/TemplatePin、站点/工作区/版本标签、精确镜像和 Gateway 隔离配置的无挂载实例。每轮最多尝试 10 个实例，Docker 请求有超时和响应大小限制；失败的删除通过下一轮重新发现重试，重启后仍可继续。

当前路由和前一条恢复备用路由均保留，因此稳定状态通常为每站点最多 2 个受保护实例。有任何 pending 发布（包括过期租约），或数据库活动部署与本机路由不一致时，跳过该站点。回收持有与发布入口相同的 Site 行锁，防止检查与删除之间插入新发布；不会删除 Release、快照、镜像、网络或数据卷。回滚仍通过旧快照创建新候选实例。

这项机制沿用单机权威路由模型。缺少可信归属记录、配置不符或活动路由无法恢复的实例会保留供诊断，不以强制 prune 绕过保护；它不提供多主机调度或高可用协调。
