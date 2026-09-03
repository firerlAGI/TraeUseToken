import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startUsageRuntime } from "../src/runtime.mjs";

test("self-contained runtime exposes versioned health and connects to CDP discovery", async () => {
  const discovery = createServer((request, response) => {
    if (request.url === "/json/list") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("[]");
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve, reject) => {
    discovery.once("error", reject);
    discovery.listen(0, "127.0.0.1", resolve);
  });
  const address = discovery.address();
  const directory = mkdtempSync(join(tmpdir(), "trae-monitor-runtime-test-"));
  const runtime = await startUsageRuntime({
    dbPath: join(directory, "usage.db"),
    cdpPort: address.port,
    dashboardPort: 0,
    version: "1.0.0"
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    const health = await fetch(`${runtime.dashboardUrl}/api/health`).then((response) => response.json());
    assert.equal(health.service, "trae-usage-monitor");
    assert.equal(health.version, "1.0.0");
    assert.equal(health.cdpConnected, true);
    assert.equal(health.cdpTargets, 0);
  } finally {
    await runtime.stop();
    await new Promise((resolve) => discovery.close(resolve));
  }
});

test("native tasks count without credits and later merge delayed credit deltas", async () => {
  const directory = mkdtempSync(join(tmpdir(), "trae-monitor-native-test-"));
  const runtime = await startUsageRuntime({
    dbPath: join(directory, "usage.db"),
    cdpPort: 65534,
    dashboardPort: 0,
    version: "1.4.1"
  });
  try {
    const baseline = { used: 10, remaining: 90, reason: "baseline", observedAt: "2026-09-02T00:00:00.000Z" };
    await fetch(`${runtime.dashboardUrl}/api/native-snapshot`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(baseline)
    });
    const task = { taskId: "task-1", model: "Coding Plan Model", promptTokens: 12,
      completionTokens: 3, totalTokens: 15, cachedTokens: 8 };
    await fetch(`${runtime.dashboardUrl}/api/native-task`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(task)
    });
    await fetch(`${runtime.dashboardUrl}/api/native-task`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(task)
    });
    const first = await fetch(`${runtime.dashboardUrl}/api/native-snapshot`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ used: 10.25, remaining: 89.75, reason: "settlement", taskId: "task-1" })
    }).then((response) => response.json());
    const duplicate = await fetch(`${runtime.dashboardUrl}/api/native-snapshot`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ used: 10.25, remaining: 89.75, reason: "settlement", taskId: "task-1" })
    }).then((response) => response.json());
    const secondWindowBaseline = await fetch(`${runtime.dashboardUrl}/api/native-snapshot`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ used: 50, remaining: 50, reason: "baseline" })
    }).then((response) => response.json());
    const health = await fetch(`${runtime.dashboardUrl}/api/health`).then((response) => response.json());
    assert.equal(first.recorded, true);
    assert.equal(duplicate.recorded, false);
    assert.equal(secondWindowBaseline.recorded, false);
    assert.equal(runtime.state.nativeCreditsUsed, 10.25);
    assert.equal(runtime.store.summary().total.calls, 1);
    assert.equal(runtime.store.summary().total.total_tokens, 15);
    assert.equal(runtime.store.summary().total.actual_credits, 0.25);
    assert.equal(health.nativeAvailable, true);
    assert.equal(health.mode, "native");
  } finally {
    await runtime.stop();
  }
});
