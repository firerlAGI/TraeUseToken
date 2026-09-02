const test = require("node:test");
const assert = require("node:assert/strict");
const { createNativeUsageBridge, nativeContext, normalizeCreditsSnapshot } = require("../extension/native-usage.cjs");

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

test("starts with a baseline and refreshes after a native task event", async () => {
  let listener;
  const sent = [];
  const vscode = {
    commands: {
      getCommands: async () => ["workbench.action.icubeGetCreditsUsageInfo"],
      executeCommand: async () => ({ used: sent.length ? 2 : 1, remaining: 9 })
    },
    icubeAI: { onAiTaskComplete(callback) { listener = callback; return { dispose() {} }; } }
  };
  const bridge = createNativeUsageBridge({ vscode, sendSnapshot: async (value) => sent.push(value), retryDelays: [0], reconcileInterval: 0 });
  assert.equal(await bridge.start(), true);
  listener({ task_id: "task-1" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sent.length, 2);
  assert.equal(sent[0].reason, "baseline");
  assert.equal(sent[1].reason, "task");
  bridge.dispose();
});

test("periodically reconciles delayed TRAE credit settlement", async () => {
  let reads = 0;
  const sent = [];
  const vscode = {
    commands: {
      getCommands: async () => ["workbench.action.icubeGetCreditsUsageInfo"],
      executeCommand: async () => ({ used: ++reads >= 3 ? 2 : 1, remaining: 8 })
    },
    icubeAI: { onAiTaskComplete() { return { dispose() {} }; } }
  };
  const bridge = createNativeUsageBridge({
    vscode,
    sendSnapshot: async (value) => {
      sent.push(value);
      return { recorded: value.used > 1 };
    },
    retryDelays: [],
    reconcileInterval: 5
  });
  assert.equal(await bridge.start(), true);
  await new Promise((resolve) => setTimeout(resolve, 18));
  assert.ok(sent.some((value) => value.reason === "reconcile" && value.used === 2));
  bridge.dispose();
});
