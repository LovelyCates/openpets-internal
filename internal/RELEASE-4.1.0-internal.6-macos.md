# 4.1.0-internal.6 macOS arm64 本机构建记录

后续共享源码、实际应用导入及新版产物见
[4.1.0-internal.7 记录](RELEASE-4.1.0-internal.7-macos.md)。本文件保留首轮包的历史校验和。

日期：2026-11-16。源码基础为 `fb96b4f`，加上本地未提交的 macOS 适配修改。
本记录只覆盖本机 arm64 构建，不代表 Intel、Apple 公证、企业离线分发或实际
OpenCode 定制分支的完整验收。

此包是首轮 Mac 适配基线。用户后续反馈的 OpenCode 实时响应与网站 V1 宠物
自然动作已在本地共享源码修复；代码验证单列于文末，尚未包含在本记录对应
的安装包中。

## 环境与产物

- macOS 15.7.9（24G830），Apple Silicon arm64。
- 构建 Node 26.4.0、pnpm 11.25.0，锁文件未改；仓库声明 pnpm 11.0.8。
- Electron 42.0.0；打包 Electron 的 Node 为 24.15.0。
- 应用：`apps/desktop/dist-electron/mac-arm64/OpenPets Internal.app`。
- DMG：`apps/desktop/dist-electron/OpenPets-Internal-4.1.0-internal.6-mac-arm64.dmg`。
- ZIP：`apps/desktop/dist-electron/OpenPets-Internal-4.1.0-internal.6-mac-arm64.zip`。
- 校验和：同目录 `SHA256SUMS.mac-arm64.txt`。

```text
5f5349b252d9db795e1312f04d48606be21a1dfbaf8bdbf6396dad37139142bb  OpenPets-Internal-4.1.0-internal.6-mac-arm64.dmg
184ce548042a2a589e4544fbefa3dba9be439d55f4e195f402e5853a9b74c571  OpenPets-Internal-4.1.0-internal.6-mac-arm64.zip
```

## 已完成的验证

- `pnpm --filter @open-pets/client --filter @open-pets/opencode check` 通过，
  含本地协议、OpenCode V1/V2、事件映射和 token 速率用例。
- 桌面端类型检查和生产构建通过。
- 桌面端 Internal IPC 路径、禁公网策略、本地 IPC 协议、token 徽标生命周期
  和九种语言的插件目录文案检查通过。
- 打包 fixture 的通用及 DEB 断言通过；当前 Mac 未安装 RPM 工具，明确跳过
  RPM fixture，Linux 仍强制执行。
- Node 安装器 26 项测试通过，包括 V1/V2、空格路径、管理文件更新/备份、
  手工修改与未知配置保护、符号链接保护。
- `pnpm docs:build` 通过。
- `pnpm package:desktop:mac` 成功生成本机 `.app`、DMG 和 ZIP；重建并保留
  两份与新 Internal discovery 路径一致的 OpenCode 单文件 bundle。
- 打包契约检查通过：renderer、预加载、官方插件、MCP/CLI/OpenCode 运行时、
  Sharp、本机命令入口、目录与符号链接检查。
- `codesign --verify --deep --strict` 通过。使用 ad-hoc 签名，未做 Apple 公证。
- Mac 窗口 helper 执行位和 universal `x86_64 + arm64` 架构检查通过；
  由打包 Electron 安全导入 `get-windows` 并使用 Sharp 0.34.5 编码/解码
  1×1 PNG 成功。未调用窗口枚举 API。
- 最终 DMG 的 `hdiutil verify`、ZIP 的 `unzip -tq` 和 SHA-256 回读验证通过。

依赖准备时 Electron 的 Node 解压步骤未完成。已核对下载 ZIP 的 SHA-256 与
Electron 包内 checksums 一致，再使用系统 `ditto` 完整解压到本地依赖目录。
后续打包器自己的解压、包校验和打包 Electron 探针均成功。

## 未完成与既有测试限制

完整 `pnpm --filter @open-pets/desktop check` 未全绿：
`pet-assistant-host.test.ts` 期望模拟助手请求 `completed`，实际被既有内网
禁云策略拒绝为 `failed`。`provider-transport.ts` 的原有闸门在 fetch 前拒绝
请求，测试只替换 fetch、未传现有的测试专用网络许可。相关助手运行时和
该测试均未在本轮修改，未为通过测试放开网络策略。测试执行在此用例停止，
不能据此声称后续整套测试均通过。

尝试界面验收时 Mac 锁屏，自动解锁未成功。已请求用户手动解锁；当前尚未
确认打包应用的正常桌面启动、控制中心、可见宠物动画及真实 OpenCode 项目
事件。安装与后续验收步骤见 [BUILD-MACOS.md](BUILD-MACOS.md)。

## 后续共享源码修复（未重新打包）

按用户要求先验证代码，暂缓锁屏后的界面验收。Windows 与 macOS 使用同一
实现，并已在 `AGENTS.md` 和两端构建说明中写明同步维护要求。

- OpenCode 不再按每种 reaction 共用十秒磁盘节流；快速“思考 → 编辑/测试
  → 思考”立即切换，连续同状态只去重十秒，成功发送后才记账。
- 工具 call ID 跟踪支持并行完成；最后一个工具完成恢复思考，某工具失败
  后仍保持其他工具的工作状态。最新待发送状态取代旧排队状态，明确会话
  之间的流、完成事件和 token 数值互不覆盖。
- 活跃执行使用可清理的五秒本地保活，连续状态十秒刷新，避免静默长工具
  超过十五秒租约或两分钟忙碌徽标寿命后丢失状态。终态和退出停止保活。
- 网站 V1 宠物安静空闲约十五至三十秒后短暂挥手或跳跃，同宠物多窗口共享
  节奏。真实工作、交互、插件覆盖、暂停、减少动态效果、换装和销毁打断。
- 同素材 presentation 更新保留连接中的精灵节点与动画相位；真正动作切换
  使用独立动画名称，换素材仍先解码再原子替换。

桌面类型检查和生产构建通过。完整桌面检查仍在上文同一个既有助手测试处
停止；其前面的活动调度检查通过。随后单独执行 body、stage、CSS、Motion、
transient 和 Internal IPC 策略等十五个测试文件，七十七项全通过；本地集成
安装器二十六项测试通过。

OpenCode 的虚拟时钟测试覆盖一百三十五秒静默工具、租约续期、终态清理、
并行工具一错一运行、V1 增长快照及会话隔离。另将旧 `HEAD` runtime 临时
置入隔离探针，快速状态往返、失败重试、工具结束恢复、迟到 token 更新四项
均在旧代码失败、当前代码通过；探针结束后已还原并清理临时文件。

最后版本的 `pnpm --filter @open-pets/client --filter @open-pets/opencode check`
通过，含真实本机 socket 协议检查及 OpenCode foundation、插件、V1、token
和实时状态检查。`pnpm docs:build` 与 `git diff --check` 通过。

本轮没有重新生成 Mac 安装包，也未在 Windows 原生宿主或真实 OpenCode
界面上验收。这里的代码测试结果不能视为新版安装包的运行验收。

## V2 猫的动作节奏（本地源码，未重新打包）

用户进一步指出整体生动性不足及猫 V2 的卡顿观感。逐格检查仓库内置蓝色
连帽猫的六套外观后，确认原六帧等时 idle 会让闭眼格停约 917ms；持续鼠标
注视又通过 `animation:none` 关闭 idle，并在退出时从首帧重新开始。方向与
死区边界没有滞回，轻微鼠标抖动也会触发全身姿态来回切换。这些是已确认的
播放时序机制，尚未通过真实桌面测量证明存在渲染掉帧。

共享源码已调整：

- 仅为内置猫及其全部服装接入非均匀 5.5 秒节奏，闭眼 110ms、耳动 240ms；
  其他导入的 V1/V2 素材保持原时序，没有新增或改写美术。
- V2 注视只覆盖可见帧位置，保留 idle 动画时钟；退出后恢复当前相位。
- 注视最多约 900ms，随后留 1.6 秒呼吸间隔；共享采样为 50ms，仅在可用
  窗口运行。三像素有意义移动、四度角度滞回及死区进入/退出边界防止抖动。
- 系统减少动态效果立即取消注视；导航后等待新 renderer 通过现有 sender、
  ready 和 epoch 校验报告 motion preference。忙碌、拖动、插件与活动覆盖、
  隐藏和销毁保留原有停止与清理规则。

`pnpm --filter @open-pets/desktop check` 的类型检查和生产构建通过，整套测试
仍在前述既有助手测试停止。随后重新编译测试，并单跑 gaze、图集/CSS、stage、
body、Motion 活动、alpha hit-test、scale 和活动调度等十三个文件，91 项全过。
新 gaze 行为测试还用旧 controller 对照，能捕获持续定格、微动触发和方向
抖动。文档构建通过；尚未做实际界面观感验收或新版 Win/Mac 原生包验证。
