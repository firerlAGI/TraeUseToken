const path = require("node:path");

function workspaceArgument({ workspaceFile, workspaceFolders = [] } = {}) {
  if (workspaceFile) return workspaceFile;
  return workspaceFolders[0] || null;
}

function relaunchSpec({ platform, port, workspaceFile, workspaceFolders, env = {} }) {
  const workspace = workspaceArgument({ workspaceFile, workspaceFolders });
  const appArgs = [`--remote-debugging-port=${port}`];
  if (workspace) appArgs.push(workspace);

  if (platform === "darwin") {
    return { command: "/usr/bin/open", args: ["-na", "TRAE CN", "--args", ...appArgs] };
  }
  if (platform === "win32") {
    const roots = [env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, "Programs"), env.ProgramFiles, env["ProgramFiles(x86)"]]
      .filter(Boolean);
    const candidates = roots.flatMap((root) => [
      path.win32.join(root, "TRAE CN", "TRAE CN.exe"),
      path.win32.join(root, "Trae", "Trae.exe")
    ]);
    return { candidates, args: appArgs };
  }
  return { command: "trae-cn", args: appArgs };
}

module.exports = { relaunchSpec, workspaceArgument };
