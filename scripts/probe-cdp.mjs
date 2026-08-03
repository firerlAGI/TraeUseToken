#!/usr/bin/env node
import { CdpConnection } from "../src/cdp.mjs";

const port = Number(process.argv[2] || 9222);
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const needles = ["reportTokenUsage", "token_usage", "prompt_tokens", "cached_tokens", "fee_usage"];

for (const target of targets) {
  if (!target.webSocketDebuggerUrl) continue;
  const cdp = await new CdpConnection(target.webSocketDebuggerUrl).connect();
  const scripts = new Map();
  cdp.on("Debugger.scriptParsed", (script) => scripts.set(script.scriptId, script));
  try {
    await cdp.send("Debugger.enable", { maxScriptsCacheSize: 100_000_000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const candidates = [...scripts.values()].filter((script) => !script.isLiveEdit && (script.length ?? 0) < 40_000_000);
    const matches = [];
    for (const script of candidates) {
      let source;
      try { source = (await cdp.send("Debugger.getScriptSource", { scriptId: script.scriptId })).scriptSource || ""; } catch { continue; }
      const found = needles.filter((needle) => source.includes(needle));
      if (found.length) matches.push({ url: script.url || "(anonymous)", length: source.length, found });
    }
    console.log(JSON.stringify({ target: { id: target.id, type: target.type, title: target.title }, scriptCount: scripts.size, matches }, null, 2));
  } finally {
    try { await cdp.send("Debugger.disable"); } catch { /* Target may close. */ }
    cdp.close();
  }
}
