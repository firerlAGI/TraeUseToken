# Trae Use Token

Trae Use Token 是一个非官方、本地优先的 TRAE CN 扩展，用于观察模型调用的 Token、
缓存命中和积分消耗。仪表盘直接显示在 TRAE 内，不需要额外安装 Node.js，也不会把记录上传到云端。

## 功能

- 输入、输出、总 Token 和缓存读取/写入统计；
- 今日、本周、本月和全部历史记录四种统计范围；
- 调用记录卡片内滚动、吸顶表头和窄窗口横向溢出保护；
- 按模型聚合、最近调用和缓存命中率；
- 区分 TRAE 返回的实际积分与本地实验估算积分；
- 捕获 `get_session_usage` 的 `credits_float` 实际账单值；
- TRAE 内置仪表盘、状态栏摘要和 CSV 导出；
- 插件内一键保存并重启 TRAE，无需使用终端开启 CDP；
- 多窗口单实例协调、启动诊断和旧版数据库自动迁移；
- SQLite 本地持久化，不保存提示词和回答正文。

## 兼容性

- 已验证：macOS、TRAE CN 3.3.83（编辑器内核 1.107.1）；
- 扩展要求兼容 VS Code 1.107 API 的 TRAE 版本；
- Windows/Linux 启动命令已提供，但尚未完成同等强度的实机验证。

## 安装

扩展已经发布到 [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=firerl.trae-use-token)
和 [Open VSX](https://open-vsx.org/extension/firerl/trae-use-token)。TRAE 官方扩展镜像完成同步后，
可在扩展面板搜索 `Trae Use Token` 或 `@id:firerl.trae-use-token` 并点击“安装”。

如果 TRAE 商店暂时搜索不到，可从
[Open VSX 下载 VSIX](https://open-vsx.org/api/firerl/trae-use-token/1.3.2/file/firerl.trae-use-token-1.3.2.vsix)，
再从 TRAE 扩展面板右上角菜单选择“从 VSIX 安装”。安装完成后打开内置仪表盘，
点击“一键启动监听”。

## 首次启动

TRAE 必须在进程启动时开启本机 CDP 端口。首次使用时点击状态栏的 `Trae Use Token`，
再点击“一键启动监听”。插件会在确认后保存已修改文件、带本机 CDP 端口重启 TRAE，
并重新打开当前工作区。用户不需要打开终端。

如果系统未找到 TRAE 安装位置，仍可用命令面板中的 `Trae Use Token: 复制 CDP 启动命令` 作为备用方式。
Windows 自定义安装盘符或目录会自动从 TRAE 的应用根目录识别；若仍无法识别，选择一次安装目录中的
`Trae CN.exe` 即可，扩展会记住该路径。

> 扩展无法在 TRAE 已启动后动态打开 Electron 调试端口。CDP 只能绑定在本机使用，
> 不要将 9222 端口转发或暴露到局域网/公网。

## 使用

安装并按上述方式重启 TRAE 后：

- 未连接时点击状态栏的 `Trae Use Token` 进入一键启动；已连接时点击可打开内置仪表盘；
- 或运行 `Trae Use Token: 打开内置仪表盘`；
- 或打开深链接 `trae-cn://firerl.trae-use-token/dashboard`；
- 若状态一直异常，运行 `Trae Use Token: 显示诊断信息`；
- 运行 `Trae Use Token: 导出 CSV` 保存本地记录。

状态含义：

- `等待 TRAE CDP`：TRAE 没有用调试端口启动，或端口配置不一致；
- `正在定位采集点`：已连接 CDP，正在加载 TRAE 的模型调用脚本；
- `已就绪`：采集点已挂载，或已经收到用量记录。

## 实际积分与估算积分

正常调用完成后，TRAE CN 会请求：

```text
POST /api/v1/commercial/get_session_usage
```

扩展将响应中的 `credits_float` 标记为“实际积分”。如果该请求尚未发生，扩展会按本机实验校准
公式显示“估算积分”；估算结果不代表 TRAE 官方账单。加载或悬停历史消息后，TRAE 可能重新查询
账单，扩展会用真实值覆盖对应估算记录。

## 本地数据与隐私

数据库保存在 TRAE 分配给扩展的全局存储目录。首次安装商店版时，会自动迁移
`firerl.trae-usage-monitor`、`firerlAGI.trae-usage-monitor`、`local.trae-usage-monitor` 测试版以及旧版 macOS 数据库。

扩展不包含遥测或云端同步，不持久化提示词、回答正文、Cookie、授权头和原始网络响应。
为准确去重，数据库会保存不可读的会话/消息标识；这些标识不会出现在 CSV 中。
完整说明见随扩展分发的 `PRIVACY.md`。

## 命令

- `Trae Use Token: 打开内置仪表盘`
- `Trae Use Token: 一键启动监听`
- `Trae Use Token: 导出 CSV`
- `Trae Use Token: 复制 CDP 启动命令`
- `Trae Use Token: 显示诊断信息`

## 设置

- `traeUsage.cdpPort`：TRAE CDP 端口，默认 `9222`；
- `traeUsage.servicePort`：本机单实例协调端口，默认 `4317`；
- `traeUsage.autoStart`：自动启动监听运行时；
- `traeUsage.debuggerEnabled`：启用 Token 调试断点兜底。

## 从源码开发

源码 CLI 需要 Node.js 22.5 或更新版本：

```bash
npm test
npm start
```

生成 VSIX：

```bash
npm run package:vsix
```

扩展本体运行在 TRAE 自带的扩展宿主中，最终用户不需要安装 Node.js。

## 声明

本项目不是 TRAE 官方产品，与 TRAE 或字节跳动不存在隶属或背书关系。TRAE 客户端升级后，
内部脚本和接口可能变化；扩展会尽量退化为网络监听并在诊断信息中报告状态。

## License

MIT，完整条款见随扩展分发的 `LICENSE`。
