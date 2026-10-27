# Independent Website Gateway

独立站网关项目，目标是让每家公司自行部署 CMS 与 Gateway：CMS 提交不可变内容 Release，Gateway 管理站点发布、域名及公网流量。当前处于单机 MVP 开发阶段，**尚不可用于生产环境**。

## 目标架构

- Next.js 控制 API：验证 CMS 服务身份、站点归属，接收 Release 和发布请求；不访问 Docker Socket。
- PostgreSQL：保存 workspace、站点、模板版本、Release 元数据、发布操作与活动部署状态。Release 快照存放在持久卷。
- 独立部署 worker：唯一允许通过受限 Docker 控制通道管理站点容器的服务；公开模板按固定 GHCR 仓库和不可变 digest 拉取，旧本地镜像仍由 `GATEWAY_APPROVED_IMAGE_DIGEST` 批准；候选实例通过健康检查后才切流，失败时保留旧版本。
- Traefik：唯一公网入口，按已验证的域名路由并终止 HTTPS；ACME HTTP-01 负责证书签发与续期。

站点必须使用不可变的模板版本、manifest checksum、镜像 digest 和内容 Release。模板升级需要显式批准。HTTP-01 要求域名解析到网关且公网 80/443 可达，不支持通配符证书。

## 当前状态

本仓库尚未形成经端到端验证的可部署版本。开发方向为 Windows Docker Desktop 本地验证、Linux Docker 单机生产验收；生产发布还需要完成 PostgreSQL 迁移及集成测试、Release 接收的并发与持久化验证、发布 worker、候选站点健康检查与切流/回滚、多域名与 TLS、Compose 隔离和备份恢复演练。不要将本仓库作为已上线服务或已验证的发布系统使用。

## 开发顺序

1. 验证数据库迁移和 Release 的认证、隔离、校验、幂等及快照持久化。
2. 实现持久化发布操作与独立 worker，并验证失败不影响活动站点。
3. 接入 Traefik、多域名和 HTTP-01，在 Linux 公网环境完成证书、恢复和安全边界验收。

本仓库不包含 CMS 草稿预览、多主机调度、高可用集群或自动模板升级。

## CI 与服务器发布

Gateway 的 CI 在 PR 指向 `master`、推送 `master` 或 `release/vMAJOR.MINOR.PATCH` 分支时运行；也可从 Actions 页面手动运行。验证作业使用 PostgreSQL 18，执行迁移、工作区测试（其中控制台测试会构建 Next.js）和 TypeScript 检查。`master` 用于验证；版本化发布分支通过 `production` 环境构建、验证并部署 GHCR 镜像。

发布镜像按提交 SHA 和版本加提交 SHA 标记，并附带 OCI 修订版本、版本及 GitHub provenance。部署脚本先验证镜像证明，再将不可变镜像 digest 和版本交给现有服务器部署流程。服务器发布使用仓库变量 `DEPLOY_HOST`、`DEPLOY_USER`，以及 `production` 环境 Secrets `DEPLOY_SSH_KEY`、`DEPLOY_KNOWN_HOSTS`。不要将 SSH 凭据放入变量或仓库文件。

发布时先更新 `master`，从该提交创建下一个 `release/vMAJOR.MINOR.PATCH` 分支并推送，检查该分支的 Actions 作业直到服务器部署完成。手动运行仅执行验证；重试同一提交的发布应重新运行原始 push 作业。
