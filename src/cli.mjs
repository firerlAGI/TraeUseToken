#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { startUsageRuntime } from "./runtime.mjs";
import { UsageStore } from "./store.mjs";

function argumentsFrom(argv) {
  const options = {
    cdpPort: 9222,
    dashboardPort: 4317,
    host: "127.0.0.1",
    db: join(homedir(), "Library", "Application Support", "TraeUsageMonitor", "usage.db"),
    open: true,
    mock: false,
    debugger: true
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const [key, inline] = argument.split("=", 2);
    const value = inline ?? argv[index + 1];
    if (key === "--cdp-port") { options.cdpPort = Number(value); if (inline === undefined) index++; }
    else if (key === "--dashboard-port") { options.dashboardPort = Number(value); if (inline === undefined) index++; }
    else if (key === "--host") { options.host = value; if (inline === undefined) index++; }
    else if (key === "--db") { options.db = value; if (inline === undefined) index++; }
    else if (key === "--open=false") options.open = false;
    else if (key === "--mock") options.mock = true;
    else if (key === "--network-only") options.debugger = false;
    else if (key === "--help" || key === "-h") options.help = true;
  }
  return options;
}

function printHelp() {
  console.log(`Trae Use Token

Usage: node src/cli.mjs [options]

  --cdp-port <port>        TRAE remote debugging port (default: 9222)
  --dashboard-port <port>  Local dashboard port (default: 4317)
  --db <path>              SQLite database path
  --network-only           Disable reportTokenUsage debugger breakpoint
  --open=false             Do not open the dashboard
  --mock                    Generate demo observations without TRAE
  -h, --help                Show this help

Start TRAE CN with CDP on macOS:
  open -na "TRAE CN" --args --remote-debugging-port=9222
`);
}

function openBrowser(url) {
  if (process.platform === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  else if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

function startMock(store) {
  const fixtures = [
    { model: "Seed-Code", promptTokens: 29234, completionTokens: 4, totalTokens: 29238, cachedTokens: 29234 },
    { model: "DeepSeek-V4-Flash", promptTokens: 26105, completionTokens: 13, totalTokens: 26118, cachedTokens: 25600 },
    { model: "GLM-5.2", promptTokens: 25403, completionTokens: 3, totalTokens: 25406, cachedTokens: 2624 }
  ];
  let index = 0;
  const add = () => store.record({ ...fixtures[index++ % fixtures.length], source: "mock" });
  fixtures.forEach(add);
  return setInterval(add, 8000);
}

const options = argumentsFrom(process.argv.slice(2));
if (options.help) { printHelp(); process.exit(0); }

let runtime;
let store;
let mockTimer;
if (options.mock) {
  store = new UsageStore(options.db);
  mockTimer = startMock(store);
  const { createDashboardServer } = await import("./server.mjs");
  const dashboard = createDashboardServer({
    store,
    host: options.host,
    port: options.dashboardPort,
    getStatus: () => ({ service: "trae-usage-monitor", version: "dev", cdpConnected: true,
      cdpTargets: 0, breakpointCount: 0, lastError: null, lastUsageAt: null, mode: "mock" })
  });
  const dashboardUrl = await dashboard.listen();
  runtime = { dashboardUrl, stop: async () => { clearInterval(mockTimer); await dashboard.close(); store.close(); } };
} else {
  runtime = await startUsageRuntime({
    dbPath: options.db,
    host: options.host,
    cdpPort: options.cdpPort,
    dashboardPort: options.dashboardPort,
    debuggerEnabled: options.debugger,
    onLog: console.log
  });
}
console.log(`Trae Use Token: ${runtime.dashboardUrl}`);
console.log(`Database: ${options.db}`);
if (!options.mock) console.log(`Waiting for TRAE CDP at http://${options.host}:${options.cdpPort} ...`);
if (options.open) openBrowser(runtime.dashboardUrl);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await runtime.stop();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
