import { EventEmitter } from "node:events";
import { parseResponseBody, extractUsageEvents } from "./usage.mjs";

export class CdpConnection extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP connection timed out: ${this.url}`)), 5000);
      this.socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error(`CDP connection failed: ${this.url}`)); }, { once: true });
    });
    this.socket.addEventListener("message", (message) => this.#onMessage(message.data));
    this.socket.addEventListener("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("CDP connection closed"));
      this.pending.clear();
      this.emit("close");
    });
    return this;
  }

  #onMessage(data) {
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (message.method) this.emit(message.method, message.params ?? {});
  }

  send(method, params = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("CDP is not connected"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() { this.socket?.close(); }
}

async function remoteObjectValue(cdp, remote, depth = 0, visited = new Set()) {
  if (!remote) return null;
  if (Object.hasOwn(remote, "value")) return remote.value;
  if (remote.unserializableValue) return remote.unserializableValue;
  if (!remote.objectId || depth > 4 || visited.has(remote.objectId)) return remote.description ?? null;
  visited.add(remote.objectId);
  let properties;
  try {
    properties = await cdp.send("Runtime.getProperties", {
      objectId: remote.objectId,
      ownProperties: true,
      accessorPropertiesOnly: false,
      generatePreview: false
    });
  } catch { return remote.description ?? null; }
  const result = {};
  for (const property of (properties.result ?? []).slice(0, 100)) {
    if (!property.value || property.name === "__proto__") continue;
    result[property.name] = await remoteObjectValue(cdp, property.value, depth + 1, visited);
  }
  return result;
}

export class TargetCollector extends EventEmitter {
  constructor(target, options = {}) {
    super();
    this.target = target;
    this.options = options;
    this.requests = new Map();
    this.breakpoints = new Set();
    this.scanning = new Set();
  }

  async start() {
    this.cdp = await new CdpConnection(this.target.webSocketDebuggerUrl).connect();
    this.cdp.on("close", () => this.emit("close", this.target.id));
    this.cdp.on("Network.responseReceived", (params) => this.#responseReceived(params));
    this.cdp.on("Network.loadingFinished", (params) => void this.#loadingFinished(params));
    this.cdp.on("Network.loadingFailed", ({ requestId }) => this.requests.delete(requestId));
    this.cdp.on("Debugger.scriptParsed", (params) => void this.#scriptParsed(params));
    this.cdp.on("Debugger.paused", (params) => void this.#paused(params));
    await this.cdp.send("Runtime.enable");
    await this.cdp.send("Network.enable", { maxTotalBufferSize: 50_000_000, maxResourceBufferSize: 10_000_000 });
    if (this.options.debugger !== false) await this.cdp.send("Debugger.enable", { maxScriptsCacheSize: 50_000_000 });
    return this;
  }

  #responseReceived({ requestId, response, type }) {
    if (!["Fetch", "XHR", "EventSource", "Other"].includes(type)) return;
    this.requests.set(requestId, {
      url: response.url,
      mimeType: response.mimeType,
      status: response.status,
      type
    });
  }

  async #loadingFinished({ requestId, encodedDataLength }) {
    const meta = this.requests.get(requestId);
    this.requests.delete(requestId);
    if (!meta || encodedDataLength > 10_000_000 || meta.status >= 400) return;
    let result;
    try { result = await this.cdp.send("Network.getResponseBody", { requestId }); } catch { return; }
    let body = result.body ?? "";
    if (result.base64Encoded) {
      try { body = Buffer.from(body, "base64").toString("utf8"); } catch { return; }
    }
    for (const usage of parseResponseBody(body)) {
      const isBilling = meta.url.includes("/api/v1/commercial/get_session_usage");
      this.emit("usage", {
        ...usage,
        source: isBilling ? "billing" : "network",
        billingId: isBilling ? usage.sessionId : undefined,
        userMessageId: isBilling ? usage.sessionId : usage.userMessageId,
        targetId: this.target.id,
        requestId,
        endpoint: meta.url
      });
    }
  }

  async #scriptParsed({ scriptId, url }) {
    if (!url || this.scanning.has(scriptId)) return;
    if (!/(?:workbench|trae|extensionHost|main).*\.[cm]?js(?:\?|$)/iu.test(url)) return;
    this.scanning.add(scriptId);
    try {
      const { scriptSource = "" } = await this.cdp.send("Debugger.getScriptSource", { scriptId });
      let from = 0;
      for (let count = 0; count < 5; count++) {
        const index = scriptSource.indexOf("reportTokenUsage", from);
        if (index < 0) break;
        from = index + 16;
        const before = scriptSource.slice(0, index);
        const lineNumber = (before.match(/\n/gu) ?? []).length;
        const lastNewline = before.lastIndexOf("\n");
        const columnNumber = index - lastNewline - 1;
        const key = `${scriptId}:${lineNumber}:${columnNumber}`;
        if (this.breakpoints.has(key)) continue;
        try {
          await this.cdp.send("Debugger.setBreakpoint", { location: { scriptId, lineNumber, columnNumber } });
          this.breakpoints.add(key);
          this.emit("diagnostic", { type: "breakpoint", url, lineNumber, columnNumber });
        } catch { /* A network-only collector is still useful. */ }
      }
    } catch { /* Some internal scripts do not expose their source. */ }
  }

  async #paused({ callFrames, reason }) {
    try {
      const frame = callFrames?.[0];
      if (!frame) return;
      const collected = { functionName: frame.functionName, reason };
      const localScope = (frame.scopeChain ?? []).find((scope) => scope.type === "local");
      if (localScope) collected.local = await remoteObjectValue(this.cdp, localScope.object);
      for (const usage of extractUsageEvents(collected)) {
        this.emit("usage", {
          ...usage,
          source: "debugger",
          targetId: this.target.id
        });
      }
    } finally {
      try { await this.cdp.send("Debugger.resume"); } catch { /* Target may have closed. */ }
    }
  }

  close() { this.cdp?.close(); }
}

export class TraeMonitor extends EventEmitter {
  constructor({ host = "127.0.0.1", port = 9222, debugger: debuggerEnabled = true } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.debuggerEnabled = debuggerEnabled;
    this.collectors = new Map();
    this.running = false;
  }

  async discover() {
    const response = await fetch(`http://${this.host}:${this.port}/json/list`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error(`CDP discovery returned HTTP ${response.status}`);
    return response.json();
  }

  async poll() {
    let targets;
    try {
      targets = await this.discover();
      this.emit("status", { connected: true, targetCount: targets.length });
    } catch (error) {
      this.emit("status", { connected: false, targetCount: 0, error: error.message });
      return;
    }
    const eligibleTypes = ["page", "webview", "background_page", "worker", "service_worker", "shared_worker"];
    const eligible = targets.filter((target) => target.webSocketDebuggerUrl && eligibleTypes.includes(target.type));
    const liveIds = new Set(eligible.map((target) => target.id));
    for (const [id, collector] of this.collectors) {
      if (!liveIds.has(id)) { collector.close(); this.collectors.delete(id); }
    }
    for (const target of eligible) {
      if (this.collectors.has(target.id)) continue;
      try {
        const collector = await new TargetCollector(target, { debugger: this.debuggerEnabled }).start();
        collector.on("usage", (usage) => this.emit("usage", usage));
        collector.on("diagnostic", (event) => this.emit("diagnostic", event));
        collector.on("close", () => this.collectors.delete(target.id));
        this.collectors.set(target.id, collector);
      } catch (error) {
        this.emit("diagnostic", { type: "target-error", targetId: target.id, error: error.message });
      }
    }
  }

  start() {
    this.running = true;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), 3000);
  }

  close() {
    this.running = false;
    clearInterval(this.timer);
    for (const collector of this.collectors.values()) collector.close();
    this.collectors.clear();
  }
}
