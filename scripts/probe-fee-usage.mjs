#!/usr/bin/env node
import { CdpConnection } from "../src/cdp.mjs";

const port = Number(process.argv[2] || 9222);
const timeoutMs = Number(process.argv[3] || 120000);
const mode = process.argv[4] || "stream";
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const page = targets.find((target) => target.type === "page" && target.url?.includes("workbench.html"));
if (!page) throw new Error("TRAE workbench CDP target not found");

const cdp = await new CdpConnection(page.webSocketDebuggerUrl).connect();
const scripts = new Map();
cdp.on("Debugger.scriptParsed", (script) => scripts.set(script.scriptId, script));

async function valueOf(remote, depth = 0, seen = new Set()) {
  if (!remote) return null;
  if (Object.hasOwn(remote, "value")) return remote.value;
  if (!remote.objectId || depth > 5 || seen.has(remote.objectId)) return remote.description ?? null;
  seen.add(remote.objectId);
  const properties = await cdp.send("Runtime.getProperties", { objectId: remote.objectId, ownProperties: true });
  const result = {};
  for (const property of (properties.result ?? []).slice(0, 100)) {
    if (!property.value || property.name === "__proto__") continue;
    result[property.name] = await valueOf(property.value, depth + 1, seen);
  }
  return result;
}

async function localArguments(frame) {
  const scope = frame.scopeChain?.find((candidate) => candidate.type === "local");
  if (!scope) return {};
  const properties = await cdp.send("Runtime.getProperties", { objectId: scope.object.objectId, ownProperties: true });
  const output = {};
  for (const property of properties.result ?? []) {
    if (!["e", "t"].includes(property.name) || !property.value) continue;
    output[property.name] = await valueOf(property.value, property.name === "t" ? 4 : 0);
  }
  return output;
}

await cdp.send("Runtime.enable");
await cdp.send("Debugger.enable", { maxScriptsCacheSize: 100_000_000 });
await new Promise((resolve) => setTimeout(resolve, 500));
const script = [...scripts.values()].find((candidate) => candidate.url?.endsWith("/@byted-icube/ai-modules-chat/dist/index.mjs") || candidate.url?.endsWith("/ai-modules-chat/dist/index.mjs"));
if (!script) throw new Error("ai-modules-chat index.mjs was not loaded");
const { scriptSource } = await cdp.send("Debugger.getScriptSource", { scriptId: script.scriptId });
const markers = {
  stream: 'handleSteamingResult(e,t){t.agentMessageId&&("max_mode_usage"===e.type?this.storeService.updateMessage',
  history: 'let i=Symbol("IFeeUsageParser");class o{parse(e){return{...e}}}'
};
const marker = markers[mode];
if (!marker) throw new Error(`Unknown probe mode: ${mode}`);
const markerIndex = scriptSource.indexOf(marker);
if (markerIndex < 0) throw new Error("fee_usage stream parser marker not found");
const bodyIndex = mode === "history"
  ? markerIndex + marker.indexOf("return{...e}")
  : markerIndex + "handleSteamingResult(e,t){".length;
const prefix = scriptSource.slice(0, bodyIndex);
const lineNumber = (prefix.match(/\n/gu) ?? []).length;
const columnNumber = bodyIndex - prefix.lastIndexOf("\n") - 1;
const breakpoint = mode === "history"
  ? await cdp.send("Debugger.setBreakpointByUrl", { url: script.url, lineNumber, columnNumber })
  : await cdp.send("Debugger.setBreakpoint", { location: { scriptId: script.scriptId, lineNumber, columnNumber } });
console.log(JSON.stringify({ ready: true, mode, url: script.url, lineNumber: lineNumber + 1, columnNumber,
  breakpointId: breakpoint.breakpointId, actualLocation: breakpoint.actualLocation, locations: breakpoint.locations }));

let finish;
const captured = new Promise((resolve) => { finish = resolve; });
const timer = setTimeout(() => finish({ timeout: true }), timeoutMs);
cdp.on("Debugger.paused", async ({ callFrames, reason, hitBreakpoints = [] }) => {
  if (!hitBreakpoints.includes(breakpoint.breakpointId)) {
    try { await cdp.send("Debugger.resume"); } catch { /* Another debugger may already resume. */ }
    return;
  }
  try {
    const frame = callFrames?.[0];
    if (!frame) return;
    const locals = await localArguments(frame);
    console.log(JSON.stringify({ captured: true, reason, functionName: frame.functionName, locals }, null, 2));
    finish({ captured: true });
  } catch (error) {
    console.error(error);
    finish({ error: error.message });
  } finally {
    try { await cdp.send("Debugger.resume"); } catch { /* Target may have closed. */ }
  }
});

const result = await captured;
clearTimeout(timer);
try { await cdp.send("Debugger.disable"); } catch { /* Target may have closed. */ }
cdp.close();
if (!result.captured) process.exitCode = 1;
