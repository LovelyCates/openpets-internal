# 4.1.0-internal.7 大库试用与 macOS 构建记录

日期：2026-11-16。源码基础 `fb96b4f` 加本地未提交修改，macOS 15.7.9 arm64。
本版包含 `.6` 记录中尚未打包的 OpenCode 状态、V1 空闲动作和 V2 内置猫节奏修复，
以及本次批量试用所需的大库改动。Windows 和 macOS 共用这些实现与版本号；
当前没有 Windows 原生构建或实际界面观感验收结果。

## 大库行为

- 宠物页先全库搜索和筛选，再每页显示 24 张卡片；详情选择不受换页影响。
  已安装卡片读本地素材，选中的已安装宠物可单独补取目录服装元数据。
- Control Center 快照最多并行读取 8 份 manifest，按原顺序返回并隔离单项错误。
- 本地 `pets.list` 按完整 UTF-8 响应的 16 KiB 上限分页；客户端聚合完整列表，
  用 revision 检查分页期间的变更。1336 条真实 socket 合同测试通过。
- 新增/替换安装和活动计数只复用身份相同的私有已规范化旧记录；新记录、
  替换记录、启动和原有健康检查路径仍验证文件。1336 次新增只读取 1336 份
  manifest，随后 10 次活动计数不新增全库读取。JSON 写入和快照仍随库规模增长。
- 50ms 注视采样只读取所需偏好，不克隆整个宠物库。

## 素材来源和准备

用户要求在本机导入官网完整目录试用。缓存位于
`.local/pet-catalog-20261116/`，不加入 Git 或应用安装包。
官方入口 `https://openpets.dev/pets/catalog.v3.json` 的生成时间为
`2026-11-03T11:43:05.803Z`；全部 14 页共 1336 个唯一 ID，
其中 1301 个 V1、35 个 V2。原 ZIP 共 1,956,917,620 字节。

保留全部原 ZIP；`preparation.json` 记录原/准备包 SHA-256、大小、逐文件变更
和图像核对。`prepared-zips/` 中 1328 个包保持原字节，8 个生成修正副本：

- `sk-ll-and-hati`、`cinnamonroll`、`lando-2`、`cicada-2`、`awawa-hyrax-2`
  仅使 manifest ID 与目录 ID 一致，防止同名条目覆盖。
- `spyro`、`cow` 将误命名为 WebP 的 PNG 转为 exact lossless WebP；解码后的
  完整 RGBA 与原图逐字节一致。
- `terminal` 将误命名 PNG 从 1680×2048 重采样为 V1 的 1536×1872，
  再编码为 exact lossless WebP，解码像素与重采样结果逐字节一致。

准备后重新核对全部原包，确认其 SHA 和大小均未变。准备包总大小
1,954,350,077 字节。所有其他解压文件的内容均保持不变。
`sousuke-p` 本身是 18 页动画 WebP：逐页解码以限制峰值内存，记录原时序，
保留原始素材，不将动画误判为坏包。

离线校验复用真实 ZIP、metadata、Sharp 和安装资产校验；V1 WebP 额外完整
逐页解码。报告绑定 ZIP、目录条目和校验实现的哈希。导入器再次核对 ZIP
SHA/大小，使用运行中应用的本地安装 IPC 串行提交；已有 ID 跳过，逐项落盘
报告，并最终核对目标 ID、损坏状态及默认宠物。

## 已完成验证与剩余边界

客户端和 OpenCode 完整 check 通过；大库、快照、状态、注视定向回归通过，
校验器 6 项和导入器 10 项行为测试通过。四只样本已经通过打包应用的真实
IPC 安装，最终列表确认存在且无损坏，默认仍为 `builtin`。

桌面完整 check 的类型检查、生产构建通过，但整套测试仍在既有
`pet-assistant-host.test.ts` 的禁云策略与模拟 fetch 不匹配处停止；没有
放开网络策略，也不能据此声称整套测试全绿。此前 `.6` 记录解释了该限制。

## 全量应用导入结果

`validation-prepared/report.json`：1336/1336 通过，0 失败；V1 1301、V2 35。
随后启动实际 `4.1.0-internal.7` 打包应用，经 Internal Unix socket 串行安装：
新增 1332、跳过之前安装的 4 只样本、失败 0。`import/report.json` 标记
`complete: true`，最终实际列表含 1337 条（1336 个目录目标和 1 只内置猫），
全部目标存在，无 broken 条目，默认宠物前后均为 `builtin`。没有创建 lease
或把全库固定到桌面。应用已实际启动并完成安装 IPC；这不等于逐只动画观感验收。

独立只读安装核对 `installed-verification.json` 为 `ok: true`：2677 个文件、
1,960,514,332 字节通过核对，1341 份非 manifest 资源的 SHA/大小全部一致。
仅 `chotu` 和 `gpt-niang` 的 manifest 字节因既有安装器移除显式 V1 标记而变化；
从准备 ZIP 重读原 JSON 后确认全字段语义仅有该项规范化。实际版本数仍为
1301 V1、35 V2，固定列表为空。另以真实本地客户端连续读取完整 1337 条列表，
耗时 37.48ms、34.40ms、32.49ms，均唯一且无 broken 条目；该读数只代表
列表 IPC，不代表渲染帧率。详见缓存中的 `ipc-verification.json`。

## internal.7 产物

`pnpm package:desktop:mac` 已生成 `.app`、DMG 和 ZIP；打包契约、深度严格
ad-hoc 签名检查、get-windows helper 执行位/架构、打包 Electron/Sharp 探针、
DMG CRC 及 ZIP 完整性检查均通过。未做 Apple 公证。

```text
fd1daf9f39ed817af2e67dc86e98d00e24009e588f9ae4af6e72f0fa6e6b0528  OpenPets-Internal-4.1.0-internal.7-mac-arm64.dmg
5fd3868141539e3f582587e8279fd4f709380f7023d0d02f2bd517a34153cf12  OpenPets-Internal-4.1.0-internal.7-mac-arm64.zip
```

产物位于 `apps/desktop/dist-electron/`。目录宠物保存在用户 profile，素材缓存
和全部宠物不嵌入应用安装包。此次仅更改 desktop 版本号，没有改依赖或锁文件；
pnpm 11 因 workspace manifest 变化尝试自动重装并因非 TTY 停止，之后单次构建
以 `pnpm_config_verify_deps_before_run=warn` 复用既有已验证依赖，未清空或重装依赖。
