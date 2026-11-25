# Fish Pocket 动作目录

引擎在本地保留完整动作定义。Standard 的普通会话只拿到基础工具、`connector_search` 和技能目录中的短摘要。MCP 的鉴权、iOS 系统权限、设备写入策略和 Bot 开关仍由原来的组件执行。

## 使用

- 系统能力或远程 MCP 操作使用 `connector_search(query)`，唯一匹配会在下一模型步骤启用原工具。多个匹配返回名称和短说明，可选一个准确名称，或用返回的 `offset` 翻页。`resources:<服务器名>` 选择该服务的资源读取工具。服务端较长的说明可以按返回的 `guide:<服务器名>` 和偏移量继续读取。
- `/browser-cli` 提供会话浏览器命令。常用命令包括 `browser open URL`、`browser read`、`browser click 4` 和 `browser screenshot --out page.jpg`。用 `read_image` 读取截图。PDF、上传、脚本等完整动作仍可用 `connector_search("browser")` 启用原工具。模型和工作台终端通过宿主选定的 Agent 调用同一条 DSH 审批及执行路径。
- `/image-tools` 按需提供生图、批量生图和改图函数，继续返回会话附件和原生图片卡。灵感搜索用 `inspiration search 海报` 返回简短列表，再运行 `inspiration show <source> <id>` 读取一条全文。
- `/web-canvas` 提供当前网页会话的画布状态和选区。每个浏览器编辑器按真实会话 ID 上报实时选区。工作区里的画布文档沿用插件原有的共享存储，聊天里的图片标注走消息附件。
- 自定义 MCP 支持原请求头或密钥引用。新增 HTTPS 服务也可在“连接方式”选择 OAuth，再在连接详情中登录。现有连接记录、模型 Key、iOS 授权和 Bot 使用范围沿用原存储。新增 OAuth 连接使用独立的凭据空间，令牌绑定已授权的地址。

## 添加扩展

已有 CLI 可以直接配一个标准 `SKILL.md`。安装到工作区的 `.dsh/skills/<名称>/`，或者安装到 DSH 的用户技能目录。模型看到名称和一句用途，实际执行沿用项目现有的 `bash`。要组合已登记的设备和远端动作，可在 Skill frontmatter 中声明所需的准确工具名：

```yaml
---
name: meeting-photos
description: Organize photos taken during meetings on the device calendar.
metadata:
  fish-pocket:
    uses: [calendar, photos]
---
```

正文说明查询会议、筛选照片以及如何根据用户请求整理。加载 Skill 或用户显式输入 `/meeting-photos` 时，宿主检查当前会话的技能策略、工具范围和连接，再为该会话启用依赖。工具局部禁用和系统权限继续生效。

宿主插件可以用标准 `tools.register(definition, { discovery: { connection, skill, keywords }, when })` 声明可发现的原 DSH 工具。原来的 `when`、scope、guard、审批和结果展示继续生效。没有 `discovery` 的普通第三方注册保持原兼容行为。MCP 客户端和内置生图插件的已有注册由 iOS 工具服务自动适配。

需要成组注册时，`await ctx.tools.registerProvider(connection, provider)` 接受以下两个方法，返回此组动作的注销函数，插件卸载也会清理整组注册：

- `listActions(connection, { scope, signal })` 返回该连接的本次动作清单，支持 Promise。每项是一份 DSH `defineTool` 规格，包含 `name`、`description`、`parameters` 和 `output`，可加 `discovery` 及原 `when`。
- `invoke(connection, name, args, execution)` 调用扩展的实际处理函数。可用宿主给出的 Agent、会话和取消信号。插件更新可以注销上一组后重新注册。已有 MCP 连接继续通过原客户端 `tools/list`、`tools/call` 和列表变更通知热更新。

注册完成后，宿主侧可用 `tools.listActions(connection, { agent })` 查候选，用 `tools.describe(connection, name, { agent })` 取输入输出结构，用 `tools.invoke(connection, name, args, { agent, signal })` 走原执行管线。权限不会通过 Skill 获得。换代或断开的 MCP 动作要重新发现，限制某个 Bot 使用的服务也会从它的发现结果中消失。

## 验证和维护

`npm test` 和 `scripts/build-engine.sh` 均应用 `engine/patches/` 下的两个锁版补丁。更新 DS Bot 时复核自定义 OAuth 回调、凭据刷新/断开及每个 Bot 的限制；更新生图插件时复核真实网页会话的画布选区和按编号检索的提示词。旧版会话的全量工具头不会被解释成授权。
