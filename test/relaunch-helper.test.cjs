const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applicationEnvironment,
  decodeLaunchPayload,
  encodeLaunchPayload,
  processIsRunning,
  waitForProcessExit
} = require("../extension/relaunch-helper.cjs");

test("round-trips a Windows relaunch payload without shell quoting", () => {
  const payload = {
    parentPid: 1234,
    command: "D:\\Program Files\\Trae CN\\Trae CN.exe",
    args: ["--remote-debugging-port=9222", "D:\\项目 空格"]
  };
  assert.deepEqual(decodeLaunchPayload(encodeLaunchPayload(payload)), payload);
});

test("removes helper-only Electron and CLI variables from the relaunched app", () => {
  assert.deepEqual(applicationEnvironment({
    ELECTRON_RUN_AS_NODE: "1",
    VSCODE_IPC_HOOK_CLI: "pipe",
    USERPROFILE: "C:\\Users\\fire"
  }), { USERPROFILE: "C:\\Users\\fire" });
});

test("detects the current process and resolves immediately for an exited process", async () => {
  assert.equal(processIsRunning(process.pid), true);
  await waitForProcessExit(2147483647, { interval: 1, timeout: 20 });
});

test("rejects malformed relaunch payloads", () => {
  assert.throws(() => decodeLaunchPayload(encodeLaunchPayload({ parentPid: 0, command: "", args: [] })));
});
