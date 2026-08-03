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
