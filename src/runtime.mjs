import { TraeMonitor } from "./cdp.mjs";
import { createDashboardServer } from "./server.mjs";
import { UsageStore } from "./store.mjs";

export async function startUsageRuntime({
  dbPath,
  host = "127.0.0.1",
  cdpPort = 9222,
  dashboardPort = 4317,
  debuggerEnabled = true,
  historyBackfill = true,
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
    mode: "waiting",
    nativeAvailable: false,
    nativeTaskEvents: 0,
    nativeTaskEventsWithTokenCounts: 0,
    nativeCreditsUsed: null,
    nativeCreditsRemaining: null,
    lastNativeAt: null,
    lastNativeDelta: null,
    cdpPort,
    dashboardPort,
    pid: process.pid
  };
  const monitor = new TraeMonitor({ host, port: cdpPort, debugger: debuggerEnabled, historyBackfill,
    hasBilling: (id) => store.hasBilling(id) });
  let stopped = false;

  monitor.on("status", ({ connected, targetCount, error }) => {
    state.cdpConnected = connected;
    state.cdpTargets = targetCount;
    state.lastError = error ?? null;
    state.mode = connected ? "cdp" : state.nativeAvailable ? "native" : "waiting";
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

  async function applyNativeTask(task) {
    state.nativeAvailable = true;
    state.mode = state.cdpConnected ? "cdp" : "native";
    state.nativeTaskEvents++;
    if ([task.promptTokens, task.completionTokens, task.totalTokens,
      task.cachedTokens, task.cacheWriteTokens].some(Number.isFinite)) {
      state.nativeTaskEventsWithTokenCounts++;
    }
    const row = store.record({
      source: "native-task",
      model: task.model || "TRAE 原生任务",
      promptTokens: task.promptTokens,
      completionTokens: task.completionTokens,
      totalTokens: task.totalTokens,
      cachedTokens: task.cachedTokens,
      cacheWriteTokens: task.cacheWriteTokens,
      observedAt: task.observedAt,
      sessionId: task.sessionId,
      userMessageId: task.userMessageId,
      agentMessageId: task.agentMessageId,
      billingId: task.taskId,
      skipCreditEstimate: true
    });
    state.lastUsageAt = row.observed_at;
    onLog(`[native] 调用完成：${row.model}`);
    return { recorded: true, mode: state.mode, id: row.id };
  }

  async function applyNativeSnapshot(snapshot) {
    const used = Number(snapshot?.used);
    if (!Number.isFinite(used) || used < 0) throw new Error("invalid native credits snapshot");
    const previous = state.nativeCreditsUsed;
    state.nativeAvailable = true;
    state.lastNativeAt = snapshot.observedAt ?? new Date().toISOString();
    state.mode = state.cdpConnected ? "cdp" : "native";
    if (snapshot.reason === "baseline" && previous !== null) {
      return { recorded: false, mode: state.mode };
    }
    state.nativeCreditsUsed = used;
    state.nativeCreditsRemaining = Number.isFinite(snapshot.remaining) ? snapshot.remaining : null;
    if (previous === null || used <= previous || snapshot.reason === "baseline") {
      return { recorded: false, mode: state.mode };
    }
    const delta = used - previous;
    state.lastNativeDelta = delta;
    if (state.cdpConnected) return { recorded: false, mode: state.mode, delta };
    const row = store.record({
      source: "native",
      model: snapshot.model || "TRAE 原生积分",
      credits: delta,
      observedAt: snapshot.observedAt,
      sessionId: snapshot.sessionId,
      userMessageId: snapshot.userMessageId,
      agentMessageId: snapshot.agentMessageId,
      billingId: snapshot.taskId
    });
    state.lastUsageAt = row.observed_at;
    onLog(`[native] 实际积分 +${delta.toFixed(4)}`);
    return { recorded: true, mode: state.mode, delta };
  }

  const dashboard = createDashboardServer({
    store,
    host,
    port: dashboardPort,
    getStatus: () => state,
    onNativeSnapshot: applyNativeSnapshot,
    onNativeTask: applyNativeTask
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
