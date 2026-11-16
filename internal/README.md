# OpenPets 内网维护基线

本目录记录内网版本的来源、构建入口和发布门槛。当前源码包含 Windows 本地运行基线和 macOS 内网适配、OpenCode 1.x/2.x 插件入口及项目安装脚本；内网依赖镜像、离线安装包构建、企业签名与实际 OpenCode 分支验收仍需在目标环境完成。

## 来源与维护方式

- 上游：<https://github.com/OpenPetsHQ/openpets>。
- 固定基线：`163c80281c5c2739776773e4993516471bfd71cf`（2026-11-13 的上游提交）。当前 `internal/main` 从该提交建立。上游的 `v4.1.0` 标签是另一提交；不能用标签代替此基线 SHA。
- 许可证：仓库根目录 `LICENSE` 为 MIT，版权为 `Copyright (c) 2026 OpenPets`。内部修改和分发时保留原版权及许可文本，并另行记录内部修改的归属。宠物美术、插件子模块及第三方依赖应单独核对权利和许可证，不能因为主仓库采用 MIT 就默认全部资产可复用。
- 内部 Git 仓库用 `origin`；保留 `upstream` remote 供只读比较，并将其 push URL 设为 `DISABLED`，防止误推公开仓库。此设置写在本地 `.git/config`，不会随 Git 克隆传播；每个新克隆都要执行 `git remote set-url --push upstream DISABLED` 并核对 `git remote -v`。升级时从经过审核的上游提交建立升级分支，审查源码、依赖锁文件、原生二进制及网络行为，通过内网测试后再合入内部主线。不要直接跟随上游 `main` 自动更新。

## 首版边界

目标是 Windows 和 macOS 上由 OpenCode 驱动的本地桌面宠物。内网改动将 OpenCode 插件和 MCP 客户端均强制走本机 IPC（`remote: false`），Windows discovery 文件隔离到 `%APPDATA%\OpenPets Internal\runtime\ipc.json`，macOS 对应 `~/Library/Application Support/OpenPets Internal/runtime/ipc.json`，避免与公开版 OpenPets 的运行实例混用。macOS 使用 Unix socket 并忽略桌面端旧 TCP 环境变量。本分支保留上游内置宠物和经过审核的本地宠物包导入，关闭公开宠物/插件目录、更新检查、公告、Teams、Pet Studio 外链、云 AI/语音请求、远程控制及插件联网入口，并限制只运行审核后随安装包打包的插件。源码闸门和本机运行测试不能替代隔离测试机的出站抓包与安装包审计。

公共图库含第三方创作及同人宠物。主仓库的 MIT `LICENSE` 不能自动证明这些独立素材可以在企业内部复制或分发；首版不要直接镜像整个公开站点或图库。对每个拟引入的资源记录作者、来源、许可证/授权、哈希和审核结论。

`plugins/official/openpets.system-resources` 和 `plugins/community/regis.usage-buddy` 是 Git 子模块。内网源镜像必须固定其提交及许可证；不能让构建机在构建时去 GitHub 拉取。`get-windows` 的安装脚本会通过 `node-pre-gyp` 从 GitHub Releases 获取 Windows 原生二进制。Electron 与 electron-builder 的下载也独立于 npm registry。只配置内部 npm registry 不足以证明可离线构建。

OpenCode 1.x 与 2.x 使用不同插件入口，详见 `packages/opencode/V1_COMPAT.md`。1.x 使用 `v1-package/index.js` 或内部包 `@open-pets-internal/opencode-v1`；2.x 使用 `v2-package/index.js` 或内部包 `@open-pets-internal/opencode-v2`。推荐运行 `Install-OpenCodeIntegration.ps1` 将相应单文件包复制到项目 `.opencode/plugins/`。两个版本的 MCP 命令都应指向已部署、带齐运行时依赖的本地 CLI 绝对路径，不使用公开 `npx` 下载命令；单独复制 `packages/cli/dist/index.js` 不可运行。实际内网 OpenCode 版本仍需做事件、插件加载及 MCP 验证。

## 文档与脚本

- [Windows 构建与发布流程](BUILD-WINDOWS.md)
- [macOS 构建与本地集成](BUILD-MACOS.md)
- [4.1.0-internal.6 macOS arm64 本机构建记录](RELEASE-4.1.0-internal.6-macos.md)
- [4.1.0-internal.7 大库试用与 macOS 构建记录](RELEASE-4.1.0-internal.7-macos.md)
- [4.1.0-internal.8 OpenCode 脚下常驻状态条](RELEASE-4.1.0-internal.8-macos.md)
- [4.1.0-internal.9 实时 tk/s、AVG 与分级配色](RELEASE-4.1.0-internal.9-macos.md)
- [4.1.0-internal.10 V1 动作节奏与大库刷新开销](RELEASE-4.1.0-internal.10-macos.md)
- [4.1.0-internal.11 V1 事件重播与交互反馈](RELEASE-4.1.0-internal.11-macos.md)
- [4.1.0-internal.12 完整图库、双来源 ZIP 与统一动作节奏](RELEASE-4.1.0-internal.12-macos.md)
- [1301 只 V1 全量复核与 8 只实机抽测](VERIFY-V1-PETS-macos.md)
- [OpenCode 1.2.27 独立项目状态与 token/s 验证](VERIFY-OPENCODE-1.2.27-macos.md)
- [内网插件目录与维护](PLUGIN-MAINTENANCE.md)
- [4.1.0-internal.5 本机构建记录](RELEASE-4.1.0-internal.5.md)
- [4.1.0-internal.4 本机构建记录](RELEASE-4.1.0-internal.4.md)
- `Test-WindowsBuild.ps1`：只读预检，检查源码基线、工具版本、内部镜像、缓存及原生二进制。默认失败关闭，不会安装依赖、构建、发起 HTTP 下载或修改全局配置。
- `Prepare-WindowsCodeSignCache.ps1`：用固定哈希的本地归档预置 Windows 资源编辑和签名工具缓存，避免旧工具包中的 macOS 符号链接阻断无管理员权限的构建账号；不下载或覆盖未知缓存。
- `Install-OpenCodeIntegration.ps1`：将已构建的 V1/V2 单文件插件和 MIT LICENSE 安装到指定项目，并写入指向本地 CLI 的 MCP 配置。只更新本工具以前管理且内容未改动的文件；更新前保留备份。已有未知配置时拒绝覆盖并给出手工合并片段。
- `install-opencode-integration.mjs`：macOS 可用的 Node 本地安装入口，保留 V1/V2 配置、SHA-256 安装记录、备份与拒绝覆盖规则。
- `build-macos.mjs`：本机构建、验证并生成内部 macOS `.app`、DMG、ZIP 和校验和，不执行公开发布。
- `validate-macos-runtime.mjs`：验证打包后 macOS 窗口 helper 的架构/执行位，并在打包 Electron 的 Node 模式下加载运行时和验证 Sharp 图像处理。
- `validate-pet-catalog.mjs`：离线复用真实 ZIP、metadata 和桌面资产校验；V1 WebP 额外逐页完整解码，记录页数与时序。按整包及校验实现哈希恢复，输出逐项结果、失败清单和可导入 manifest，不修改素材或应用状态。
- `import-pet-catalog.mjs`：消费离线 validator 的完整通过清单，再核验 ZIP 整包哈希和大小，通过运行中应用的本地 IPC 串行导入。既有 ID（包括自定义和损坏条目）跳过；逐项写入 checkpoint 与结果报告，结束后重新列库核对，不直接写应用 state、不创建 lease、不修改默认或固定宠物。用法：`node internal/import-pet-catalog.mjs --ready-manifest ABS --zip-dir ABS --report-dir ABS [--limit N]`；报告目录须独立于 validator 输出，重跑同一命令按应用当前已安装 ID 恢复。`--limit` 仅核对样本范围是否完成，同时保留全目录缺失 ID。客户端遵循 `OPENPETS_DISCOVERY_FILE`；未设置时本分支 macOS/Windows 默认连接 Internal profile，执行前应确保目标应用与 discovery 匹配。
- `Test-WindowsInstaller.ps1`：只读发布门槛，校验安装包的 Authenticode 签名和审批 SHA-256。不会签名、上传或发布。

上游架构入口为 `codemap.md`、`docs/architecture.md` 和相关子目录的 `codemap.md`。修改运行时行为时同步维护相应文档与测试。
