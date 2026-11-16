# 4.1.0-internal.10：V1 动作节奏与大库刷新开销

2026-11-17。针对 V1 宠物动作生硬、状态刷新迟缓的反馈，修改共同的动画和
状态读取模块；Windows 与 macOS 共用实现。本机原生验收范围为 macOS arm64。

## 本轮修复

V1 不再把一行动作平均分配给每一格。每格使用独立停留时间，保留动作末尾的
收势和眨眼停顿；慢速待机一轮为 6600ms。等待时长偏好按比例缩放各格，有限
动作结束保持最后一个有效姿态，避免在归入下一状态前回闪首格。V2 内置猫的
既有专属待机、视线与暂停行为保持原配置。

时序来源是本机 `/Applications/ChatGPT.app`（bundle ID `com.openai.codex`）
`26.1023.51421`（build 22530）宠物 renderer 的
行为核对：idle 基础帧时长为 `[280,110,110,140,140,320]`、运行时统一乘六；
running 为 `[120,120,120,120,120,220]`，review 为
`[150,150,150,150,150,280]`，waiting 为 `[150,150,150,150,150,260]`。
仅独立重实现帧停留数据与行为，没有复制或分发应用 bundle 代码。

宠物窗口只读取一份小型渲染偏好和当前宠物记录，避免为一个偏好反复克隆
整个已安装库。活动计数只规范化活动字段，不重新校验未改变的宠物库，也不
返回无人使用的完整状态副本；持久化仍使用同步临时文件加原子替换，启动和
安装时的素材健康检查保持执行。

OpenCode 权限等待结束后，原先只发 reaction，宿主有意保留上一条显式正文，
导致 “Approval needed” 在恢复测试后再次续期。现在仅在当前会话有效的
waiting→resume 转换时，通过既有 say 通道发送中性的继续处理短语，并携带
真实恢复状态。该次替换独立于普通 thinking 文案冷却，重复、外部会话和终态
回复不重复触发；它不宣称权限一定获准，也不清除其他插件的独立气泡槽。
替换意图归属当前活动，跨紧随的流/工具事件和慢租约等待保留，成功发送后
才消耗；新等待、终止、切换活动或清理会取消，旧回执不会清掉新意图。

## 验证口径

此前 `.9` 的全量资源与实机抽测见 [V1 验证记录](VERIFY-V1-PETS-macos.md)。
该记录确认资源、状态和布局正确，录屏采样率约 11–14fps，不能证明原生
播放流畅度。本轮另外区分渲染回调间隔、实际姿态停留时间和主进程刷新开销。

原始 `.9` HTML 与打包 preload 已在修改前冻结。性能与时序数值保存在
`.local/performance-20261117/`，工程测试使用独立临时 profile，不写用户
profile、不开放调试端口。受控测试不能替代用户机器所有负载下的观感。

同一套 Node 源码基准、同一份 1301 条目录元数据与真实临时同步写盘：

| 路径 | 修改前中位 | 修改后中位 | 完整状态克隆 |
| --- | ---: | ---: | ---: |
| 一次 V1 界面准备 | 26.69ms | 0.312ms | 每次 9 → 0 |
| 一次活动计数提交 | 8.92ms | 4.77ms | 每次 1 → 0 |

两轮活动计数的 30 次写盘字节数相同，均为 23,549,583B。该基准证明主进程
准备和复制开销降低，不是 native FPS 测量。数字更新本身原来已经走轻量 IPC，
不是整库重绘；本轮没有把它虚报成新优化。

全部 1301 V1 的新配置复验通过，包含 23,418 组帧边界、28,622 组反应路由、
44,234 条生成 CSS 规则、200,354 个逐帧停留/端点检查、1301 组自动待机
取消流程和 78,060 组几何组合。素材字节未改动，完整解码与哈希结论沿用
此前资源验证；极端 Huge 宠物＋Huge HUD＋CPU＋AVG 的原始格顶端 `-2px`
几何警告仍保留，不能据此声称可见裁切已经修复或 GUI 验证过。

## 实际渲染采样

使用实际 `.9` Chotu V1 窗口文档与当前源码完整生成的同配置文档，在
Electron 42 的透明可见 `340×420` 窗口中做前后对照。生产 sandboxed preload
一致；保持原生可见窗口的默认节流，没有强制目标 FPS。每段 40 秒，依次
idle、review、running、waiting，tk/s 每秒 4 次、同身份 content 每秒 1 次。

| 样本 | rAF 中位 | rAF 95 分位 | 最大间隔 |
| --- | ---: | ---: | ---: |
| 修改前，载入后立即开始 | 16.7ms | 18.4ms | 50.8ms |
| 修改前，暖机 5 秒 | 16.7ms | 18.3ms | 18.8ms |
| 修改后，载入后立即开始 | 16.7ms | 18.6ms | 50.9ms |
| 修改后，暖机 5 秒 | 16.7ms | 18.6ms | 18.7ms |

四段均确认 39/39 content 提交、160 次 token 更新、无 preload error，stage、
hitbox、shell、sprite 身份均未替换。暖机样本未出现大于 33ms 的 rAF 间隔。
修改后暖机段期间另有一次短 Node 模块复验，报告保留该并行负载注解。
两段真实 Chromium 有限终点检查也通过：挥手超过 1400ms 后仍在 col 3、
row 3，`fill-mode: forwards`，原 sprite 保持连接。

这里没有证据表明修改前持续掉帧或修改后渲染 FPS 提高。变化是姿态停留
节奏和主进程准备耗时：原 idle 每格约 917ms，新 idle 包含 660ms–1920ms
的不同停留，整体更接近参考播放器节奏，不能把较长停顿解释为 rAF 卡顿。
rAF 也不等于系统 compositor 真正呈现；素材本身的姿态数量仍然有限。

最初工程 harness 把语义 `working` 当作 universal `running` 发送，导致
十次提交被正确拒绝。该 pilot 原始记录保留，未用作有效 A/B。它还包含一次
无法归因的早期 3.816s rAF 间隔，后续四段未复现；未删除异常或宣称原因已
解决。独立 rAF-only 控制段中 observer 回调平均约 0.006ms，带 CSS 采样段
约 0.10–0.12ms，表明采样自身有开销。完整记录见 `renderer-summary.json`、
各 cold/warm JSON 和目录 README。

## 工程检查

pet-format 的 6 项动画回归、Settings 预览与 CSS 行为检查通过；新偏好
一致性回归在旧 renderer 实现上确实失败，在修改后通过。桌面类型检查、
生产构建、文档构建通过。完整桌面 check 仍停在此前已有的
`pet-assistant-host.test.ts`：内网禁云策略使模拟请求返回 `failed`，而用例
期望 `completed`。没有放开策略，不能宣称全量测试通过。

另行完成 30 个相关测试文件，全部通过，覆盖状态持久化和引用隔离、异步
偏好一致性、默认宠物、transient、Classic body、content 保留、Settings、
CSS、gaze、几何、Motion 状态/快照/预览、活动调度、tk/s 和 IPC 转发。
日志与逐文件结果见性能目录 `affected-tests.json` 和 `affected-tests.log`。
审批恢复正文与并发回归随后通过完整 OpenCode check：foundation、真实本机
socket 插件、V1 adapter、token rate、realtime 五套检查均通过。没有修改
桌面消息合并、插件气泡槽或公开协议。

## 打包应用与 OpenCode 实机复核

实际 `.10` 应用与 OpenCode 1.2.27、V1 插件、本地确定性模型完成 15 项检查：
MCP、状态、编辑、测试、权限等待/恢复、成功/错误、实时 tk/s、AVG、最终
输出量及恢复正文替换均通过。最终记录为 `live-eeAAY6/report.json`，并复制到
性能目录 `gpt-niang-final/live-report.json`。实机 `resumed-testing.jpg` 同时
显示“测试中”和中性正文“Thinking it through”，已替换旧的“Approval needed”。
没有调用外部模型或修改全局 OpenCode 配置。
原独立试用项目的托管插件和本地 MCP 配置也已由安装器更新。

当前桌面运行 `.10` 的 GPT娘 V1，原 Medium 宠物、Small HUD 与 CPU 关闭
偏好保留。真实窗口录屏为
[35 秒实际联动](../.local/performance-20261117/gpt-niang-final/opencode-live-after.mp4)，
529 张原始截图，采集约 15.09fps；原速导出、无插值、无音轨，完整解码通过。
视频的 30fps 容器只保持原截图时序，不能作为 60Hz 呈现的证据。
`gpt-niang-after/` 保留补正文修复之前的工程录屏，不是最终交付录像。
最终 `app.asar` SHA-256 为
`16233b2d26f25bb68e9b081827284fb3eef85d5dab2a5e512aecbe1ab0a7dfe0`。

`.app`、DMG、ZIP 的打包契约、严格深度 ad-hoc 签名、打包 Electron/Sharp、
get-windows helper、DMG 校验与 ZIP 完整性检查通过。没有 Apple 公证。
本轮未在 Windows 主机打包或做原生 GUI 验收。

| 文件 | SHA-256 |
| --- | --- |
| `OpenPets-Internal-4.1.0-internal.10-mac-arm64.dmg` | `d3f3e51192e08c66b10e027f0df5b4f2adfc4d8d39ffed2ce0da059256f39b5c` |
| `OpenPets-Internal-4.1.0-internal.10-mac-arm64.zip` | `ce36069bbcab26f66c977f5ca644752bd04d06ea338d6c4788f23174a6f58b99` |
