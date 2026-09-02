const NATIVE_CREDITS_COMMAND = "workbench.action.icubeGetCreditsUsageInfo";

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeCreditsSnapshot(value) {
  if (!value || typeof value !== "object") return null;
  const used = finiteNumber(value.used);
  if (used === null) return null;
  return {
    used,
    limit: finiteNumber(value.limit),
    remaining: finiteNumber(value.remaining),
    isCreditsBilling: value.isCreditsBilling === true,
    isDollarUsageBilling: value.isDollarUsageBilling === true,
    expireTime: finiteNumber(value.expireTime)
  };
}

function nativeContext(payload) {
  const queue = [{ value: payload, depth: 0 }];
  const seen = new WeakSet();
  const result = {};
  const modelKeys = new Set(["model", "modelName", "model_name", "displayModel", "display_model"]);
  const identifierKeys = new Map([
    ["sessionId", "sessionId"], ["session_id", "sessionId"],
    ["userMessageId", "userMessageId"], ["user_message_id", "userMessageId"],
    ["agentMessageId", "agentMessageId"], ["agent_message_id", "agentMessageId"],
    ["taskId", "taskId"], ["task_id", "taskId"]
  ]);
  while (queue.length) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== "object" || depth > 6 || seen.has(value)) continue;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (!result.model && modelKeys.has(key) && typeof child === "string" && child) result.model = child;
      const target = identifierKeys.get(key);
      if (target && !result[target] && (typeof child === "string" || typeof child === "number")) {
        result[target] = String(child);
      }
      if (child && typeof child === "object") queue.push({ value: child, depth: depth + 1 });
    }
  }
  return result;
}

function createNativeUsageBridge({
  vscode,
  sendSnapshot,
  onLog = () => {},
  retryDelays = [0, 1500, 5000],
  reconcileInterval = 30000
}) {
  const timers = new Set();
  let disposed = false;
  let generation = 0;
  let eventDisposable;
  let reconcileTimer;
  let pendingPayload;

  async function refresh(reason, payload) {
    try {
      const value = await vscode.commands.executeCommand(NATIVE_CREDITS_COMMAND);
      const snapshot = normalizeCreditsSnapshot(value);
      if (!snapshot) throw new Error("TRAE 未返回可识别的积分数据");
      const result = await sendSnapshot({ ...snapshot, ...nativeContext(payload), reason, observedAt: new Date().toISOString() });
      return { snapshot, result };
    } catch (error) {
      onLog(`[native] 积分刷新失败：${error.message}`);
      return null;
    }
  }

  function scheduleTaskRefresh(payload) {
    pendingPayload = payload;
    const current = ++generation;
    for (const delay of retryDelays) {
      const timer = setTimeout(async () => {
        timers.delete(timer);
        if (disposed || current !== generation) return;
        const refreshed = await refresh("task", payload);
        if (refreshed?.result?.recorded) {
          pendingPayload = undefined;
          generation++;
        }
      }, delay);
      timers.add(timer);
    }
  }

  return {
    async start() {
      const commands = await vscode.commands.getCommands(true);
      const event = vscode.icubeAI?.onAiTaskComplete;
      if (!commands.includes(NATIVE_CREDITS_COMMAND) || typeof event !== "function") {
        onLog("[native] 当前 TRAE 未提供免重启积分接口");
        return false;
      }
      await refresh("baseline");
      eventDisposable = event((payload) => scheduleTaskRefresh(payload));
      if (reconcileInterval > 0) {
        reconcileTimer = setInterval(async () => {
          if (disposed) return;
          const refreshed = await refresh("reconcile", pendingPayload);
          if (refreshed?.result?.recorded) {
            pendingPayload = undefined;
            generation++;
          }
        }, reconcileInterval);
      }
      onLog("[native] 免重启积分监听已启动");
      return true;
    },
    refresh,
    dispose() {
      disposed = true;
      eventDisposable?.dispose();
      if (reconcileTimer) clearInterval(reconcileTimer);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    }
  };
}

module.exports = { NATIVE_CREDITS_COMMAND, createNativeUsageBridge, nativeContext, normalizeCreditsSnapshot };
