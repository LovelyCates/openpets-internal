# 4.1.0-internal.8：OpenCode 脚下常驻状态条

2026-11-16，macOS arm64。Windows 与 macOS 使用相同的数据、渲染和布局代码；
本次安装包与实际界面验收仅在 Mac 完成。

## 用户可见变化

- 首次收到 OpenCode 数值后，在宠物脚下显示轻量半透明细条，宽度和缩放与
  系统资源 HUD 一致。实时速率使用绿色小点；本轮总数使用蓝点；空闲转为
  灰点，并显示明确标为“上次”的真实输出量，或“待机”。
- 估算速率仍在停更五秒后失效，当前总数仍保持最多八秒；空闲历史只存在
  本次应用运行的内存中，不把陈旧速率冒充实时读数，也不宣称会话在线。
- CPU/RAM 等系统资源卡片位于细条上方，留六像素间距。关闭 CPU 时，细条
  单独贴近脚部。气泡、聊天、Classic/Motion、注视锚点与 Linux shape 共用
  布局偏移；练习界面隐藏细条并恢复休息位置。
- 数字更新只改现有 DOM；首次出现或清除面板才刷新布局，保留精灵动画时钟。
  每个目标的历史有界，显式宠物租约仍按原规则关闭，历史不会把窗口永久留住。

## 验证

类型检查、生产构建、preload 语法与文档构建通过。定向的 token 生命周期、
Classic/Motion 布局、Linux shape、注视、内容连续性、聊天几何与 IPC 行为检查
通过。缩放 `.85 / 1.1 / 2` 下单独细条的脚部间距与 CPU 组合均有行为回归覆盖。

真实 OpenCode 1.2.27、本地模拟模型和打包桌面应用再次完成 12 项联动检查：
`.local/opencode-binding-20261116/live-i8jCUq/report.json` 为 `ok: true`。
用系统资源插件的实际 CPU/RAM/GPU/Disk 面板验收共存布局；检查后恢复其原有
关闭状态。没有改全局 OpenCode 配置或调用付费模型。

界面文件在 `.local/opencode-binding-20261116/recording-token-dock-20261116/`：
`idle-with-cpu.jpg` 为实际共存截图，`openpets-token-cpu-demo.mp4` 为约 45 秒
原速窗口录像，采集约 13fps，适合验证反馈与布局，不能衡量原生动画帧率。
MP4 完整解码通过。单独细条的间距随后根据实际截图进一步收紧，CPU 组合
布局保持录像中的位置。

桌面完整 check 仍在此前已有的 `pet-assistant-host.test.ts` 处失败：内网
禁云策略拒绝了该测试的模拟 fetch，期望 `completed`、实际 `failed`。未放开
网络策略，不能据此声称全量测试通过。

## 构建

本地构建入口仍是 `pnpm package:desktop:mac`，输出到
`apps/desktop/dist-electron/`。本版同时打包本轮最新的 OpenCode V1/V2 bundle。
`.app`、DMG、ZIP 通过打包契约、深度严格 ad-hoc 签名、打包运行时探针、DMG
校验与 ZIP 完整性检查；没有 Apple 公证。最终 SHA-256 记录在同目录
`SHA256SUMS.mac-arm64.txt`。
