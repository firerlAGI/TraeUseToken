import { CdpConnection } from "../src/cdp.mjs";
import { isTraeReplyTarget } from "../src/reply-usage.mjs";
import { parseResponseBody } from "../src/usage.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

const [port, titlePart, mode, dbPath] = process.argv.slice(2);
if (!/^\d{4,5}$/u.test(port ?? "") || port === "9222" || !titlePart) {
  throw new Error("Usage: node scripts/scan-loaded-trae-history.mjs <isolated CDP port> <window title> [--sidebar [lab database]]");
}

const listResponse = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
if (!listResponse.ok) throw new Error(`CDP discovery returned HTTP ${listResponse.status}`);
const targets = (await listResponse.json()).filter((target) =>
  isTraeReplyTarget(target) && target.title.includes(titlePart) && target.webSocketDebuggerUrl);
if (targets.length !== 1) throw new Error(`Expected one isolated chat window, found ${targets.length}`);

const cdp = await new CdpConnection(targets[0].webSocketDebuggerUrl).connect();
const db = dbPath ? new DatabaseSync(dbPath, { readOnly: true }) : null;
const findBill = db?.prepare("SELECT total_tokens FROM calls WHERE billing_id = ? AND instr(',' || source || ',', ',billing,') > 0 LIMIT 1");
const billRequests = new Map();
const billOutcomes = new Map();

function watchBillResponses() {
  cdp.on("Network.requestWillBeSent", ({ requestId, request }) => {
    if (request.method !== "POST" || !request.url.includes("/api/v1/commercial/get_session_usage")) return;
    try {
      const { session_id: id } = JSON.parse(request.postData);
      if (!id) return;
      billRequests.set(requestId, id);
      if (!billOutcomes.has(id)) billOutcomes.set(id, "requested");
    } catch { /* Ignore requests without a usable turn ID. */ }
  });
  cdp.on("Network.loadingFailed", ({ requestId }) => billRequests.delete(requestId));
  cdp.on("Network.loadingFinished", async ({ requestId }) => {
    const id = billRequests.get(requestId);
    if (!id) return;
    billRequests.delete(requestId);
    try {
      const { body, base64Encoded } = await cdp.send("Network.getResponseBody", { requestId });
      const text = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
      if (parseResponseBody(text).some((entry) => entry.sessionId === id && entry.totalTokens > 0)) {
        billOutcomes.set(id, "token-response");
        return;
      }
      const payload = JSON.parse(text);
      const bill = payload.data?.user_usage_group_by_session ?? payload.user_usage_group_by_session;
      const usage = typeof bill?.extra_info === "string" ? JSON.parse(bill.extra_info) : bill?.extra_info;
      if (!bill?.session_id && usage?.input_token === 0 && usage?.output_token === 0) {
        if (billOutcomes.get(id) !== "token-response") billOutcomes.set(id, "empty-bill");
      }
    } catch { /* Leave the request marked as observed without usable data. */ }
  });
}

function requestBill(session, id, physical = false) {
  const chats = [...document.querySelectorAll(".virtualized-message-list-view[data-session-id]")];
  const chat = chats.find((element) => element.dataset.sessionId === session &&
    element.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }));
  const turn = [...(chat?.querySelectorAll(".turn[data-turn-id]") ?? [])].find((element) => element.dataset.turnId === id);
  const control = turn?.querySelector(".max-context-usage-rate-container") ??
    turn?.querySelector(".turn__agent-message:has(.latest-assistant-bar)");
  if (!control) return false;
  if (physical) {
    control.scrollIntoView({ block: "center" });
    const rect = control.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = Math.min(innerHeight - 10, rect.y + rect.height / 2);
    return control.contains(document.elementFromPoint(x, y)) ? { x, y } : false;
  }
  control.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, view: window }));
  setTimeout(() => control.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, view: window })), 600);
  return true;
}

async function fillMissingBill(session, id) {
  const { result } = await cdp.send("Runtime.evaluate", {
    expression: `(${requestBill})(${JSON.stringify(session)}, ${JSON.stringify(id)})`,
    returnByValue: true, timeout: 1000
  });
  if (result?.value) await delay(750);
  if (!result?.value || !billOutcomes.has(id)) {
    const point = await cdp.send("Runtime.evaluate", {
      expression: `(${requestBill})(${JSON.stringify(session)}, ${JSON.stringify(id)}, true)`,
      returnByValue: true, timeout: 1000
    });
    if (point.result?.value) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point.result.value });
      await delay(1500);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
    }
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    if (findBill.get(id)?.total_tokens > 0 || billOutcomes.get(id) === "empty-bill") return;
    await delay(500);
  }
}

function inspectChat(expectedSession, nextTop) {
  const scrollers = [...document.querySelectorAll(".virtualized-message-list-view__scroller")]
    .filter((element) => element.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }) && element.clientHeight > 0);
  if (scrollers.length !== 1) return null;
  const scroller = scrollers[0];
  const session = scroller.closest("[data-session-id]")?.dataset.sessionId;
  if (!session || (expectedSession && session !== expectedSession)) return null;
  if (nextTop !== null) scroller.scrollTop = nextTop;
  return {
    session,
    top: scroller.scrollTop,
    height: scroller.scrollHeight,
    viewport: scroller.clientHeight,
    rows: [...scroller.querySelectorAll("[data-item-index]")].map((row) => ({
      index: Number(row.dataset.itemIndex),
      id: row.querySelector(".turn[data-turn-id]")?.dataset.turnId,
      billable: Boolean(row.querySelector(".latest-assistant-bar"))
    }))
  };
}

async function inspect(session = null, top = null) {
  const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
    expression: `(${inspectChat})(${JSON.stringify(session)}, ${JSON.stringify(top)})`,
    returnByValue: true,
    timeout: 1000
  });
  if (exceptionDetails || !result.value) throw new Error("The isolated chat changed or has multiple visible lists");
  return result.value;
}

async function scanChat() {
  const start = await inspect();
  try {
    const rows = new Map();
    let missingInitially = 0;
    let previous = "";
    let quietAtTopSince = null;
    for (let step = 0; step < 120; step++) {
      const page = await inspect(start.session);
      for (const row of page.rows) {
        if (!row.id) continue;
        const previousRow = rows.get(row.id);
        rows.set(row.id, row);
        if (findBill && row.billable && !previousRow?.billable && !(findBill.get(row.id)?.total_tokens > 0)) {
          missingInitially++;
          await fillMissingBill(start.session, row.id);
        }
      }
      const signature = JSON.stringify([page.top, page.height, page.rows]);
      quietAtTopSince = page.top <= 1 && signature === previous ? (quietAtTopSince ?? Date.now()) : null;
      if (quietAtTopSince !== null && Date.now() - quietAtTopSince >= 2500) break;
      previous = signature;
      await inspect(start.session, Math.max(0, page.top - Math.max(1, Math.floor(page.viewport * 0.7))));
      await delay(450);
    }
    const indices = [...new Set([...rows.values()].map(({ index }) => index))].sort((a, b) => a - b);
    const billable = [...rows.values()].filter((row) => row.billable);
    const missing = findBill ? billable.filter(({ id }) => !(findBill.get(id)?.total_tokens > 0)) : [];
    return {
      session: start.session,
      initiallyMounted: start.rows.filter(({ id }) => id).length,
      discoveredTurns: rows.size,
      billableTurns: billable.length,
      ...(findBill ? {
        missingInitially,
        confirmedBills: billable.length - missing.length,
        emptyBillResponses: missing.filter(({ id }) => billOutcomes.get(id) === "empty-bill").length,
        requestsWithoutUsableResponse: missing.filter(({ id }) => billOutcomes.get(id) === "requested").length,
        tokenResponsesNotSaved: missing.filter(({ id }) => billOutcomes.get(id) === "token-response").length,
        noRequestObserved: missing.filter(({ id }) => !billOutcomes.has(id)).length
      } : {}),
      reachedStableTop: quietAtTopSince !== null && Date.now() - quietAtTopSince >= 2500,
      consecutiveIndices: indices[0] === 0 && indices.every((index, position) => index === position)
    };
  } finally {
    await inspect(start.session, start.top);
  }
}

function sidebarState(select) {
  const tasks = [...document.querySelectorAll(".task-list .taskItem")]
    .filter((task) => task.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }));
  if (select !== null) tasks[select]?.click();
  const lists = [...document.querySelectorAll(".virtualized-message-list-view[data-session-id]")]
    .filter((list) => list.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }));
  return {
    count: tasks.length,
    selected: tasks.findIndex((task) => task.classList.contains("taskItemSelected")),
    session: lists.length === 1 ? lists[0].dataset.sessionId : null
  };
}

async function sidebar(select = null) {
  const { result } = await cdp.send("Runtime.evaluate", {
    expression: `(${sidebarState})(${JSON.stringify(select)})`, returnByValue: true, timeout: 1000
  });
  return result.value;
}

async function scanSidebar() {
  const start = await sidebar();
  if (!start?.count || start.selected < 0) throw new Error("Select a task in the isolated Agent sidebar first");
  const results = [];
  let previous = start.session;
  try {
    for (let i = 0; i < start.count; i++) {
      await sidebar(i);
      let current;
      for (let attempt = 0; attempt < 24; attempt++) {
        await delay(250);
        current = await sidebar();
        if (current.selected === i && current.session && (current.session !== previous || i === start.selected && results.length === 0)) break;
      }
      if (current.selected !== i || !current.session || (current.session === previous && !(i === start.selected && results.length === 0))) {
        throw new Error(`Could not verify the chat behind sidebar item ${i + 1}`);
      }
      const result = await scanChat();
      if (result.session !== current.session) throw new Error("The selected task changed during the scan");
      previous = result.session;
      results.push(result);
    }
    return results;
  } finally {
    await sidebar(start.selected);
  }
}

try {
  if (findBill) {
    watchBillResponses();
    await cdp.send("Network.enable", { maxTotalBufferSize: 50_000_000, maxResourceBufferSize: 10_000_000 });
  }
  const results = mode === "--sidebar" ? await scanSidebar() : [await scanChat()];
  console.log(JSON.stringify({ distinctSessions: new Set(results.map(({ session }) => session)).size,
    conversations: results.map(({ session, ...stats }) => stats) }, null, 2));
} finally {
  db?.close();
  cdp.close();
}
