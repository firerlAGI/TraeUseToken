const path = require("node:path");

function workspaceArgument({ workspaceFile, workspaceFolders = [] } = {}) {
  if (workspaceFile) return workspaceFile;
  return workspaceFolders[0] || null;
}

function windowsExecutableCandidates({ env = {}, execPath, appRoot, storedExecutable } = {}) {
  const candidates = [];
  const seen = new Set();
  const add = (candidate) => {
    if (!candidate) return;
    const key = candidate.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };
  const addExecutables = (root) => {
    if (!root) return;
    add(path.win32.join(root, "Trae CN.exe"));
    add(path.win32.join(root, "TRAE CN.exe"));
    add(path.win32.join(root, "Trae.exe"));
  };

  add(storedExecutable);
  if (/^trae(?: cn)?\.exe$/i.test(path.win32.basename(execPath || ""))) add(execPath);

  // vscode.env.appRoot normally points to <install>\resources\app. This is the
  // most reliable way to support custom locations such as D:\Trae CN.
  if (appRoot) addExecutables(path.win32.resolve(appRoot, "..", ".."));

  const roots = [
    env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, "Programs"),
    env.LOCALAPPDATA,
    env.ProgramW6432,
    env.ProgramFiles,
    env["ProgramFiles(x86)"]
  ].filter(Boolean);
  for (const root of roots) {
    addExecutables(path.win32.join(root, "Trae CN"));
    addExecutables(path.win32.join(root, "TRAE CN"));
    addExecutables(path.win32.join(root, "Trae"));
  }
  return candidates;
}

function relaunchSpec({ platform, port, workspaceFile, workspaceFolders, env = {}, execPath, appRoot, storedExecutable }) {
  const workspace = workspaceArgument({ workspaceFile, workspaceFolders });
  const appArgs = [`--remote-debugging-port=${port}`];
  if (workspace) appArgs.push(workspace);

  if (platform === "darwin") {
    return { command: "/usr/bin/open", args: ["-na", "TRAE CN", "--args", ...appArgs] };
  }
  if (platform === "win32") {
    const candidates = windowsExecutableCandidates({ env, execPath, appRoot, storedExecutable });
    return { candidates, args: appArgs };
  }
  return { command: "trae-cn", args: appArgs };
}

module.exports = { relaunchSpec, windowsExecutableCandidates, workspaceArgument };
