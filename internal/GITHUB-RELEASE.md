# Internal 双平台 GitHub Release

本流程面向 `LovelyCates/openpets-internal` 的联网构建与 GitHub 分发，和企业
离线构建、内网镜像及企业签名流程分别记录。不要使用指向上游仓库的
`release:desktop` 自动发布入口。

Windows x64 与 macOS arm64 从同一源码提交生成；应用版本仍由
`apps/desktop/package.json` 管理。两端共用 renderer、宠物播放协调器、导入
事务、OpenCode 事件适配器及 token 显示代码，不维护平台专用功能分支。

## 构建和验证

Windows 使用 `.github/workflows/internal-windows-release.yml` 手动构建。
该工作流仅拥有源码读取权限，生成 NSIS 安装包及校验和、验证报告和构建
记录，不自行创建或发布 Release。构建包括冻结锁文件安装、共享行为检查、
V1/V2 单文件插件重建、目标平台打包合同、打包 Electron 的原生模块冒烟，
以及从最终 NSIS 提取后的应用载荷复核和真实 GUI 播放门槛。

`validate-windows-pet-rendering.mjs` 在临时 GitHub 托管 Windows runner 上直接
启动最终 NSIS 中的 `openpets-internal.exe`，不使用 Electron Node 模式或测试
窗口替身。由于产品使用固定 Internal profile，验证器要求 Windows 原生
AppData 下该目录完全不存在；它独占创建空目录，结束后只按本次随机所有权
标记删除自己的目录，拒绝本地工作站、持久 runner 和任何既有 profile。
CDP 只绑定并核实为该进程的 `127.0.0.1` 监听器，不增加生产 IPC。

门槛先验收内置 V2 的资源解码、实际 CSS 动画时钟及自然到达两个原定待机帧后
的可见像素变化；帧位和时长从实际包的 CSS 读取，不强制动画时钟、不依赖抓到
短暂眨眼。然后通过真实
本机 IPC 导入公开合成的 V1 atlas、获取独立 lease。heartbeat 只续租，不发送
busy 状态；等待至多 35 秒，要求 V1 空闲手势出现、动画时钟继续推进，并在
分阶段宠物窗口截图中观察到像素变化。报告同时保留系统实际 reduced-motion
值及必要时仅用于该次验证的媒体模拟值；不修改 Windows 辅助功能设置。
`openpets-windows-native-rendering-<run-id>` 附件即使失败也保留 JSON、有限
启动日志及宠物窗口 PNG，不截取桌面或用户数据。rAF 采样和截图阶段分开，
不把截图促成的绘制当作无干扰帧率测量。

工作流还启用 `--with-public-yukino`：只向临时目录下载公开 catalog 的原始
Yukino ZIP，要求固定 1,139,788 字节和 SHA-256
`0021e18df93dbb4afd2215c03ef3c2a81d60fcde9340662907e816da6f441e1e`。
不提交或读取用户已安装素材。通过真实 ZIP IPC 导入后，单独观察六个 idle
列及 quiet 手势，便于和用户认可的同一素材比较。公开源超时、大小或哈希
改变时，该补充场景明确记为未验证，合成场景仍独立判定；源校验通过后的
产品播放失败则阻止发布，不能以下载失败或合成场景通过替代 Yukino 验收。

该检查证明托管 Windows 中实际产品窗口能播放，不能证明用户显卡、DPI、
DWM 屏幕呈现或安装快捷方式已验收，也不能替代同宠物跨平台实机比较。
当前用户认可的 Mac 参考为 `4.1.0-internal.12` / Electron 42，Windows 后续
版本使用的 Electron 45 必须单独记录；不要把 Mac 13 的载荷摘要当作该参考。

工作流分别检出待发布的应用提交和该次工作流提交中的摘要工具。后者位于
忽略的 `.local/release-tools`，以 `--source-root` 指向应用源码，避免发布工具
修复改变应用构建基线。报告分别记录应用与工具提交；两端应用提交必须一致。

本机中转大制品速度不足时，可用 `internal-promote-windows.yml` 将成功构建
中的已验证附件直接转入现有草稿。该手动工作流仅在转存 job 中使用 Release
写权限，校验原构建、源码、公共载荷摘要及实际安装包 SHA-256，并要求目标
Release 仍为对应提交的草稿；它不创建标签或发布 Release。本机随后读取小型
元数据逐项比对，并核对 GitHub 端安装包摘要，仍须完成相同的最终发布检查。

macOS 在目标架构主机按 [BUILD-MACOS.md](BUILD-MACOS.md) 构建、验证。
需要保留运行中的旧应用时，可将 electron-builder 的
`directories.output` 指向独立产物目录，随后对该目录执行相同的打包合同、
签名及原生运行时检查，再从已验证应用生成 DMG/ZIP。不要覆盖正在运行的
应用目录，也不要将用户 profile、已导入宠物或 `.local` 缓存加入安装包。

`record-release-payload.mjs` 为两端实际打包资源生成公共运行文件摘要，具体
参数见 `--help`。发布前核对源码提交、版本、锁文件、子模块和公共文件路径
及 SHA-256；原生二进制和平台外壳分别按各自目标检查，不以整个 ASAR 相等
作为功能一致的条件。文件摘要证明运行代码一致，不能代替两端原生交互验收。

## 上传与发布

1. 将待发布源码推至 origin，核对远端提交，再以该提交触发 Windows 构建。
   Mac 使用同一提交。工作流失败时先修复并重新构建，不沿用旧版本安装包。
2. 下载工作流验证通过的安装包，核对 SHA-256 和构建提交，与 Mac 公共载荷
   比对通过后准备完整的 `SHA256SUMS`、构建和验证记录。
3. 使用当前版本的 `v<version>` 标签和完整提交 SHA 创建草稿 Release；
   上传 Windows NSIS、Mac DMG/ZIP、校验和与记录。已有标签或 Release 时
   先核对其提交及资产，不覆盖未知内容。
4. 在草稿中核对资产名称、字节数、服务端摘要和本地 SHA-256，确认附件齐全
   后发布。发布后再次读取 Release、标签及下载链接，记录验证结果。

Release 说明须列出适用架构、安装方式、功能变化、签名状态及实际验证范围。
没有发行证书的 Windows 包注明未签名；Mac ad-hoc 签名注明未公证。预发布
版本继续以 prerelease 发布，不声称已经完成企业离线或跨平台 GUI 全量验收。

## 发布后恶意软件检测

`internal-release-malware-scan.yml` 对指定的已公开 Release 做只读检查，先核对
标签提交、服务器摘要和发布校验和，再用 Windows Defender 与 ClamAV 扫描。
Defender 在下载应用前关闭该临时 runner 的样本提交和云报告，保留实时防护；
ClamAV 使用官方签名库，检查安装包、解包应用及展开的 ASAR。只保存小型
扫描日志与结果，不上传样本、用户目录或项目数据，不修改 Release。
Defender 定义更新先用 `MicrosoftUpdateServer`，失败后使用微软官方 `MMPC`
源，最多三次，每次后台更新限时 120 秒、失败间隔 5 秒；每次结果写入报告。
成功更新后再次核对样本/云设置、引擎状态、签名版本与不超过 72 小时的新鲜度。
全部更新失败或状态校验不通过就停止扫描并记为未完成，不绕过更新使用旧定义。
参数依据[微软 Update-MpSignature 文档](https://learn.microsoft.com/en-us/powershell/module/defender/update-mpsignature?view=windowsserver2022-ps)。
ClamAV 保留超限告警，单文件上限 1 GiB、容器累计上限 16 GiB、每文件扫描
时限 600 秒；原生框架及包含它的容器触发容量告警时须重扫或明确记录缺口。
工具提交 `0efcccd` 的命令已使用 16 GiB，JSON 却仍记为 4096 MiB；保留该次
原始报告并在验证记录注明这一元数据错误，后续两种工作流的报告已与命令对齐。
引擎不可用、签名更新失败、超限或检查未完成均记为未完成，不能当作未检出。
恶意软件检测与依赖漏洞、数据访问边界审查分别评估。

遇到框架二进制签名命中时，`internal-release-malware-triage.yml` 可将已校验的
应用 PE 与官方 Electron 同版本 PE 用同一病毒库比较，并记录原始代码段摘要。
比较完成不等于无病毒结论，不执行被检查程序，也不提交样本到外部服务。
