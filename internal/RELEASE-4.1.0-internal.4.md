# OpenPets Internal 4.1.0-internal.4 本机构建记录

## 变更

- 修复旧版宠物包导入：`pet.json` 中显式数值 `"spriteVersionNumber": 1` 按 V1 图集处理，导入时规范化为字段缺省。其他非法版本标记仍被拒绝，图集尺寸与内容仍按原有规则校验。

## 本机验证

- 桌面端 TypeScript 类型检查、Windows x64 安装包构建及打包契约检查通过。
- 使用正在运行的 4.1.0-internal.4 桌面程序，经 CLI 和本地 IPC 实际导入 `G:\BaiduNetdiskDownload\chrome\20260922\gpt-niang.zip`；安装后的 `pet.json` 不再包含 V1 版本标记，应用状态报告版本为 `4.1.0-internal.4`。
- 完整 `pet-format` 测试套件受到 Windows 创建符号链接时的 `EPERM` 错误阻断；`install-pet` 测试套件受到测试环境 `HOME` 路径不匹配阻断。因此不能据此宣称这两个完整套件通过。

## 构建产物

文件：`apps/desktop/dist-electron-internal-4/OpenPets-Internal-4.1.0-internal.4-win-x64-setup.exe`

SHA-256：`261D04A5C37EE8ABB6F846397105E65D7369D391E8CA907D8853FC12310F7B36`

该本机安装包的 Authenticode 状态是 `NotSigned`。
