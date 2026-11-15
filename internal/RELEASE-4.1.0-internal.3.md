# OpenPets Internal 4.1.0-internal.3 本机构建记录

## 变更

- 控制中心的「浏览」页离线展示随应用打包的插件，并提供进入「已安装」的入口；内置插件不显示远程安装、更新、评分或公网发布链接。
- 随包插件由 7 个增加到 11 个：新增 Water Reminder、Mood Check-in、Morning & Evening Routine、Magic 8-Ball；这 4 个默认停用。
- 插件初始化完成后刷新控制中心列表，避免启动初期仅显示部分插件。

## 本机验证

- 桌面端 TypeScript 类型检查、主进程与渲染器构建通过。
- 内部插件目录专项测试与 4 个新增插件的独立测试通过。
- Windows x64 安装包构建和 `check-packaging-contract --output` 通过；打包契约确认 11 个允许的插件均存在，排除的插件未进入安装包。
- 从本机构建目录启动后，本机状态记录显示 11 个随包插件、5 个启用。此记录不是隔离测试机上的网络出站验收。

## 构建产物

文件：`apps/desktop/dist-electron-internal-3-final/OpenPets-Internal-4.1.0-internal.3-win-x64-setup.exe`

SHA-256：`A892CE5359D11EF4BFD856C8BF29C1E7833E4C7A5DAFA6B262C1D1DF55B427F0`

该本机安装包的 Authenticode 状态是 `NotSigned`。转入企业环境前，仍需按 `BUILD-WINDOWS.md` 在隔离构建机复现、进行出站审计并由内部签名服务签名。
