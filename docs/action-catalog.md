# Fish Pocket 本机工具按需加载

普通会话需要日历、照片、提醒等本机能力时，先用 `connector_search` 按关键词或准确名称查找。唯一匹配会在当前会话的下一次模型调用中启用原工具。多个匹配只返回短说明，按名称选择，或用返回的 `offset` 翻页。

`/browser-cli` 提供工作台浏览器命令。常用入口是 `browser open URL`、`browser read`、`browser click 4` 和 `browser screenshot --out page.jpg`。截图可交给 `read_image`。需要 PDF、上传、脚本或内联图片时，用 `connector_search(query="browser")` 启用原工具。

## 注册与权限

`engine/plugins/ios-native/discovery.mjs` 仅登记 Fish Pocket 自己的设备工具。它使用 DSH `tools.register(definition, { when })` 按会话启用原定义。浏览器 CLI 也走 DSH 的作用域、工具执行和审批流程。设备授权、系统选择器及写入确认由原生桥处理。

DSH 核心工具、MCP、DS Bot、生图和画布按仓库原有配置加载。Fish Pocket 自带的 Skill 通过标准 `SKILL.md` 提供短摘要，正文按需读取。旧会话可以重新发现设备工具，继续使用已有授权。

## 添加本机能力

将定义登记到 `engine/plugins/ios-native/tools.mjs`，并在 `engine/plugins/ios-native/index.mjs` 加上检索关键词。现有注册入口负责按会话启用，新调用沿用相应原生权限。
