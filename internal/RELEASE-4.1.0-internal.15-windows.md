# 4.1.0-internal.15：Windows 本机适配

本次基于 `v4.1.0-internal.14`，集中处理 Windows 本机开发、测试和配置写入的故障，并改进宠物库的空结果说明。此版本作为 **Windows x64 专用预发布** 交付；macOS 仍使用 `4.1.0-internal.14`。共享源码的 macOS 原生包和 GUI 行为尚未在本次构建中验收，后续双平台发布仍按 [GITHUB-RELEASE.md](GITHUB-RELEASE.md) 的同提交规则执行。

## 变更

- Windows 应用状态、插件状态与设置、远程控制状态、IPC 发现文件、插件密文与存储、加密对话归档在短暂 `EPERM`、`EACCES`、`EBUSY` 占用时有限重试原子替换；持续失败保留旧文件及已有内存状态，并清理临时文件。
- 修正 Windows 开发命令的环境变量和路径分隔符、Claude Hook 的 shell 引号，以及无符号链接权限时测试夹具的处理。生产安全检查仍拒绝不可信链接路径。
- 控制中心显示完整 Internal 版本号。宠物库“有闲置活动”无结果时解释独立活动与普通 V1 待机手势的区别，并提供本地导入入口；筛选能力仍由已安装宠物包的声明决定。

## 本机验证

- 从 `origin/main` 的 `v4.1.0-internal.14` 基线更新，使用 Windows x64、Node `24.16.0`、pnpm `11.0.8` 完成桌面端类型检查、构建与全部 behavior/contract 测试；文档构建及 `git diff --check` 通过。
- 原生 Windows 安装包的资源合同、Electron 原生窗口模块和 Sharp 编解码加载通过。本机 GUI 读回完整版本号和八只已安装宠物，包含从 codex-pets.net 经真实本地 IPC 导入的六只样本；默认 GPT娘保持不变。
- OpenCode `2.3.0` 的项目插件与 MCP 在常驻服务中连接成功，使用 DeepSeek 的一次真实任务产生宠物完成反应及 token 速率显示。测试密钥未写入仓库或持久配置。

## 宠物素材与边界

codex-pets.net 的标准 ZIP 只有 `pet.json` 和主图集，当前下载的六只样本没有独立 `activities` 声明或图条；它们的 V1/V2 常规待机与反应动画仍可播放，但不会增加“有闲置活动”的筛选计数。网站用户上传素材只保存在本机个人宠物库，不随安装包或仓库分发。macOS 的私有本地图库也不在源码和本次 Windows 包内。

本次本机包和 GitHub 托管 Windows 工作流只能证明各自环境内的构建、导入和播放行为；未测量用户显卡/DWM 的实际屏幕帧率，也未完成同一素材的 Mac/Win 原生帧率对照。Windows 安装包未签名。
