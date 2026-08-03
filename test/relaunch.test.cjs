const test = require("node:test");
const assert = require("node:assert/strict");
const { relaunchSpec, workspaceArgument } = require("../extension/relaunch.cjs");

test("prefers a workspace file and preserves a folder fallback", () => {
  assert.equal(workspaceArgument({ workspaceFile: "/tmp/project.code-workspace", workspaceFolders: ["/tmp/project"] }),
    "/tmp/project.code-workspace");
  assert.equal(workspaceArgument({ workspaceFolders: ["/tmp/project"] }), "/tmp/project");
});

test("builds a macOS one-click TRAE relaunch without a shell", () => {
  assert.deepEqual(relaunchSpec({ platform: "darwin", port: 9222, workspaceFolders: ["/tmp/project"] }), {
    command: "/usr/bin/open",
    args: ["-na", "TRAE CN", "--args", "--remote-debugging-port=9222", "/tmp/project"]
  });
});

test("builds Windows executable candidates from standard install roots", () => {
  const spec = relaunchSpec({ platform: "win32", port: 9333, env: { LOCALAPPDATA: "C:\\Users\\fire\\AppData\\Local" } });
  assert.equal(spec.candidates[0], "C:\\Users\\fire\\AppData\\Local\\Programs\\TRAE CN\\TRAE CN.exe");
  assert.deepEqual(spec.args, ["--remote-debugging-port=9333"]);
});
