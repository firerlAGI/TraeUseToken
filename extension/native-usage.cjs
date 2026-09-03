const NATIVE_CREDITS_COMMAND = "workbench.action.icubeGetCreditsUsageInfo";

function finiteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
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

function nativeTaskUsage(payload) {
  const context = nativeContext(payload);
  const queue = [{ value: payload, depth: 0 }];
  const seen = new WeakSet();
  const aliases = {
    promptTokens: ["prompt_tokens", "input_tokens", "promptTokens", "inputTokens"],
    completionTokens: ["completion_tokens", "output_tokens", "completionTokens", "outputTokens"],
    totalTokens: ["total_tokens", "totalTokens"],
    cachedTokens: ["cached_tokens", "cache_read_input_tokens", "cachedTokens", "cacheReadInputTokens"],
    cacheWriteTokens: ["cache_creation_input_tokens", "cache_write_input_tokens", "cacheCreationInputTokens"]
  };
  const tokens = {};
  while (queue.length) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== "object" || depth > 8 || seen.has(value)) continue;
    seen.add(value);
    for (const [target, keys] of Object.entries(aliases)) {
      if (tokens[target] !== undefined) continue;
      for (const key of keys) {
        const number = finiteNumber(value[key]);
        if (number !== null && number >= 0) {
          tokens[target] = number;
          break;
        }
      }
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") queue.push({ value: child, depth: depth + 1 });
    }
  }
  if (tokens.totalTokens === undefined && (tokens.promptTokens !== undefined || tokens.completionTokens !== undefined)) {
    tokens.totalTokens = (tokens.promptTokens || 0) + (tokens.completionTokens || 0);
  }
  return { ...context, ...tokens };
}

function createNativeUsageBridge({
  vscode,
  sendSnapshot,
  sendTask,
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
        const refreshed = await refresh("settlement", payload);
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
      if (typeof event !== "function") {
        onLog("[native] 当前 TRAE 未提供免重启任务事件");
        return false;
      }
      const creditsAvailable = commands.includes(NATIVE_CREDITS_COMMAND);
      eventDisposable = event((payload) => {
        void sendTask({ ...nativeTaskUsage(payload), observedAt: new Date().toISOString() })
          .catch((error) => onLog(`[native] 调用记录失败：${error.message}`));
        if (creditsAvailable) scheduleTaskRefresh(payload);
      });
      if (creditsAvailable) await refresh("baseline");
      if (creditsAvailable && reconcileInterval > 0) {
        reconcileTimer = setInterval(async () => {
          if (disposed) return;
          const refreshed = await refresh("reconcile", pendingPayload);
          if (refreshed?.result?.recorded) {
            pendingPayload = undefined;
            generation++;
          }
        }, reconcileInterval);
      }
      onLog("[native] 免重启调用监听已启动");
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

module.exports = {
  NATIVE_CREDITS_COMMAND,
  createNativeUsageBridge,
  nativeContext,
  nativeTaskUsage,
  normalizeCreditsSnapshot
};
