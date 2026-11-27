const test = require("node:test");
const assert = require("node:assert/strict");
const { createNativeUsageBridge, nativeContext, nativeTaskUsage,
  normalizeCreditsSnapshot } = require("../extension/native-usage.cjs");

test("normalizes TRAE native credits without copying unrelated account data", () => {
  assert.deepEqual(normalizeCreditsSnapshot({
    limit: 10500, used: 7379.8804, remaining: 3120.1196,
    isCreditsBilling: true, isDollarUsageBilling: false, expireTime: 1790783999,
    token: "must-not-leak"
  }), {
    limit: 10500, used: 7379.8804, remaining: 3120.1196,
    isCreditsBilling: true, isDollarUsageBilling: false, expireTime: 1790783999
  });
});

test("extracts only model and stable identifiers from native task events", () => {
  assert.deepEqual(nativeContext({ task: { task_id: "task-1", model_name: "Seed-Code" },
    message: { user_message_id: "user-1" }, prompt: "must-not-leak" }), {
    taskId: "task-1", model: "Seed-Code", userMessageId: "user-1"
  });
});

test("extracts available token counters without retaining task content", () => {
  assert.deepEqual(nativeTaskUsage({ task_id: "task-2", model: "Coding Plan Model",
    response: { usage: { input_tokens: 120, output_tokens: 5, cached_tokens: 80 } },
    prompt: "must-not-leak", answer: "must-not-leak" }), {
    taskId: "task-2", model: "Coding Plan Model", promptTokens: 120,
    completionTokens: 5, cachedTokens: 80, totalTokens: 125
  });
});

test("records native tasks even when TRAE exposes no credits command", async () => {
  let listener;
  const tasks = [];
  const vscode = {
    commands: { getCommands: async () => [] },
    icubeAI: { onAiTaskComplete(callback) { listener = callback; return { dispose() {} }; } }
  };
  const bridge = createNativeUsageBridge({ vscode, sendTask: async (value) => tasks.push(value),
    sendSnapshot: async () => assert.fail("credits must not be queried"), reconcileInterval: 0 });
  assert.equal(await bridge.start(), true);
  listener({ task_id: "coding-plan-1", model_name: "Coding Plan Model" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].taskId, "coding-plan-1");
  bridge.dispose();
});

test("starts with a baseline and refreshes after a native task event", async () => {
  let listener;
  const sent = [];
  const tasks = [];
  const vscode = {
    commands: {
      getCommands: async () => ["workbench.action.icubeGetCreditsUsageInfo"],
      executeCommand: async () => ({ used: sent.length ? 2 : 1, remaining: 9 })
    },
    icubeAI: { onAiTaskComplete(callback) { listener = callback; return { dispose() {} }; } }
  };
  const bridge = createNativeUsageBridge({ vscode, sendTask: async (value) => tasks.push(value),
    sendSnapshot: async (value) => sent.push(value), retryDelays: [0], reconcileInterval: 0 });
  assert.equal(await bridge.start(), true);
  listener({ task_id: "task-1" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sent.length, 2);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].taskId, "task-1");
  assert.equal(sent[0].reason, "baseline");
  assert.equal(sent[1].reason, "settlement");
  bridge.dispose();
});

test("periodically reconciles delayed TRAE credit settlement", { timeout: 1000 }, async () => {
  let reads = 0;
  let reportSettlement;
  const settlement = new Promise((resolve) => { reportSettlement = resolve; });
  const vscode = {
    commands: {
      getCommands: async () => ["workbench.action.icubeGetCreditsUsageInfo"],
      executeCommand: async () => ({ used: ++reads >= 3 ? 2 : 1, remaining: 8 })
    },
    icubeAI: { onAiTaskComplete() { return { dispose() {} }; } }
  };
  const bridge = createNativeUsageBridge({
    vscode,
    sendTask: async () => ({}),
    sendSnapshot: async (value) => {
      if (value.reason === "reconcile" && value.used === 2) reportSettlement(value);
      return { recorded: value.used > 1 };
    },
    retryDelays: [],
    reconcileInterval: 5
  });
  try {
    assert.equal(await bridge.start(), true);
    assert.equal((await settlement).used, 2);
  } finally {
    bridge.dispose();
  }
});
