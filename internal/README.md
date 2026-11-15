# OpenPets 内网维护基线

本目录记录内网版本的来源、构建入口和发布门槛。当前源码已实现 Windows 本地运行基线、OpenCode 1.x/2.x 插件入口和项目安装脚本；内网依赖镜像、离线安装包构建、企业签名与实际 OpenCode 分支验收仍需在目标环境完成。

## 来源与维护方式

- 上游：<https://github.com/OpenPetsHQ/openpets>。
- 固定基线：`163c80281c5c2739776773e4993516471bfd71cf`（2026-11-13 的上游提交）。当前 `internal/main` 从该提交建立。上游的 `v4.1.0` 标签是另一提交；不能用标签代替此基线 SHA。
- 许可证：仓库根目录 `LICENSE` 为 MIT，版权为 `Copyright (c) 2026 OpenPets`。内部修改和分发时保留原版权及许可文本，并另行记录内部修改的归属。宠物美术、插件子模块及第三方依赖应单独核对权利和许可证，不能因为主仓库采用 MIT 就默认全部资产可复用。
- 内部 Git 仓库用 `origin`；保留 `upstream` remote 供只读比较，并将其 push URL 设为 `DISABLED`，防止误推公开仓库。此设置写在本地 `.git/config`，不会随 Git 克隆传播；每个新克隆都要执行 `git remote set-url --push upstream DISABLED` 并核对 `git remote -v`。升级时从经过审核的上游提交建立升级分支，审查源码、依赖锁文件、原生二进制及网络行为，通过内网测试后再合入内部主线。不要直接跟随上游 `main` 自动更新。

## 首版边界

目标是 Windows 上由 OpenCode 驱动的本地桌面宠物。内网改动将 OpenCode 插件和 MCP 客户端均强制走本机 IPC（`remote: false`），Windows discovery 文件隔离到 `%APPDATA%\OpenPets Internal\runtime\ipc.json`，避免与公开版 OpenPets 的运行实例混用。本分支保留上游内置宠物和经过审核的本地宠物包导入，关闭公开宠物/插件目录、更新检查、公告、Teams、Pet Studio 外链、云 AI/语音请求、远程控制及插件联网入口，并限制只运行审核后随安装包打包的插件。源码闸门和本机运行测试不能替代隔离测试机的出站抓包与安装包审计。

公共图库含第三方创作及同人宠物。主仓库的 MIT `LICENSE` 不能自动证明这些独立素材可以在企业内部复制或分发；首版不要直接镜像整个公开站点或图库。对每个拟引入的资源记录作者、来源、许可证/授权、哈希和审核结论。

`plugins/official/openpets.system-resources` 和 `plugins/community/regis.usage-buddy` 是 Git 子模块。内网源镜像必须固定其提交及许可证；不能让构建机在构建时去 GitHub 拉取。`get-windows` 的安装脚本会通过 `node-pre-gyp` 从 GitHub Releases 获取 Windows 原生二进制。Electron 与 electron-builder 的下载也独立于 npm registry。只配置内部 npm registry 不足以证明可离线构建。

OpenCode 1.x 与 2.x 使用不同插件入口，详见 `packages/opencode/V1_COMPAT.md`。1.x 使用 `v1-package/index.js` 或内部包 `@open-pets-internal/opencode-v1`；2.x 使用 `v2-package/index.js` 或内部包 `@open-pets-internal/opencode-v2`。推荐运行 `Install-OpenCodeIntegration.ps1` 将相应单文件包复制到项目 `.opencode/plugins/`。两个版本的 MCP 命令都应指向已部署、带齐运行时依赖的本地 CLI 绝对路径，不使用公开 `npx` 下载命令；单独复制 `packages/cli/dist/index.js` 不可运行。实际内网 OpenCode 版本仍需做事件、插件加载及 MCP 验证。

## 文档与脚本

- [Windows 构建与发布流程](BUILD-WINDOWS.md)
- `Test-WindowsBuild.ps1`：只读预检，检查源码基线、工具版本、内部镜像、缓存及原生二进制。默认失败关闭，不会安装依赖、构建、发起 HTTP 下载或修改全局配置。
- `Prepare-WindowsCodeSignCache.ps1`：用固定哈希的本地归档预置 Windows 资源编辑和签名工具缓存，避免旧工具包中的 macOS 符号链接阻断无管理员权限的构建账号；不下载或覆盖未知缓存。
- `Install-OpenCodeIntegration.ps1`：将已构建的 V1/V2 单文件插件和 MIT LICENSE 安装到指定项目，并写入指向本地 CLI 的 MCP 配置。只更新本工具以前管理且内容未改动的文件；更新前保留备份。已有未知配置时拒绝覆盖并给出手工合并片段。
- `Test-WindowsInstaller.ps1`：只读发布门槛，校验安装包的 Authenticode 签名和审批 SHA-256。不会签名、上传或发布。

上游架构入口为 `codemap.md`、`docs/architecture.md` 和相关子目录的 `codemap.md`。修改运行时行为时同步维护相应文档与测试。
