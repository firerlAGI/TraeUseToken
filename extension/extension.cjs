const vscode = require("vscode");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { pathToFileURL } = require("node:url");

let ownedRuntime;
let runtimePromise;
let statusTimer;
let dashboardPanel;
let output;
let activeContext;
let statusBar;

function config() {
  const value = vscode.workspace.getConfiguration("traeUsage");
  return {
    servicePort: value.get("servicePort", 4317),
    cdpPort: value.get("cdpPort", 9222),
    autoStart: value.get("autoStart", true),
    debuggerEnabled: value.get("debuggerEnabled", true)
  };
}

function serviceUrl(port = config().servicePort) {
  return `http://127.0.0.1:${port}`;
}

function request(url, timeout = 1800) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode || 0, body: Buffer.concat(chunks) }));
    });
    req.on("timeout", () => req.destroy(new Error("请求超时")));
    req.on("error", reject);
  });
}

async function getJson(url) {
  const response = await request(url);
  if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
  return JSON.parse(response.body.toString("utf8"));
}

async function health() {
  try {
    const value = await getJson(`${serviceUrl()}/api/health`);
    return value?.ok ? value : null;
  } catch {
    return null;
  }
}

function databasePath(context) {
  fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });
  const target = path.join(context.globalStorageUri.fsPath, "usage.db");
  if (fs.existsSync(target)) return target;

  if (process.platform === "darwin") {
    const legacy = path.join(os.homedir(), "Library", "Application Support", "TraeUsageMonitor", "usage.db");
    if (fs.existsSync(legacy)) {
      try {
        fs.copyFileSync(legacy, target, fs.constants.COPYFILE_EXCL);
        output?.appendLine(`[migration] 已从旧版迁移数据库：${legacy}`);
      } catch (error) {
        output?.appendLine(`[migration] 数据库迁移失败，将使用新数据库：${error.message}`);
      }
    }
  }
  return target;
}

async function ensureRuntime(context, announce = false) {
  const existing = await health();
  if (existing) {
    if (announce) vscode.window.showInformationMessage("TRAE Usage Monitor 已在运行");
    return existing;
  }
  if (runtimePromise) return runtimePromise;

  runtimePromise = (async () => {
    const options = config();
    const runtimeUrl = pathToFileURL(path.join(context.extensionPath, "src", "runtime.mjs")).href;
    const { startUsageRuntime } = await import(runtimeUrl);
    try {
      ownedRuntime = await startUsageRuntime({
        dbPath: databasePath(context),
        host: "127.0.0.1",
        cdpPort: options.cdpPort,
        dashboardPort: options.servicePort,
        debuggerEnabled: options.debuggerEnabled,
        version: context.extension.packageJSON.version,
        onLog: (message) => output?.appendLine(message)
      });
      output?.appendLine(`[runtime] 已启动；Node ${process.versions.node}；CDP ${options.cdpPort}`);
      if (announce) vscode.window.showInformationMessage("TRAE Usage Monitor 已启动");
      return ownedRuntime.state;
    } catch (error) {
      // Another TRAE window may have won the single-instance race.
      const raced = await health();
      if (raced) return raced;
      output?.appendLine(`[runtime] 启动失败：${error.stack || error.message}`);
      throw error;
    }
  })();

  try {
    return await runtimePromise;
  } finally {
    runtimePromise = undefined;
  }
}

async function stopOwnedRuntime() {
  const runtime = ownedRuntime;
  ownedRuntime = undefined;
  if (runtime) await runtime.stop();
}

async function snapshot() {
  const base = serviceUrl();
  const [currentHealth, summary, calls] = await Promise.all([
    getJson(`${base}/api/health`),
    getJson(`${base}/api/summary`),
    getJson(`${base}/api/calls?limit=50`)
  ]);
  return { health: currentHealth, summary, calls };
}

function launchCommand() {
  const port = config().cdpPort;
  if (process.platform === "darwin") return `open -na "TRAE CN" --args --remote-debugging-port=${port}`;
  if (process.platform === "win32") return `"%LOCALAPPDATA%\\Programs\\TRAE CN\\TRAE CN.exe" --remote-debugging-port=${port}`;
  return `trae-cn --remote-debugging-port=${port}`;
}

async function copyLaunchCommand() {
  const command = launchCommand();
  await vscode.env.clipboard.writeText(command);
  vscode.window.showInformationMessage("TRAE CDP 启动命令已复制；请完全退出 TRAE 后在终端运行");
}

async function exportCsv() {
  try {
    await ensureRuntime(activeContext, false);
    const response = await request(`${serviceUrl()}/api/export.csv`, 5000);
    if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), "Downloads", `trae-usage-${new Date().toISOString().slice(0, 10)}.csv`)),
      filters: { CSV: ["csv"] },
      saveLabel: "导出用量记录"
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, response.body);
    vscode.window.showInformationMessage(`已导出：${target.fsPath}`);
  } catch (error) {
    vscode.window.showErrorMessage(`导出失败：${error.message}`);
  }
}

function nonce() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index++) value += alphabet[Math.floor(Math.random() * alphabet.length)];
  return value;
}

function dashboardHtml(webview) {
  const token = nonce();
  const csp = `default-src 'none'; style-src 'nonce-${token}'; script-src 'nonce-${token}';`;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}"><title>TRAE Usage Monitor</title>
<style nonce="${token}">
:root{color-scheme:light dark;--panel:var(--vscode-editorWidget-background);--line:var(--vscode-widget-border);--muted:var(--vscode-descriptionForeground);--green:#27d98b;--blue:#62a8ff;--amber:#e6a23c}*{box-sizing:border-box}body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font:13px/1.5 var(--vscode-font-family);padding:24px}main{max-width:1180px;margin:auto}header{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;margin-bottom:20px}h1{font-size:24px;margin:0 0 4px}.sub,.status{color:var(--muted)}.status{display:flex;align-items:center;gap:8px}.dot{width:9px;height:9px;border-radius:50%;background:var(--vscode-disabledForeground)}.dot.on{background:var(--green);box-shadow:0 0 12px #27d98b88}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.card,.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px}.card{padding:16px}.label{color:var(--muted);font-size:12px}.value{font-size:24px;font-weight:680;margin-top:6px}.unit{color:var(--muted);font-size:12px;font-weight:400}.grid{display:grid;grid-template-columns:1fr 1.55fr;gap:12px;margin-top:12px}.panel{padding:17px;overflow:hidden}h2{font-size:14px;margin:0 0 14px}.model{display:grid;grid-template-columns:128px 1fr 62px;gap:10px;align-items:center;margin:10px 0}.model-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.track{height:7px;background:var(--vscode-progressBar-background);opacity:.38;border-radius:9px;overflow:hidden}.bar{height:100%;background:linear-gradient(90deg,var(--green),var(--blue));border-radius:9px}.model-total{text-align:right;color:var(--muted);font-variant-numeric:tabular-nums}table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}th{color:var(--muted);font-weight:500;font-size:11px;text-align:right;padding:0 8px 9px}th:first-child,td:first-child{text-align:left}td{text-align:right;border-top:1px solid var(--line);padding:10px 8px;white-space:nowrap}.model-cell{font-weight:600}.actual{color:var(--green)}.estimated{color:var(--amber)}.toolbar{display:flex;flex-wrap:wrap;gap:8px;justify-content:space-between;align-items:center;margin:22px 0 10px}.actions{display:flex;gap:8px;flex-wrap:wrap}button{color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;padding:7px 12px;border-radius:5px;cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}button.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}button.secondary:hover{background:var(--vscode-button-secondaryHoverBackground)}.legend,.empty,.notice{color:var(--muted);font-size:12px}.legend{margin-top:12px}.empty{padding:24px 0;text-align:center}.notice{border-top:1px solid var(--line);padding-top:12px}.error{color:var(--vscode-errorForeground)}@media(max-width:820px){.cards{grid-template-columns:1fr 1fr}.grid{grid-template-columns:1fr}.table-wrap{overflow:auto}}@media(max-width:480px){body{padding:14px}.cards{grid-template-columns:1fr}header{align-items:flex-start;flex-direction:column}}
</style></head><body><main>
<header><div><h1>TRAE Usage Monitor</h1><div class="sub">本地 Token、缓存与积分观测</div></div><div class="status"><span id="dot" class="dot"></span><span id="status">正在连接</span></div></header>
<section class="cards"><div class="card"><div class="label">调用次数</div><div class="value" id="calls">0</div></div><div class="card"><div class="label">总词元</div><div class="value" id="tokens">0</div></div><div class="card"><div class="label">缓存命中率</div><div class="value" id="cache">0<span class="unit">%</span></div></div><div class="card"><div class="label">积分</div><div class="value" id="credits">0</div></div></section>
<section class="grid"><div class="panel"><h2>按模型用量</h2><div id="models" class="empty">暂无数据</div></div><div class="panel"><h2>最近调用</h2><div class="table-wrap"><table><thead><tr><th>模型</th><th>输入</th><th>输出</th><th>缓存</th><th>积分</th></tr></thead><tbody id="recent"></tbody></table></div><div class="legend"><span class="actual">● 实际积分</span>　<span class="estimated">● 估算积分</span></div></div></section>
<div class="toolbar"><div><strong>记录仅保存在本机 SQLite</strong></div><div class="actions"><button class="secondary" id="setup">复制 CDP 启动命令</button><button class="secondary" id="diagnostics">查看诊断</button><button id="export">导出 CSV</button></div></div>
<div id="notice" class="notice">不保存提示词、回答正文或鉴权信息。估算积分不代表 TRAE 官方账单。</div>
</main><script nonce="${token}">
const vscode=acquireVsCodeApi(),fmt=new Intl.NumberFormat('zh-CN'),num=v=>fmt.format(Math.round(Number(v)||0)),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function render(data){const h=data.health||{},s=data.summary||{total:{},models:[]},rows=data.calls||[],t=s.total||{};document.querySelector('#calls').textContent=num(t.calls);document.querySelector('#tokens').textContent=num(t.total_tokens);const rate=t.prompt_tokens?100*t.cached_tokens/t.prompt_tokens:0;document.querySelector('#cache').innerHTML=rate.toFixed(1)+'<span class="unit">%</span>';const actual=Number(t.actual_credits)||0,estimated=Number(t.estimated_credits)||0;document.querySelector('#credits').innerHTML=(actual+estimated).toFixed(2)+' <span class="unit">'+(actual&&estimated?'混合':actual?'实际':'估算')+'</span>';const models=s.models||[],max=Math.max(1,...models.map(x=>x.total_tokens));document.querySelector('#models').className='';document.querySelector('#models').innerHTML=models.length?models.map(m=>'<div class="model"><div class="model-name" title="'+esc(m.model)+'">'+esc(m.model)+'</div><div class="track"><div class="bar" style="width:'+100*m.total_tokens/max+'%"></div></div><div class="model-total">'+num(m.total_tokens)+'</div></div>').join(''):'<div class="empty">暂无数据</div>';document.querySelector('#recent').innerHTML=rows.map(c=>'<tr><td class="model-cell">'+esc(c.model)+'</td><td>'+num(c.prompt_tokens)+'</td><td>'+num(c.completion_tokens)+'</td><td>'+num(c.cached_tokens)+'</td><td class="'+esc(c.credit_kind)+'">'+(c.credits==null?'—':Number(c.credits).toFixed(3))+'</td></tr>').join('');const ready=h.cdpConnected&&(h.breakpointCount>0||h.lastUsageAt);document.querySelector('#dot').classList.toggle('on',ready);document.querySelector('#status').textContent=!h.cdpConnected?'等待 TRAE CDP':ready?(h.breakpointCount>0?'已就绪 · '+h.breakpointCount+' 个采集点':'已就绪 · 已捕获用量'):'已连接，正在定位采集点';document.querySelector('#notice').className='notice';document.querySelector('#notice').textContent=h.lastError?'CDP：'+h.lastError:'不保存提示词、回答正文或鉴权信息。估算积分不代表 TRAE 官方账单。'}
window.addEventListener('message',e=>{if(e.data.type==='snapshot')render(e.data.value);if(e.data.type==='error'){document.querySelector('#notice').className='notice error';document.querySelector('#notice').textContent=e.data.message}});document.querySelector('#export').onclick=()=>vscode.postMessage({type:'export'});document.querySelector('#setup').onclick=()=>vscode.postMessage({type:'setup'});document.querySelector('#diagnostics').onclick=()=>vscode.postMessage({type:'diagnostics'});vscode.postMessage({type:'ready'});
</script></body></html>`;
}

async function postSnapshot() {
  if (!dashboardPanel) return;
  try {
    const value = await snapshot();
    await dashboardPanel.webview.postMessage({ type: "snapshot", value });
  } catch (error) {
    await dashboardPanel.webview.postMessage({ type: "error", message: `读取监控数据失败：${error.message}` });
  }
}

async function openDashboard() {
  try {
    await ensureRuntime(activeContext, false);
  } catch (error) {
    vscode.window.showErrorMessage(`无法启动用量监控：${error.message}`);
    return;
  }
  if (dashboardPanel) {
    dashboardPanel.reveal(vscode.ViewColumn.One);
    await postSnapshot();
    return;
  }
  dashboardPanel = vscode.window.createWebviewPanel("traeUsage.dashboard", "TRAE Usage Monitor",
    vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
  dashboardPanel.webview.html = dashboardHtml(dashboardPanel.webview);
  dashboardPanel.webview.onDidReceiveMessage(async (message) => {
    if (message.type === "ready") await postSnapshot();
    else if (message.type === "export") await exportCsv();
    else if (message.type === "setup") await copyLaunchCommand();
    else if (message.type === "diagnostics") await showDiagnostics();
  }, undefined, activeContext.subscriptions);
  dashboardPanel.onDidDispose(() => { dashboardPanel = undefined; });
}

async function showDiagnostics() {
  output.clear();
  output.appendLine(`TRAE Usage Monitor ${activeContext.extension.packageJSON.version}`);
  output.appendLine(`Extension ID: ${activeContext.extension.id}`);
  output.appendLine(`TRAE: ${vscode.version}`);
  output.appendLine(`Node: ${process.versions.node}`);
  output.appendLine(`Platform: ${process.platform} ${process.arch}`);
  output.appendLine(`CDP port: ${config().cdpPort}`);
  output.appendLine(`Service port: ${config().servicePort}`);
  output.appendLine(`Database: ${databasePath(activeContext)}`);
  try {
    const value = await snapshot();
    output.appendLine(`Connected: ${Boolean(value.health.cdpConnected)}`);
    output.appendLine(`CDP targets: ${value.health.cdpTargets || 0}`);
    output.appendLine(`Breakpoints: ${value.health.breakpointCount || 0}`);
    output.appendLine(`Last usage: ${value.health.lastUsageAt || "none"}`);
    output.appendLine(`Calls: ${value.summary.total.calls || 0}`);
  } catch (error) {
    output.appendLine(`Service error: ${error.message}`);
  }
  output.show(true);
}

async function updateStatus() {
  let current = await health();
  if (!current && config().autoStart) {
    try { current = await ensureRuntime(activeContext, false); } catch (error) {
      output?.appendLine(`[runtime] 自动启动失败：${error.message}`);
    }
  }

  if (!current) {
    statusBar.text = "$(error) TRAE Usage";
    statusBar.tooltip = "监控运行时未启动；点击打开诊断";
    statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
  } else {
    try {
      const summary = await getJson(`${serviceUrl()}/api/summary`);
      const total = summary.total || {};
      const credits = Number(total.actual_credits || 0) + Number(total.estimated_credits || 0);
      statusBar.text = `$(pulse) ${Number(total.total_tokens || 0).toLocaleString()} · ${credits.toFixed(2)}`;
    } catch {
      statusBar.text = "$(pulse) TRAE Usage";
    }
    statusBar.tooltip = current.cdpConnected
      ? `已连接 TRAE（${current.cdpTargets || 0} 个 CDP 目标，${current.breakpointCount || 0} 个采集点）`
      : `等待 TRAE CDP ${config().cdpPort}；点击查看仪表盘和启动说明`;
    statusBar.backgroundColor = current.cdpConnected ? undefined : new vscode.ThemeColor("statusBarItem.warningBackground");
  }
  statusBar.show();
  if (dashboardPanel) await postSnapshot();
}

async function activate(context) {
  activeContext = context;
  output = vscode.window.createOutputChannel("TRAE Usage Monitor");
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusBar.command = "traeUsage.openDashboard";
  context.subscriptions.push(output, statusBar);

  context.subscriptions.push(vscode.commands.registerCommand("traeUsage.openDashboard", openDashboard));
  context.subscriptions.push(vscode.commands.registerCommand("traeUsage.startMonitor", async () => {
    try {
      const current = await ensureRuntime(context, true);
      if (!current.cdpConnected) {
        const action = await vscode.window.showWarningMessage("监听器已启动，但 TRAE 未开启 CDP 端口。", "复制启动命令");
        if (action) await copyLaunchCommand();
      }
      await updateStatus();
    } catch (error) {
      vscode.window.showErrorMessage(`启动失败：${error.message}`);
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand("traeUsage.exportCsv", exportCsv));
  context.subscriptions.push(vscode.commands.registerCommand("traeUsage.copyLaunchCommand", copyLaunchCommand));
  context.subscriptions.push(vscode.commands.registerCommand("traeUsage.showDiagnostics", showDiagnostics));
  context.subscriptions.push(vscode.window.registerUriHandler({
    async handleUri(uri) {
      if (uri.path === "/dashboard") await openDashboard();
      else if (uri.path === "/diagnostics") await showDiagnostics();
    }
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (event) => {
    if (!event.affectsConfiguration("traeUsage")) return;
    await stopOwnedRuntime();
    await updateStatus();
  }));

  if (config().autoStart) {
    try { await ensureRuntime(context, false); } catch (error) {
      output.appendLine(`[runtime] 激活时启动失败：${error.stack || error.message}`);
    }
  }
  await updateStatus();
  statusTimer = setInterval(() => void updateStatus(), 3000);
}

async function deactivate() {
  clearInterval(statusTimer);
  await stopOwnedRuntime();
}

module.exports = { activate, deactivate };
