# TRAE Usage Monitor

TRAE Usage Monitor 是一个非官方、本地优先的 TRAE CN 扩展，用于观察模型调用的 Token、
缓存命中和积分消耗。仪表盘直接显示在 TRAE 内，不需要额外安装 Node.js，也不会把记录上传到云端。

## 功能

- 输入、输出、总 Token 和缓存读取/写入统计；
- 今日、本周、本月和全部历史记录四种统计范围；
- 按模型聚合、最近调用和缓存命中率；
- 区分 TRAE 返回的实际积分与本地实验估算积分；
- 捕获 `get_session_usage` 的 `credits_float` 实际账单值；
- TRAE 内置仪表盘、状态栏摘要和 CSV 导出；
- 多窗口单实例协调、启动诊断和旧版数据库自动迁移；
- SQLite 本地持久化，不保存提示词和回答正文。

## 兼容性

- 已验证：macOS、TRAE CN 3.3.83（编辑器内核 1.107.1）；
- 扩展要求兼容 VS Code 1.107 API 的 TRAE 版本；
- Windows/Linux 启动命令已提供，但尚未完成同等强度的实机验证。

## 安装

1. 下载发布页中的 `.vsix` 文件；
2. 打开 TRAE 扩展面板；
3. 从扩展面板菜单选择“从 VSIX 安装”；
4. 安装完成后完全退出 TRAE。

## 首次启动

TRAE 必须在进程启动时开启本机 CDP 端口。macOS 在终端运行：

```bash
open -na "TRAE CN" --args --remote-debugging-port=9222
```

也可以在命令面板运行 `TRAE Usage: 复制 CDP 启动命令`。

> 扩展无法在 TRAE 已启动后动态打开 Electron 调试端口。CDP 只能绑定在本机使用，
> 不要将 9222 端口转发或暴露到局域网/公网。

## 使用

安装并按上述方式重启 TRAE 后：

- 点击状态栏的 `TRAE Usage` 摘要打开内置仪表盘；
- 或运行 `TRAE Usage: 打开内置仪表盘`；
- 或打开深链接 `trae-cn://local.trae-usage-monitor/dashboard`；
- 若状态一直异常，运行 `TRAE Usage: 显示诊断信息`；
- 运行 `TRAE Usage: 导出 CSV` 保存本地记录。

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

数据库保存在 TRAE 分配给扩展的全局存储目录。旧版 macOS 数据库会在首次启动 1.0.0 时复制迁移。

扩展不包含遥测或云端同步，不持久化提示词、回答正文、Cookie、授权头和原始网络响应。
为准确去重，数据库会保存不可读的会话/消息标识；这些标识不会出现在 CSV 中。
完整说明见随扩展分发的 `PRIVACY.md`。

## 命令

- `TRAE Usage: 打开内置仪表盘`
- `TRAE Usage: 启动或修复监听器`
- `TRAE Usage: 导出 CSV`
- `TRAE Usage: 复制 CDP 启动命令`
- `TRAE Usage: 显示诊断信息`

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
