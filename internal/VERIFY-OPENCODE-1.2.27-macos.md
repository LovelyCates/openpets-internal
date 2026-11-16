# OpenCode 1.2.27 本地绑定验证

2026-11-16，在 macOS arm64 上用实际 Homebrew OpenCode 1.2.27 和运行中的
OpenPets Internal 4.1.0-internal.7 验证。用户选择仅使用独立测试项目；没有
改全局 OpenCode 配置，没有调用用户的付费模型，也未启用 CPU 插件。

## 绑定方式

本机 1.x 必须装 V1 单文件入口。安装器将本地 bundle、许可证及 MCP 配置写入
项目 `.opencode/`，自动状态/token/s 来自插件，MCP 则提供主动宠物工具。
不能以 MCP connected 代替事件链验证。Mac/Windows 使用相同的适配器与运行时。

已准备可供用户启动的独立项目：

```sh
opencode '/Users/xmdy/Project/开发/openpets-internal/.local/opencode-binding-20261116/project'
```

该项目含与最新构建一致的 `.opencode/plugins/openpets-v1.js`、本地 MCP
命令及安装哈希记录。模型配置继承用户正常的 OpenCode 环境；没有将临时
模拟模型的地址或密钥写入此项目。保持 OpenPets Internal 运行，重新启动
OpenCode 让它加载插件。可让模型修改 `hello.txt` 并执行 `node --test smoke.test.cjs`。

## 真实验证范围

`.local/opencode-binding-20261116/live-smoke.mjs` 启动实际 OpenCode `serve`，
使用独立 XDG 数据、配置、缓存和状态目录，以及只监听 loopback 的模拟模型。
禁用模型目录抓取、自动更新、默认插件、外部技能、LSP 下载和文件监听。
模拟模型产生真实的 OpenCode 流事件、编辑/测试工具调用、审批请求及 HTTP 400
错误。临时本地 Unix socket 代理将插件请求转给实际桌面进程，报告仅保留
派生数值、reaction 和接收/显示结果，不写 IPC token、提示词或工具参数。
测试结束停止服务并删除临时 discovery token 文件。

最终报告：`.local/opencode-binding-20261116/live-sHtJAT/report.json`，
`ok: true`，12 项检查全通过：

- 实际 OpenCode 返回 OpenPets MCP `connected`。
- 流式会话：`thinking → success`，出现正值估算 token/s，最终数量为模拟模型
  报告的 84 tokens；所有数值都被真实桌面端接收。
- 实际读写和测试：`thinking → editing → thinking → testing → waiting →
  testing → thinking → success`。文件确实从 `before` 改为 `after`，本地测试通过。
- 错误会话：`thinking → error`，后续 idle 不再覆盖为 success，迟到的 0 tokens
  报告也不再复活徽标。
- 所有实际宠物 reaction 的桌面返回均为 `shown: true`；所有请求被接收。

上述是实际 CLI、插件和桌面 IPC 的验证，模拟模型速率不代表用户真实模型的
性能。没有逐帧截图验收。Windows 原生 CLI/桌面组合尚未实测。

## 本次发现并修复

1. 1.2.27 权限服务发布 `permission.asked`，不调用旧的 `permission.ask` hook。
   V1 适配器现在同时支持实际事件和旧 hook，并保留 session 作用域，只转发
   所需权限名；自身 OpenPets MCP 请求不会触发反馈循环。
2. `permission.replied` 现在让当前等待中的会话恢复到已跟踪工具的工作状态；
   缺失/外部 session、重复回复及完成后的回复不改变宠物。
3. 同回合失败锁定终态，拒绝紧随的 idle/success 与迟到 usage。显式新回合可以
   恢复；外部会话失败不清当前会话，终态历史有界。在途报告完成后会清掉错误徽标。

失败和回复行为在真实 CLI 修复前分别被复现于 `live-Y0giLD`、`live-Aj4p0M`。
新增窄回归对旧代码会失败。客户端/OpenCode 的完整类型、构建和检查通过，
V1/V2 两份单文件 bundle 均已重建。桌面 `.7` 安装包未在本轮重打包；本轮
自动反馈修复部署在独立项目的新版插件中。

## token/s 与 CPU

token/s 是桌面原生徽标，没有独立开关或插件安装步骤。连续流输出约一秒后
显示 `≈N.N token/s`（字符数换算的估算速率）；最终输出数量取自 OpenCode
报告并短暂保留，默认八秒后清除。CPU 插件不会提供这个数值。

本机 System Resources 2.2.0 已内置但未启用，可从“控制中心 → 插件 → 已安装
→ 系统资源 / System Resources → 启用”打开；默认显示 CPU/HUD，每十秒刷新。
它与 token/s 徽标可以同时显示。Usage Buddy 则是 Claude/Codex 额度监控，
本内网版没有打包，不能将其当作 OpenCode 的速率插件。

精确版本来源：
[V1.2.27 权限服务](https://github.com/anomalyco/opencode/blob/v1.2.27/packages/opencode/src/permission/service.ts)、
[V1.2.27 配置](https://github.com/anomalyco/opencode/blob/v1.2.27/packages/opencode/src/config/config.ts)、
[V1.2.27 会话路由](https://github.com/anomalyco/opencode/blob/v1.2.27/packages/opencode/src/server/routes/session.ts)。
