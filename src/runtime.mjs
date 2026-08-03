import { TraeMonitor } from "./cdp.mjs";
import { createDashboardServer } from "./server.mjs";
import { UsageStore } from "./store.mjs";

export async function startUsageRuntime({
  dbPath,
  host = "127.0.0.1",
  cdpPort = 9222,
  dashboardPort = 4317,
  debuggerEnabled = true,
  version = "dev",
  onLog = () => {}
}) {
  const store = new UsageStore(dbPath);
  const state = {
    service: "trae-usage-monitor",
    version,
    cdpConnected: false,
    cdpTargets: 0,
    breakpointCount: 0,
    lastError: null,
    lastUsageAt: null,
    mode: "cdp"
  };
  const monitor = new TraeMonitor({ host, port: cdpPort, debugger: debuggerEnabled });
  let stopped = false;

  monitor.on("status", ({ connected, targetCount, error }) => {
    state.cdpConnected = connected;
    state.cdpTargets = targetCount;
    state.lastError = error ?? null;
  });
  monitor.on("usage", (usage) => {
    const row = store.record(usage);
    state.lastUsageAt = row.observed_at;
    onLog(`[usage] ${row.model} total=${row.total_tokens} cached=${row.cached_tokens} credits=${row.credits?.toFixed?.(3) ?? "N/A"} (${row.credit_kind})`);
  });
  monitor.on("diagnostic", (event) => {
    if (event.type === "breakpoint") {
      state.breakpointCount++;
      onLog(`[cdp] reportTokenUsage breakpoint: ${event.url}:${event.lineNumber + 1}`);
    } else if (event.error) {
      onLog(`[cdp] ${event.type}: ${event.error}`);
    }
  });

  const dashboard = createDashboardServer({
    store,
    host,
    port: dashboardPort,
    getStatus: () => state
  });

  let dashboardUrl;
  try {
    dashboardUrl = await dashboard.listen();
    monitor.start();
  } catch (error) {
    monitor.close();
    store.close();
    throw error;
  }

  return {
    store,
    state,
    monitor,
    dashboardUrl,
    async stop() {
      if (stopped) return;
      stopped = true;
      monitor.close();
      await dashboard.close();
      store.close();
    }
  };
}
