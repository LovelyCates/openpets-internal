# Windows 内网构建与发布

## 当前状态

此流程是构建门槛设计，不是已验证的离线构建记录。`Test-WindowsBuild.ps1` 当前仅执行只读预检；通过预检也不能代替网络隔离、依赖审计、实际构建和运行时出站验证。构建机应由防火墙或 CI 网络策略限制到经过批准的内网镜像，不能依赖应用变量阻止任意依赖脚本访问公网。

上游根 `package.json` 要求 Node.js `>=20`、`pnpm@11.0.8`。构建项目需要固定工具链、`pnpm-lock.yaml`、Git 基线和子模块提交。Windows 桌面打包由 `apps/desktop/electron-builder.yml` 管理，目标为 NSIS 安装包。上游 `pnpm release:desktop` 是依赖 GitHub Actions 和 SignPath 的公开发布流程，不用于内部发布。

## 供应链准备

由有外网权限的受控环境采购、校验并镜像以下内容；将原始来源、版本、SHA-256、许可证、审核人和导入时间写入内部制品记录：

1. 锁文件中所有 npm 包与 pnpm 存储内容，以及固定版本的 Node.js、pnpm。
2. Electron 应用二进制及 electron-builder 需要的辅助二进制，例如 NSIS。二者使用各自的镜像/缓存路径，不受 npm registry 单独控制。当前 `electron-builder@26.10.0` 在 Windows 资源编辑阶段调用旧 `app-builder-bin`，它仍从 `winCodeSign-2.6.0.7z` 解压工具；归档里的 macOS 符号链接会让无符号链接权限的 Windows 构建账号失败。把这个固定 SHA-256 的归档纳入内部制品，并通过下述脚本只提取 Windows 需要的内容到已审批缓存，无需开启开发者模式或提升构建账号权限。
3. `get-windows@9.3.0` 在 Windows 上需要的 `node-get-windows.node`。其包内 `binary.host` 指向 `github.com/sindresorhus/get-windows/releases/download/`，`install` 脚本运行 `node-pre-gyp install --fallback-to-build`；本机基线安装日志已经观察到对该 GitHub Releases 地址的下载。把审核后的文件导入内网，并记录 SHA-256。不要让构建机执行原始公网下载脚本。
4. 根 `.gitmodules` 中两个 Git 子模块，固定到主仓库记录的 commit，转入内部 Git 镜像。
5. 所有宠物包、插件包和第三方素材各自的许可证及内容审核记录。公开 `openpets.dev` 目录站点不包含在当前主仓库中。

建议先用 `pnpm install --offline --frozen-lockfile --ignore-scripts` 从已审批的 pnpm store 准备依赖，再通过单独审核的步骤放置/构建原生依赖与 Electron 工具缓存。**`--offline` 只约束包管理器，不能约束生命周期脚本中的 HTTP 请求**；因此 `--ignore-scripts` 和构建机网络限制都不可省略。原生依赖放置与重建步骤尚未在本分支实现，当前不得把此建议视为完整构建命令。

## 预检变量

在构建进程环境中配置以下变量。URL 必须为 HTTPS，主机名必须逐项列入 `OPENPETS_INTERNAL_ALLOWED_HOSTS`；脚本不允许从这些变量缺失时回退到公网默认地址。允许列表使用逗号分隔的**精确主机名**，不支持通配符。不要在 URL 中嵌入凭证。

| 变量 | 含义 |
| --- | --- |
| `OPENPETS_INTERNAL_ALLOWED_HOSTS` | 已审批的内网镜像主机名列表 |
| `OPENPETS_INTERNAL_NPM_REGISTRY` | 内部 npm registry URL |
| `OPENPETS_INTERNAL_ELECTRON_MIRROR` | 内部 Electron 二进制镜像 URL，末尾带 `/` |
| `OPENPETS_INTERNAL_ELECTRON_BUILDER_BINARIES_MIRROR` | 内部 electron-builder 辅助二进制镜像 URL，末尾带 `/` |
| `OPENPETS_INTERNAL_PNPM_STORE` | 已导入并校验的 pnpm store 绝对目录 |
| `OPENPETS_INTERNAL_ELECTRON_CACHE` | 已导入的 Electron 缓存绝对目录 |
| `OPENPETS_INTERNAL_ELECTRON_BUILDER_CACHE` | 已导入的 electron-builder 缓存绝对目录 |
| `OPENPETS_INTERNAL_WIN_CODESIGN_ARCHIVE` | 已审批的 `winCodeSign-2.6.0.7z` 绝对路径；SHA-256 固定为 `cdaec7154dda7cc31f88d886e2489379a0625a737d610b5ae7f62a12f16743a4` |
| `OPENPETS_INTERNAL_GET_WINDOWS_BINARY` | 已审核的 `node-get-windows.node` 绝对路径 |
| `OPENPETS_INTERNAL_GET_WINDOWS_SHA256` | 上述原生文件的审批 SHA-256 |

同时在**当前构建进程**设置 `npm_config_registry`、`ELECTRON_MIRROR`、`ELECTRON_BUILDER_BINARIES_MIRROR` 为对应内部 URL，设置 `npm_config_store_dir`、`ELECTRON_CACHE`、`ELECTRON_BUILDER_CACHE` 为对应审批缓存目录，并设置 `npm_config_offline=true`、`npm_config_ignore_scripts=true`。预检会核对这些值及缓存目录非空。不要用 `pnpm config set`、`npm config set` 或修改用户级 `.npmrc`。这些进程变量只对当前 CI job 生效。

先查看预检要求：

```powershell
pwsh -NoProfile -File .\internal\Test-WindowsBuild.ps1 -ShowRequirements
```

在安装依赖并设置上述缓存环境变量后，先准备 Windows 工具缓存：

```powershell
pwsh -NoProfile -File .\internal\Prepare-WindowsCodeSignCache.ps1 -ArchivePath $env:OPENPETS_INTERNAL_WIN_CODESIGN_ARCHIVE
pwsh -NoProfile -File .\internal\Test-WindowsBuild.ps1
```

该脚本不下载文件；它核验归档 SHA-256，用已安装的 `7zip-bin` 排除归档中的 macOS 目录，将 Windows 工具写入 `ELECTRON_BUILDER_CACHE`，再核验资源编辑与签名工具的哈希。已有缓存且哈希匹配时直接返回；不匹配时拒绝覆盖。`package:preflight` 接受经哈希校验的工具缓存，或实际具备符号链接权限的账号。升级 `electron-builder`、`app-builder-bin` 或工具归档时，要重新核对缓存格式和固定哈希。

Windows 打包在 ASAR 完整性资源写入后，先等待 30 秒再运行 `rcedit`；本机构建验证了该等待能避开刚生成的 exe 被短暂占用导致的 `Unable to commit changes`。这不是所有企业终端防护软件的通用保证；若构建机仍报此错，应检查该机器对构建输出目录的文件占用记录并在受控环境重试。

只读构建预检还会检查 Windows、Git 基线可达、子模块处于固定提交、Node/pnpm 版本、缓存路径、原生二进制与工具归档哈希，以及已准备的工具缓存。pnpm 版本优先通过已预置缓存的 `corepack pnpm --version` 核对，并在该调用期间强制 `COREPACK_ENABLE_NETWORK=0`；缓存不存在时才检查已安装的 `pnpm`。不会为了版本检查在线下载 pnpm。失败时返回非零退出码并列出缺项。

## 构建门槛

在内部镜像、原生依赖准备流程和网络隔离均完成后，另行验证并固化以下 CI 阶段：

1. 在无公网出口的 Windows runner 上，从内部 Git 镜像检出内部版本与固定子模块；记录 commit 和工作树状态。
2. 使用内部 pnpm store 离线安装，禁止未审核的生命周期脚本；以批准的缓存/本地构建方式准备原生依赖与 Electron 工具。
3. 运行 `pnpm check`、`pnpm typecheck`、`pnpm test`，重点验证 `packages/opencode` 与桌面端的本地 IPC。运行 `pnpm --filter @open-pets/desktop package:dir` 做打包契约检查，再运行 `pnpm --filter @open-pets/desktop package` 生成 NSIS 安装包；两条命令都会先检查 Windows 工具缓存，并执行桌面构建。
4. 在隔离测试机上安装产物，验证 OpenCode 的思考、编辑、测试、等待、成功、失败事件与宠物反应；抓取网络出站记录，确保仅出现审批的内网地址或无出站请求。
5. 生成 SBOM、依赖/二进制哈希清单、测试记录、网络审计记录和构建日志。由内部签名服务签名安装包，保留签名证书链及审批 SHA-256。

第 2–3 步目前没有自动脚本：尤其要先解决 `get-windows` 安装脚本、Electron/electron-builder 缓存与发布工具链的公网默认源。不要直接运行上游的公开发布脚本作为内部发布替代品。

## 给 OpenCode 项目安装本地集成

先在受控环境构建 `packages/opencode/v1-package/index.js` 或 `v2-package/index.js` 单文件 bundle（分别运行 `pnpm --filter @open-pets/opencode build:v1` / `build:v2`），并部署带齐运行时依赖的 CLI 到稳定的本地绝对路径。`packages/cli/dist/index.js` 会导入 `@open-pets/client` 等包，**不能只复制这一个 JS 文件**；应使用经打包契约验证的桌面安装包中 `@open-pets/cli/dist/index.js` 及其依赖，或者另行制作并验证自包含 CLI。安装后先在隔离机运行 `node <CliPath> status`，再用该路径启动 `node <CliPath> mcp`，确认 MCP 握手与工具可用。对每个项目选择与实际 OpenCode 主版本一致的一种入口：

```powershell
$projectRoot = Read-Host '目标项目的绝对路径'
$cliPath = Read-Host '已部署且带齐依赖的本地 CLI index.js 绝对路径'
pwsh -NoProfile -File .\internal\Install-OpenCodeIntegration.ps1 -MajorVersion 1 -ProjectRoot $projectRoot -CliPath $cliPath
# OpenCode 2.x 项目改用 -MajorVersion 2；不要同时安装两种插件。
```

可选 `-NodePath` 指定内部批准的 `node.exe`；省略时安装器解析当前 PATH 上的 `node.exe`，并把其绝对路径写入配置。`-BundlePath` 可指定受控构建产物；省略时使用本仓库对应版本的 bundle。V1 写入 `.opencode/plugins/openpets-v1.js` 和 `.opencode/opencode.jsonc` 的 `mcp.openpets`；V2 写入 `openpets-v2.js` 和 `mcp.servers.openpets`。MCP 命令只包含本地 Node、CLI 绝对路径和 `mcp` 参数，无 `npx` 或公网包名。安装器也复制相应 MIT `LICENSE`。

已有其他 OpenCode 配置或未知 OpenPets 文件时，安装器在写入前拒绝并输出对应 MCP JSON 片段，供人工合并。重复执行同主版本安装时，仅在原安装记录及三个受管理文件的 SHA-256 都匹配时更新，并为旧文件留 `.bak-<id>` 备份；发现人工修改就拒绝覆盖。OpenCode 1.x 的内网 fork 可能改变插件 API，安装后仍需在其准确版本上验证事件和 MCP。

安装后先启动 OpenPets Internal，再从已安装插件的项目里启动 OpenCode。以下三条路径分别负责不同功能：

| 功能 | 接入路径 | 使用方式 |
| --- | --- | --- |
| 思考、编辑、运行测试、等待、成功和失败动画 | V1/V2 项目插件监听 OpenCode 事件，经本机 IPC 发送宠物反应 | 正常使用 OpenCode 即可；不要求模型调用工具 |
| 约数 `token/s` 与输出 token 数 | 同一项目插件统计流式文本增量，并读取 OpenCode 报告的输出用量；本机 IPC 只传数字和短会话标识 | 有流式输出时在宠物旁短暂显示；实时速率是字符数换算的估计值 |
| 主动让宠物说话或做动作 | 项目配置中的本地 MCP 启动 OpenPets CLI，提供 `openpets_status`、`openpets_react`、`openpets_say` | 在 OpenCode 中让模型使用相应 MCP 工具；受模型是否调用工具影响 |
| 提醒、计时、喝水提示、系统资源、虚拟宠物等 | OpenPets 桌面内置插件 SDK | 从控制中心启用所需插件；无需 OpenCode |
| 角色皮肤与动作素材 | 本地 v2 宠物包 | 在宠物库导入并设为默认；ZIP 不自带 token 统计或工具逻辑 |

如要增加上下文占用、费用或工具进度等读数，应先确认内网 OpenCode fork 实际提供的事件字段，再沿项目插件 → 本机 IPC → 桌面显示的链路增加数值字段。费用还需要经内部批准的模型价格表；不应从皮肤 ZIP 推断运行数据。

## 发布验证

签名后，用独立审批渠道提供签名证书 SHA-1 thumbprint 和安装包 SHA-256，再运行：

```powershell
$env:OPENPETS_INTERNAL_SIGNER_THUMBPRINT = '<审批的证书 thumbprint>'
$env:OPENPETS_INTERNAL_RELEASE_SHA256 = '<审批的安装包 SHA-256>'
pwsh -NoProfile -File .\internal\Test-WindowsInstaller.ps1 -Installer 'C:\internal-artifacts\OpenPets-Internal-setup.exe'
```

脚本仅验证签名和哈希，不调用签名服务，不上传制品。发布权限、内部制品库地址和签名服务接入由企业环境单独配置。
