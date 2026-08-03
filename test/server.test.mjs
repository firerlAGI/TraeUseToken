import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboardServer, rangeStart } from "../src/server.mjs";
import { UsageStore } from "../src/store.mjs";

test("local API omits private correlation identifiers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "trae-monitor-server-test-"));
  const store = new UsageStore(join(directory, "usage.db"));
  store.record({
    model: "Seed-Code",
    promptTokens: 100,
    completionTokens: 2,
    totalTokens: 102,
    cachedTokens: 90,
    credits: 0.01,
    source: "billing",
    sessionId: "session-secret",
    userMessageId: "user-message-secret",
    agentMessageId: "agent-message-secret",
    billingId: "billing-secret"
  });
  const dashboard = createDashboardServer({
    store,
    port: 0,
    getStatus: () => ({ service: "trae-usage-monitor", cdpConnected: true })
  });
  const url = await dashboard.listen();
  try {
    const [row] = await fetch(`${url}/api/calls`).then((response) => response.json());
    assert.equal(row.model, "Seed-Code");
    assert.equal(row.credits, 0.01);
    assert.equal(Object.hasOwn(row, "session_id"), false);
    assert.equal(Object.hasOwn(row, "user_message_id"), false);
    assert.equal(Object.hasOwn(row, "agent_message_id"), false);
    assert.equal(Object.hasOwn(row, "billing_id"), false);
  } finally {
    await dashboard.close();
    store.close();
  }
});

test("computes local day, Monday week and month boundaries", () => {
  const now = new Date(2026, 7, 5, 15, 30);
  assert.equal(rangeStart("day", now), new Date(2026, 7, 5).toISOString());
  assert.equal(rangeStart("week", now), new Date(2026, 7, 3).toISOString());
  assert.equal(rangeStart("month", now), new Date(2026, 7, 1).toISOString());
  assert.equal(rangeStart("all", now), null);
});
