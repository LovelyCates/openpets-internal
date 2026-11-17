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
以及从最终 NSIS 提取后的应用载荷复核。

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
