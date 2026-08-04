const { spawn } = require("node:child_process");

function encodeLaunchPayload(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeLaunchPayload(encoded) {
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (!Number.isInteger(payload.parentPid) || payload.parentPid <= 0) throw new Error("invalid parent PID");
  if (typeof payload.command !== "string" || !payload.command) throw new Error("invalid command");
  if (!Array.isArray(payload.args) || payload.args.some((value) => typeof value !== "string")) {
    throw new Error("invalid arguments");
  }
  return payload;
}

function applicationEnvironment(source = process.env) {
  const env = { ...source };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VSCODE_IPC_HOOK_CLI;
  return env;
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForProcessExit(pid, { interval = 200, timeout = 30000 } = {}) {
  const deadline = Date.now() + timeout;
  while (processIsRunning(pid)) {
    if (Date.now() >= deadline) throw new Error("TRAE did not exit before relaunch timeout");
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

async function relaunchAfterExit(payload) {
  await waitForProcessExit(payload.parentPid);
  // The extension host exits slightly before Electron releases its Windows
  // single-instance lock. Starting immediately can make the replacement
  // process forward its arguments to the dying instance and then disappear.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const child = spawn(payload.command, payload.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    env: applicationEnvironment()
  });
  child.unref();
}

if (require.main === module) {
  Promise.resolve()
    .then(() => decodeLaunchPayload(process.argv[2] || ""))
    .then(relaunchAfterExit)
    .catch(() => { process.exitCode = 1; });
}

module.exports = {
  applicationEnvironment,
  decodeLaunchPayload,
  encodeLaunchPayload,
  processIsRunning,
  relaunchAfterExit,
  waitForProcessExit
};
