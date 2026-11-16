# 4.1.0-internal.9：实时 tk/s 与 AVG

2026-11-16。Windows 与 macOS 共用本轮数据、协议和渲染改动；实际安装包、
界面和 OpenCode 联动验收在 macOS arm64 完成。

## 显示

- 去掉状态卡的 OpenCode 品牌文字和状态点，改为“实时 / AVG”两列。
  两列单位均为 `tk/s`，数值使用等宽字体，卡片保持与 CPU HUD 同宽。
- 每列独立着色：`>40` 绿色、`20<值≤40` 蓝色、`0≤值≤20` 灰色；
  未知值显示中性的 `— tk/s`。速度配色不表示成功或错误。
- 当前读数过期后，实时栏显示横线，平均值标为“上次 AVG”。报告缺少
  可用 AVG 时清掉旧段平均值，不用历史值或零补齐。输出总量保留在可访问描述。
- 两列卡片高度由共同几何常量驱动，猫咪、CPU、气泡、聊天、注视及 Linux
  点击/可见区域同步腾出空间。数字刷新保持既有精灵节点和动画时钟。

## AVG 口径

AVG 是当前观察到的输出段累计字符数除以四，再除以该段首个和最近一个
有效 delta 的实际秒数，至少观察一秒才显示。它不是滚动速率的算术平均，
不包括末个 delta 到 usage report 到达之间的等待，也不表示整场多工具会话的
平均速度。即使最终数量由提供方报告，AVG 仍标 `≈`。

最终报告可以保留已采样 AVG；重复报告在短期内沿用该段结果。新的输出段、
会话切换和清空重置采样。历史消息、没有流式采样的 usage、缺失或不完整的
时序均不能产生 AVG。客户端和本地 IPC 对可选平均值执行有限数值 `0..10000`
验证，清空事件不允许携带平均值；旧版无 AVG 的 payload 形状保持兼容。

## 已完成检查

客户端和 OpenCode 完整 check、桌面类型检查与生产构建通过。26 项定向检查
包含本地协议、转发、颜色阈值、AVG 历史、几何、动画连续性和视线行为。
OpenCode 的不规则采样、冻结平均、新段重置、V1 历史基线和失败后清空均通过。

实际 OpenCode 1.2.27、V1 插件、本地模拟模型与打包应用完成 14 项联动检查：
`.local/opencode-binding-20261116/live-UbXx5B/report.json` 为 `ok: true`。
在原有状态、编辑、测试、审批、错误和 token 数量检查之外，确认实际流式
事件产生 AVG，最终 reported payload 保留 AVG。

独立试用项目 `.local/opencode-binding-20261116/project` 已通过安装器更新
V1 bundle 和管理哈希，两项绑定自检通过；重启该项目的 OpenCode 后加载。
没有修改全局配置或调用付费模型。

实际界面缓存位于
`.local/opencode-binding-20261116/recording-avg-dock-20261116/`：

- `boundary-40-blue-40.1-green.jpg` 和 `mixed-fast-green-average-slow-gray.jpg`
  使用受控合成速率验证配色，不是模型性能测试。
- `live-real-session.jpg` 来自真实 OpenCode 事件链和本地模拟模型。
- `idle-average-with-cpu.jpg`、`idle-average-final.jpg` 验证上次 AVG 与 CPU
  共存、单独显示；验收后恢复系统资源插件原有的关闭状态。
- `tks-average-live-demo.mp4` 记录约 30 秒窗口原速画面，采集约 12.5fps；
  仅适合验证布局和状态，不代表原生动画帧率。

桌面完整测试仍在此前已有的 `pet-assistant-host.test.ts` 处停止：内网禁云
策略与模拟 fetch 不匹配，期望 `completed`、实际 `failed`。没有放开策略，
不能声称全量测试通过。

## 产物

`pnpm package:desktop:mac` 生成 `.app`、DMG 和 ZIP，包含最新 V1/V2 bundle。
打包契约、严格深度 ad-hoc 签名、打包 Electron/Sharp 与 get-windows 探针、
DMG 校验和 ZIP 完整性检查通过。没有 Apple 公证。
最终校验值在 `apps/desktop/dist-electron/SHA256SUMS.mac-arm64.txt`。
