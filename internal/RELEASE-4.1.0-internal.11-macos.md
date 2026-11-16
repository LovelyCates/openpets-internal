# 4.1.0-internal.11：V1 事件重播与交互反馈

2026-11-17。继续处理 V1 宠物动作反馈不连贯的问题。Windows 与 macOS
修改相同 owner，不增加平台分叉；本轮原生应用验证在 macOS arm64 进行。

## 对照边界

用户要求把同一只 V1 与 Codex 原生宠物实际比较。电脑控制工具拒绝操作
`com.openai.codex`，因此未通过电脑控制操作原生应用，也未将替代窗口当作
原生浮窗。用户已手动调出原生宠物。随后通过受支持的 Pets 连接器选择
达妮娅 V1，读回 `active_pet_id`，并只读核对桌面配置
`desktop.selected-avatar-id` 指向同一个 ID，确认素材选择。
没有手工写入原生配置或宠物目录。

原生逐帧窗口录像仍受电脑控制限制；不能把源码比较、选择项读回或 OpenPets
工程测试写成已完成双端帧率/呈现观感验收。

本机官方内置九只宠物均为 `8×11` 的 V2；图库中同名 Rocky V1 与官方
Rocky 像素不相同，不能凭名称声称是同素材。实际选用云端自定义
`pet_6abbfc98b7fc81918349f17cc910662f`（达妮娅 / Denia），原始 PNG
`1536×1872`、8×9 V1，SHA-256 为
`a7fbf41991297fdc7de6bb793d8ff5735e42d0197a524d079498127b5e9946d6`。
OpenPets 的 `denia-codex-v1` 通过既有本地安装 IPC 导入无损 WebP 规范包，
尺寸/帧顺序不变，全部可见像素 RGBA 差异为零；仅全透明像素的隐藏 RGB
经编码归零。不能声称两个编码文件 SHA 相同。原始资源和逐像素报告位于
`.local/comparison-20261117/native-denia/`。

已只读核实的原生行为：浮窗和聊天内宠物共用逐格时序，idle 均为 6600ms；
浮窗非 idle 默认三轮后进入慢 idle，聊天内则持续循环。浮窗另有悬停 jumping
反馈及按拖动方向切换的跑动。未发现常态外层持续 breathing/bob 动画。

本轮不改变 OpenCode 工作状态持续播放的语义，也不把较长静止姿态当成
渲染掉帧。素材、像素缩放、状态事件和实际帧间隔分别核对。

## 已确认的问题

`.10` 的真实默认窗口使用 GPT娘 V1，以公共 IPC 在约 0.5、1.45、2.4 秒
三次触发 success。124 张窗口截图中，row 4 / col 4 在 capture
`2033–4135ms` 连续出现；第三次事件确认于约 2447ms，之后仍未观测到新一轮
播放。这证实新的有限动作没有可见重播，不能只凭请求被接受判断播放正确。
第二次事件接近正常循环边界，截图采样不能唯一判定它是否重置了时钟。

主进程原先仅对单次横向位移达到 3px 发跑步状态，每次事件都会重置位置。
因此每次 1–2px 的缓慢横移和纯竖向拖动可能没有动作反馈。新版累计真实位移，
越过阈值后更新方向；竖移沿用最近朝向。同位置重复 move/moved 不重复发状态，
也不延长停止时间，180ms 无新位移后进入 idle；重载及关闭清理监听与 timer。

原始素材 SHA、录像及帧分析见 `.local/comparison-20261117/`。原速截图录像
只反映采样到的姿态和状态，不代表系统 compositor 的真实呈现帧率。

## 修改

- 真正的新有限动作事件分配新 ID；协调器只重播一次对应 CSS 动画。
  重复快照、tk/s/HUD 更新不重置进度，循环动作也不被重置。使用现有
  Web Animations 时钟；V2 已结束且无 fill 的动画有严格限定的重建路径。
  精灵和内容节点继续复用，不重新加载整个窗口。
- V1 空闲时首次进入可见宠物区域可触发 jumping，复用现有待机动作计时器。
  首次命中后按完整帧范围锁定，避免动画中的透明像素变化导致反复触发。
  离开仅取消悬停来源的动作；忙碌、拖动、移动、暂停、减少动态效果等
  情况仍由既有优先级处理。
- 窗口移动按累计位移判断，补足慢速横移、纯竖向移动的跑动反馈。
  Windows/macOS 均由 `pet-window-motion.ts` 和共同 body owner 处理。

## 验证结果

- 桌面 typecheck、主进程/renderer/preload 构建通过。完整 desktop check
  仍在既有 `pet-assistant-host.test.ts` 的闭云策略断言失败：预期 completed、
  实际 failed；本轮未放宽策略或修改该断言。不能声称全套检查通过。
- 另跑 34 个受影响测试文件，34/34 通过，覆盖状态、事件、内容保留、
  Motion 隔离、移动、IPC 和 token 更新。移动 owner 的 6 项行为检查通过。
- 独立的真实 Chromium 生产 owner/preload 检查中，V1 和 V2 各 15/15 通过；
  包含已结束和播放中重复事件、有限 override、HUD 不重播、节点身份不变。
  这些是工程检查，不是原生 Codex 窗口对照。
- 真实打包应用 `.10`/`.11` 使用同一 GPT娘 V1 和相同窗口缩放，在第三次
  success 后相同的 1680ms 区间各采样 26 张图：旧版仅 1 个末尾姿态、
  0 次姿态变化；新版出现全部 5 个姿态、9 次变化，观察到完整循环重播。
  原始截图、IPC 时间戳和分析在 `actual-openpets-repeat-comparison.*`。
- 独立 OpenCode 1.2.27 项目使用本地确定性模型，经实际 V1 插件、MCP、
  打包 CLI 和本地 IPC 验证：GPT娘和达妮娅各 15/15 通过。覆盖生成、编辑、
  测试、权限等待及恢复、成功、失败保持、实时估算 tk/s、最终 AVG 保留。
  没有调用外部模型，也没有修改全局 OpenCode 配置。
- 达妮娅实际会话录屏为 35 秒、447 张原始窗口截图；图像独立确认 idle、
  review、jumping、waiting 和 failed 的可见动作。短暂 working/editing
  未被此片段采样到，不能由截图单独断言该状态呈现成功或失败。
- macOS arm64 打包合同、应用签名验证、内置 Sharp 实际编解码、原生模块
  导入、DMG 校验和 ZIP 完整性检查通过。应用已启动，当前默认宠物为
  `denia-codex-v1`。使用临时签名，未做公证；Windows 原生包/GUI 本轮未验。

悬停的单元检查覆盖进入、离开、透明像素变化、自然待机动作共存和各中断。
最初 middle-click 会主动取消待机动作，scroll 也未证明发送了 mousemove，
这两段不能记为悬停成功。后续 CUA 从待机气泡拖入宠物（鼠标按下发生在
气泡、没有在精灵上按下）实际观察到跳到泡泡的动作；这是有效的移动进入
路径检查，仍不等同于无按键的自然悬停验收。原始证据保存在
`denia-hover-bubble/`，先前尝试独立保留。

## 产物

`apps/desktop/dist-electron/`：

| 文件 | SHA-256 |
| --- | --- |
| `OpenPets-Internal-4.1.0-internal.11-mac-arm64.dmg` | `bb9591301543e7955ed9e1df6b60c54afcd49411e5a918da8c129a67e7824063` |
| `OpenPets-Internal-4.1.0-internal.11-mac-arm64.zip` | `1d8436c1ba632869df3998db2b803b21fa096c55892abf67c2f738c49a1ce45c` |

录屏和机器可读报告集中在 `.local/comparison-20261117/`。视频以原始截图时间
导出，不补中间动作；30fps 容器只重复采样图，不代表原生渲染达到 30/60fps。

- `media-export/openpets-denia-opencode-live.mp4`：达妮娅真实 OpenCode 会话，
  34.9 秒、680×904；顶部标签不遮挡脚下 tk/s/AVG。
- `media-export/openpets-10-vs-11-repeat-success.mp4`：GPT娘重复 success 的
  OpenPets `.10`/`.11` 并排对比，7.93 秒、1360×904。按各自 IPC probe
  起点对齐共同时间段；没有原生 Codex 录像。
- 两片均经 ffprobe 和 ffmpeg 全解码验证，无音轨。媒体哈希、源时间范围、
  实际截图采样率及可重现导出脚本见 `media-export/*media-report.json`。

## 仍存在的节奏差异

原生 Codex 浮窗的非 idle 动作通常三轮后回到慢待机；OpenPets 的 OpenCode
忙碌动作当前持续循环，文字和 tk/s 独立反映会话。是否采用三轮后慢待机的
视觉策略已询问用户，本轮保持现有连续工作播放。原生窗口的实际显示大小、
帧间隔和并排观感仍未采集，不能据此宣布已经达到 Codex 原生流畅度。
