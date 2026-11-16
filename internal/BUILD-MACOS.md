# macOS 内网版构建与本地使用

本分支沿用上游的 Electron macOS 窗口、菜单栏和宠物动画实现。内网版使用
独立的 `dev.openpets.internal` 应用标识和 `OpenPets Internal` 用户目录，
关闭公开目录、更新、云服务和远程控制。macOS 的桌面端与 OpenCode 通过
本机 Unix socket 通信，不需要监听 TCP 端口。

## 构建

在对应架构的 Mac 上准备 Node.js、项目固定版本的 pnpm，以及锁文件对应的
依赖。工作区允许 Electron 的安装脚本准备 Mac 运行时；Electron 下载遵循
`ELECTRON_MIRROR` / `ELECTRON_CACHE`，离线环境应使用审核后的缓存并显式
禁用未准备的生命周期下载。Apple Silicon 使用 arm64，Intel 使用 x64；不要复制 Windows 的
`node_modules` 或原生二进制。企业离线构建需要预置 npm 依赖、Electron、
electron-builder 工具缓存和两个固定提交的 Git 子模块。以下安装命令用于
已配置依赖源的构建环境：

```sh
git submodule update --init --recursive
pnpm install --frozen-lockfile
pnpm --filter @open-pets/client check
pnpm --filter @open-pets/opencode check
pnpm --filter @open-pets/desktop check
node --test internal/install-opencode-integration.test.mjs
pnpm package:desktop:mac
```

`package:desktop:mac` 只在本机构建、验证和打包，不执行公开发布流程。
脚本按顺序构建桌面端和 V1/V2 插件，生成 `.app`，检查完整运行时、插件、
资源和 ad-hoc 签名，确认窗口检测 helper 的架构和执行位，并用打包后的
Electron 验证 Sharp 图像编码，再从已验证的 `.app` 生成 DMG、ZIP 与 SHA-256 文件。
最终文件还会经过 DMG 镜像校验和 ZIP 完整性检查。
只需要应用目录时运行 `pnpm package:desktop:mac --dir`。
`--arch arm64` / `--arch x64` 必须与构建机 Node 进程架构匹配；Intel 产物需
在 Intel Mac 上另行构建验收。

输出位于 `apps/desktop/dist-electron/`：

- Apple Silicon：`mac-arm64/OpenPets Internal.app`。
- Intel：`mac/OpenPets Internal.app`。
- 安装镜像和压缩包：`OpenPets-Internal-<version>-mac-<arch>.dmg` / `.zip`。
- 校验和：`SHA256SUMS.mac-<arch>.txt`。

`identity: "-"` 生成本地 ad-hoc 签名，不能视为 Apple Developer ID 签名或
公证。向其他 Mac 分发前应按组织要求签名、公证并重新记录校验和。
现有 `release:desktop` 是上游公开多平台发布入口，内网版不要使用它。

## 启动与权限

打开 DMG，将 `OpenPets Internal.app` 拖入“应用程序”，再启动应用。
首次启动使用内置宠物；从菜单栏图标打开控制中心。

用户数据位于 `~/Library/Application Support/OpenPets Internal/`，本地 IPC
发现文件位于其中的 `runtime/ipc.json`。桌面端忽略旧的
`OPENPETS_DISCOVERY_FILE`、`OPENPETS_IPC_BIND` 和 `OPENPETS_IPC_ENDPOINT`
环境变量，以免与公版实例混用或启用 TCP。客户端默认使用同一 Internal
发现文件，并拒绝 macOS TCP discovery。

如需识别和跟随其他应用窗口，macOS 可能要求“屏幕与系统音频录制”权限；
切换到其他终端窗口可能要求“辅助功能”权限。权限被拒绝时应仍可打开控制中心
并使用普通桌面宠物。普通 OpenCode 本机 IPC 不需要开放防火墙端口。

## 安装 OpenCode 1.x / 2.x 本地集成

Node 安装器可以在 macOS 上运行，无须 PowerShell。先选择与实际 OpenCode
版本一致的 `--major-version`。以下示例使用安装到“应用程序”的完整运行时，
请将项目路径替换为自己的路径，并保留含空格路径的引号：

```sh
node internal/install-opencode-integration.mjs \
  --major-version 1 \
  --project-root '/absolute/path/to/your/project' \
  --cli-path '/Applications/OpenPets Internal.app/Contents/Resources/app.asar.unpacked/node_modules/@open-pets/cli/dist/index.js'
```

OpenCode 2.x 将参数改为 `--major-version 2`。可用 `--node-path` 指定已部署的
本地 Node 实体绝对路径；默认使用运行安装器的 Node。单文件插件默认来自本仓库
`packages/opencode/v1-package/` 或 `v2-package/`，也可用 `--bundle-path`
指定审核后的 bundle，其旁必须保留 `LICENSE`。

安装器复制插件和许可证到项目 `.opencode/plugins/`，写入本地 Node + CLI
的 MCP 命令，不使用 `npx`。它只更新安装记录中未被修改的文件，并保留备份；
已有未知配置、手工修改或符号链接时会拒绝覆盖，并提示人工合并。
不应同时安装 V1/V2 两个适配器。安装后重启 OpenCode。

## 运行验收

大库试用使用共同的 `internal/validate-pet-catalog.mjs` 和
`internal/import-pet-catalog.mjs`。先验证本地 ZIP，再向运行中的 Internal 应用
串行导入，最后核对完整列表。参数和恢复规则见 [README.md](README.md)，
本次 1336 只的素材修正、哈希和执行范围见
[internal.7 记录](RELEASE-4.1.0-internal.7-macos.md)。
两端还应检查超过一页的本地库：搜索页外宠物、翻页、保持详情选择、关闭
控制中心后响应 OpenCode；无需同时创建整个库的宠物窗口。

Windows 与 macOS 使用同一套 OpenCode 事件、V1 空闲动作和渲染代码，
从同一源码基线构建。Mac 构建脚本会同时重建 V1/V2 单文件插件；Windows
流程也须更新两份 bundle。`packages/opencode` 的 `check` 和桌面行为测试
覆盖快速状态切换、失败重试、旧事件保护、空闲调度及动画连续性。

启动打包后的应用，确认菜单栏、控制中心、内置宠物和动画均正常，并检查
Internal 目录下的发现文件指向本机 Unix socket。通过精确版本的 OpenCode
检查提示、编辑、测试、权限请求、完成和失败事件，以及 `openpets_status`、
`openpets_react`、`openpets_say`。关闭桌宠后 OpenCode 应仍正常工作。
Token/s 徽标按本地文本长度估算，实际供应商 token 总量可用时另行显示。

在 10 秒内执行“思考 → 编辑/测试 → 思考”往返，确认新状态不被旧排队
事件覆盖。使用网站 V1 宠物安静等待至少 30 秒，检查短挥手/短跳、开始
任务立即打断、暂停与减少动态效果、同宠物多窗口节奏，以及连续状态/HUD
更新不反复重置当前动作。Windows 执行同样的行为验收。

对内置 Hoodie Cat V2 及其服装，检查闭眼为短眨眼、耳动短暂，持续移动鼠标
时每次注视后会恢复呼吸；在朝向边界和宠物附近轻晃鼠标不应来回抖动。
注视结束应接续当前空闲动画相位。暂停、系统减少动态效果、拖动和工作状态
都应及时停止注视。导入的其他 V1/V2 图集仍使用各自原有的统一行时序。

源码与本机冒烟检查不能代替目标企业环境的安装、离线出站验证和实际
OpenCode 分支验收。构建或测试记录应注明架构、提交、产物哈希和验证范围。
