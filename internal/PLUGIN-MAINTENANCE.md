# 内网插件目录与维护

## 当前工作方式

控制中心的「插件市场 → 浏览」只列出随当前安装包交付的已审核官方插件；「已安装」读取本机插件状态，可启用、停用和配置这些插件。列表与详情来自本地安装包，不请求公网。插件更新随新的 OpenPets Internal 安装包发布，并保留用户已有的启用状态和配置。

`apps/desktop/src/bundled-plugins.ts` 是内网允许打包的插件 ID 清单，`apps/desktop/electron-builder.yml` 将对应目录复制进安装包。启动时 `plugin-service.ts` 校验并复制这些目录到独立的用户数据目录。运行时只允许该清单中的随包插件执行。公开插件市场、远程 ZIP 安装和未经审核的本地插件均保持关闭；设置 `OPENPETS_MARKETPLACE_API_URL` 或移除启动脚本中的目录开关不会建立内网插件仓库。

当前随包的 11 个插件：Quick Reminders、Simple Timer、Focus Buddy、Launch Buddy、Daily Fortune Cookie、Virtual Pet、System Resources、Water Reminder、Mood Check-in、Morning & Evening Routine、Magic 8-Ball。前五个默认启用，其余默认停用，用户可以在「已安装」中自行启用。Calendar Airmail 依赖 Google API，Anxiety Aid Tools 依赖公网音频资源，未纳入内网安装包。

要在宠物旁显示本机资源，在控制中心「市场 → 已安装」启用 **System Resources**，再右键宠物执行「显示资源 HUD」。该仪表显示 CPU、内存，以及主机可提供时的 GPU、磁盘；网络速率属于网络吞吐量，不是模型 token/s。这个插件只读取本机指标，不需伴随进程或联网。当前包没有 OpenCode token/s 宠物插件；宠物皮肤只提供动画与外观，OpenCode 集成只传递工作状态。若需要 token/s 贴在宠物旁，需另行实现并审核 OpenCode 用量事件到本地宠物 HUD 的桥接。

## 增加或升级插件

1. 在受控源码仓库中新增或更新 `plugins/official/<插件 ID>/`。逐项审核源码、声明的权限、外部资源、许可证和素材来源；保留审查记录和文件哈希。内网版本不接受 `network` 权限、外部链接或运行时下载。
2. 验证 `openpets.plugin.json` 的 ID、版本、SDK、入口文件、配置与本地化文件；运行该插件自带的测试及 `pnpm plugins:test`。
3. 将 ID 加到 `apps/desktop/src/bundled-plugins.ts`，并在 `apps/desktop/electron-builder.yml` 的 `extraResources` 中加入同一目录。需要默认启用时，再评估并修改 `plugin-service.ts` 中的 `bundledEnabledByDefault`；普通新增插件默认停用。
4. 更新 `docs/official-plugins.md`、内部版本号与发布记录。运行 `pnpm --filter @open-pets/desktop typecheck`、桌面端测试、`package:dir` 和打包契约检查，确认安装包中实际包含每个已批准插件，且不含排除的插件。
5. 按 [Windows 构建与发布流程](BUILD-WINDOWS.md) 在隔离构建机生成、审计、签名并发布安装包。在隔离测试机检查插件显示、启停、命令与配置，以及实际网络出站记录。

如果以后需要由管理员上传插件、审核版本并让客户端从内网仓库安装，需要单独实现内网清单与制品服务、批准的 ID/版本/哈希校验，以及精确的内网地址放行。当前本地目录不能解释为已经具备该能力。
