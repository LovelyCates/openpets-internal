# OpenPets Internal 4.1.0-internal.5 本机构建记录

## 变更

- 控制中心移除「团队」入口和页面；旧的 `teams` 路由归一到仪表盘。内网策略下不初始化团队与经理签到服务，也不注册它们的控制中心 IPC。
- 「集成」页只显示 OpenCode，移除其他集成卡片和 VS Code 预告卡，并更新九种语言的页面说明。控制中心 IPC 仅接受 OpenCode 安装/移除和 OpenCode、Node.js 命令路径修改。其他集成的底层源码仍保留，便于以后有计划地恢复。
- 补充 System Resources 插件的使用说明，澄清它显示本机 CPU 等指标，当前包尚无 OpenCode token/s 宠物插件。

## 本机验证

- 桌面端类型检查、控制中心路由与集成 IPC 测试、Windows x64 安装包构建及打包契约检查通过。
- 运行 `4.1.0-internal.5` 的桌面程序，CLI 状态确认版本、GPT娘默认宠物与宠物窗口；控制中心实际显示六个导航入口，集成页仅有 OpenCode 卡片。

## 构建产物

文件：`apps/desktop/dist-electron-internal-5-final/OpenPets-Internal-4.1.0-internal.5-win-x64-setup.exe`

SHA-256：`C56D4D60F9CD20CFA8FF43C602FF9F350F63681C5F7C5CB3A6F23635D3ACB2F8`

该本机安装包的 Authenticode 状态是 `NotSigned`。
