# V1 宠物全量与实机验证

2026-11-16，实际应用 `4.1.0-internal.9`，macOS arm64。这里的 V1 指网站的
Classic 8×9 宠物，不是 OpenCode 插件的 API 版本。

## 结论与范围

- **1301/1301** 已安装 V1 的资源、metadata、帧布局与当前运行时模块契约通过。
  原始包、准备包和安装文件重新核对，没有本轮损坏、缺失、空白使用格或状态越界。
- **8 只代表宠物**完成实际窗口抽测，覆盖非像素、细高、宽体、低色、重复帧、
  PNG/尺寸修复样本、近满格和多页 animated WebP。不是 1301 只逐只人工观感验收。
- GPT娘使用真实 OpenCode 1.2.27＋本地模拟模型，**14 项联动检查通过**；
  另外七只通过真实公共 IPC、显式 lease 和实际 Electron 窗口检查全部反应。
- 本轮没有修改应用源码或素材，没有重新导入、下载或改全局 OpenCode 配置。
  桌面保留 V1 `gpt-niang`（GPT娘）供用户直接试用；临时 lease 窗口已关闭。
  CPU 插件验收后恢复关闭，原有 Medium 宠物与 Small HUD 尺寸未改变。

## 全量资源与运行时

当前库 1337 只含 1301 V1、35 V2 和内置宠物。V1 全部只有 `pet.json` 与主图集，
本批次没有额外 V1 衣橱或活动图集漏检。

重新哈希 1301 个原始 ZIP、1301 个准备 ZIP、2602 个安装文件；安装资源
约 1.86GB。仅两个已知旧 manifest 的显式 V1 标记规范化按先前字节记录和语义
核对，其余文件与预期一致。现有完整解码结论复用前，重新核对 ZIP、atlas 及
117 项 validator/Sharp/Vips 实现哈希。该部分复用 1318 页完整解码记录；本轮
帧丰富度分析另对全部 1301 atlas 的首 page 进行了真实 RGBA 解码。

实际项目 owner 的全量计算包含：

- 23,418 次动画帧边界、28,622 次 reaction 路由检查。
- 44,234 条实际生成 CSS 规则解析；1301 次实际 coordinator 假时钟 idle/取消检查。
- 78,060 组 pet/HUD 缩放与 CPU/token 组合几何检查。

这些是源码模块级检查，必要环境使用明确记录的 mock，不代替实机截图。
全部 V1 都使用 `1536×1872` 图集、`8×9` 网格、`192×208` 单格。

详细记录在 `.local/opencode-binding-20261116/v1-validation-20261116/`：
`summary.json`、`installed-v1-recheck.json`、`runtime-contract-report.json`、
`frame-richness-report.json` 及各自可复现 harness。

## 实机抽测与录像

| 宠物 | 覆盖点 | 原速录像 |
| --- | --- | --- |
| GPT娘 / `gpt-niang` | 非像素、自然动作、实际 OpenCode | [待机 35 秒](../.local/opencode-binding-20261116/v1-validation-20261116/gpt-niang/idle-natural.mp4)；[实际联动](../.local/opencode-binding-20261116/v1-validation-20261116/gpt-niang/opencode-live.mp4) |
| Chotu / `chotu` | 细高体形 | [完整反应](../.local/opencode-binding-20261116/v1-validation-20261116/chotu/native-states.mp4) |
| Spyro / `spyro` | HD 像素、源格式修复 | [完整反应](../.local/opencode-binding-20261116/v1-validation-20261116/spyro/native-states.mp4) |
| Terminal / `terminal` | 宽体、源尺寸修复 | [完整反应](../.local/opencode-binding-20261116/v1-validation-20261116/terminal/native-states.mp4) |
| Mariglow / `mariglow` | 低色像素、透明留白 | [完整反应](../.local/opencode-binding-20261116/v1-validation-20261116/mariglow/native-states.mp4) |
| Open Pets Codex / `open-pets-codex` | 多状态重复、等待单帧 | [完整反应](../.local/opencode-binding-20261116/v1-validation-20261116/open-pets-codex/native-states.mp4) |
| Sousuke-P / `sousuke-p` | 18 页 animated WebP | [35 秒窗口](../.local/opencode-binding-20261116/v1-validation-20261116/sousuke-p/native-states.mp4) |
| Wheelboss / `wheelboss` | 近满格、复杂装置边缘 | [完整反应](../.local/opencode-binding-20261116/v1-validation-20261116/wheelboss/native-states.mp4) |

七只受控样本覆盖 84 阶段、2343 帧。截取的真实窗口画面逐帧对实际 atlas
模板匹配，再人工抽图核对，均与期望状态兼容；六只每阶段有独特行证据。
Open Pets Codex 原素材多行相同，不能凭画面唯一反推行，也不能声称每个状态
视觉都不同。未发现代表样本的明显空白、错误行、装置边缘裁切或状态条遮住身体。

GPT娘自然待机录像在约 `1.308–2.940s`、`19.355–21.012s` 完整进入 jumping
语义行后回 idle；该角色表现为手部和姿态变化，并非大幅离地。约 34.948s
出现挥手开头，录制随即结束，未把它计为完整挥手周期。

实际 OpenCode 报告为 `live-MdM8TK/report.json`，确认读写、测试、审批/恢复、
成功/错误、实时 tk/s、AVG 和最终输出量。实际 editing 只持续约 59ms，原录屏
没有捕到对应行；`editing-controlled.jpg` 是另行受控补核的正确 row 7，不能
冒充捕获了真实编辑瞬间。完整视觉分析见 `visual-validation-summary.json`。

9 段 MP4 全部通过完整解码，8 张 `preview.jpg` 是原截图的字节复制。录像
采集约 **10.76–13.94fps**；30fps 容器仅保持原帧、原速，无插值、无音轨，
不能用于测量原生动画帧率或证明 60fps 流畅度。七只受控样本的 usage 数值是
合成界面样本；GPT娘段使用真实 OpenCode 事件和本地模拟模型，均不代表付费
模型性能。每段 SHA、时间对齐、采样率和解码记录见 `media-index.json`。

## 已确认的素材差异

首 page 的逐像素丰富度分析，对透明像素的不可见 RGB 归零后再比较。全部
使用格均有可见内容，但画面丰富度不同：

| 状态 | 首图集仅 1 个不同帧 | 首图集最多 2 个不同帧 |
| --- | ---: | ---: |
| idle | 18 | 47 |
| waiting | 62 | 170 |
| running | 11 | 45 |

50 只存在跨状态相同帧序列，61 只存在相同姿态集；917 只的全部 57 个使用格
均不同。帧数少不等于包损坏，帧多也不能证明动作质量或帧率更高。

- `gus-sitting` 全部状态合计只有一个姿态，本质上近似静图。
- `open-pets-codex` 共 12 个姿态，idle 两帧、waiting 一帧；等待时画面静止
  来自原素材，而非状态接入失效。
- `chotu` 与 `gpt-niang` 各有 57 个不同使用姿态，更适合作为 V1 生动性样本。
- `sousuke-p` 有 18 页、每页 30 秒；丰富度表只分析第一页，不能据此断言其
  整体 idle 静止。实机 35 秒录像也未遍历完整九分钟循环。
- Mariglow、Open Pets Codex 的源帧底部透明留白较多。当前条对齐整格，而非
  每只素材的可见脚点，所以它们的实体脚距比 Chotu/Spyro 更大。

## 边界与待复核项

普通 Medium 宠物＋Small HUD 下，GPT娘与 CPU/RAM/GPU/Disk、tk/s、AVG 共存
截图正常，记录为 `gpt-niang/cpu-normal-size.jpg`。

模块计算指出共同的极端组合：宠物 Huge `1.25`＋HUD Huge `2`＋CPU＋AVG
时，固定载体内的原始 sprite frame 顶部为 `-2px`。有透明边的美术未必可见
裁切，不能把它直接写成 1301 只视觉失败。本轮设置页缩放控件的自动操作
未成功展开，未改变原有尺寸值，因此这组极端尺寸仍需单独 GUI 确认。

本轮实机仅 Mac；Windows 使用相同模块，但没有新增 Windows 原生观感证据。
未对 1301 只逐个进行人工或完整动画周期观感验收。
