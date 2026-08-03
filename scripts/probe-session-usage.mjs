#!/usr/bin/env node
import { CdpConnection } from "../src/cdp.mjs";

const port = Number(process.argv[2] || 9222);
const timeoutMs = Number(process.argv[3] || 20_000);
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
const page = targets.find((target) => target.type === "page" && target.url?.includes("workbench.html"));
if (!page) throw new Error("TRAE workbench target not found");

const cdp = await new CdpConnection(page.webSocketDebuggerUrl).connect();
await cdp.send("Network.enable", { maxTotalBufferSize: 10_000_000, maxResourceBufferSize: 2_000_000 });
await cdp.send("Page.enable");

const requests = new Map();
const observations = [];

cdp.on("Network.requestWillBeSent", ({ requestId, request }) => {
  if (!request.url.includes("/api/v1/commercial/get_session_usage")) return;
  let payload = null;
  try { payload = JSON.parse(request.postData || "null"); } catch { payload = request.postData || null; }
  requests.set(requestId, { endpoint: request.url, payload });
});

cdp.on("Network.responseReceived", ({ requestId, response }) => {
  const request = requests.get(requestId);
  if (request) request.status = response.status;
});

cdp.on("Network.loadingFinished", async ({ requestId }) => {
  const request = requests.get(requestId);
  if (!request) return;
  requests.delete(requestId);
  let response = null;
  try {
    const result = await cdp.send("Network.getResponseBody", { requestId });
    const text = result.base64Encoded ? Buffer.from(result.body, "base64").toString("utf8") : result.body;
    response = JSON.parse(text);
  } catch (error) {
    response = { error: error.message };
  }
  const group = response?.data?.user_usage_group_by_session ?? response?.user_usage_group_by_session;
  const observation = {
    endpoint: request.endpoint,
    request: request.payload,
    status: request.status,
    credits_float: group?.credits_float ?? null,
    response
  };
  observations.push(observation);
  console.log(JSON.stringify(observation));
});

await cdp.send("Page.reload", { ignoreCache: true });
await new Promise((resolve) => setTimeout(resolve, timeoutMs));
console.error(`Captured ${observations.length} get_session_usage response(s).`);
cdp.close();
