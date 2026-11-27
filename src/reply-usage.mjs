const workbenchPath = /\/vs\/code\/electron-browser\/(?:workbench\/workbench|solo\/solo-lite)\.html$/u;
const retryDelay = 15000;
const maxAttempts = 3;

export function isTraeReplyTarget(target) {
  const url = URL.parse(target.url || "");
  return target.type === "page" && url?.protocol === "vscode-file:" &&
    url.hostname === "vscode-app" && workbenchPath.test(url.pathname);
}

// Run inside the local TRAE workbench. Read reply identifiers and the existing
// usage control only. TRAE performs its own authenticated billing lookup.
function inspectReplies(trigger) {
  if (location.protocol !== "vscode-file:" || location.hostname !== "vscode-app") return [];
  const replies = [];
  for (const list of document.querySelectorAll(".virtualized-message-list-view[data-session-id]")) {
    const session = list.dataset.sessionId;
    if (!session || !list.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) continue;
    const turn = list.querySelector(".turn.turn--last[data-turn-id]");
    const id = turn?.dataset.turnId ?? null;
    const control = turn?.querySelector(".latest-assistant-bar .max-context-usage-rate-container");
    const ready = Boolean(control?.getBoundingClientRect().width);
    if (trigger?.session === session) {
      if (!trigger.historical && trigger.id === id && ready) return requestUsage(control);
      if (trigger.historical) {
        if (trigger.id === id && ready) return requestUsage(control);
        for (const previous of list.querySelectorAll(".turn[data-turn-id]")) {
          if (previous.dataset.turnId !== trigger.id) continue;
          const message = previous.querySelector(".turn__agent-message:has(.latest-assistant-bar)");
          if (message?.getClientRects().length) return requestUsage(message);
        }
      }
    }
    const historical = [...list.querySelectorAll(".turn[data-turn-id]:has(.latest-assistant-bar)")]
      .filter((item) => item !== turn || ready)
      .map((item) => item.dataset.turnId);
    replies.push({ session, id, ready, historical });
  }
  return trigger ? false : replies;

  function requestUsage(element) {
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, view: window }));
    setTimeout(() => element.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, view: window })), 400);
    return true;
  }
}

export class ReplyUsageWatcher {
  constructor(cdp, { claimHistoryLookup, hasBilling = () => false, now = Date.now } = {}) {
    this.cdp = cdp;
    this.sessions = new Map();
    this.attempts = new Map();
    this.claimHistoryLookup = claimHistoryLookup;
    this.hasBilling = hasBilling;
    this.now = now;
  }

  async evaluate(trigger = null) {
    const { result, exceptionDetails } = await this.cdp.send("Runtime.evaluate", {
      expression: `(${inspectReplies})(${JSON.stringify(trigger)})`,
      returnByValue: true,
      timeout: 1000
    });
    return exceptionDetails ? null : result?.value;
  }

  async poll() {
    const replies = await this.evaluate();
    if (!Array.isArray(replies)) return;
    let newReplyPending = false;
    for (const reply of replies) {
      const { session, id, ready } = reply;
      let state = this.sessions.get(session);
      if (!state) {
        // Opening a historical conversation should not look like a new turn.
        state = { id, baseline: ready };
        this.sessions.set(session, state);
        if (this.sessions.size > 256) this.sessions.delete(this.sessions.keys().next().value);
      } else if (state.id !== id) {
        state.id = id;
        state.baseline = false;
      }
      if (id && ready && !state.baseline && this.canRequest(id)) {
        newReplyPending = true;
        await this.request({ session, id });
      } else if (id && !ready && !state.baseline && !this.attempts.has(id)) {
        newReplyPending = true;
      }
    }
    if (!newReplyPending) await this.backfill(replies);
  }

  canRequest(id) {
    const attempt = this.attempts.get(id);
    return (!attempt || (attempt.count < maxAttempts && this.now() >= attempt.retryAt)) && !this.hasBilling(id);
  }

  async request(trigger) {
    const { id } = trigger;
    if (await this.evaluate(trigger) !== true) return;
    this.attempts.set(id, { count: (this.attempts.get(id)?.count ?? 0) + 1, retryAt: this.now() + retryDelay });
    if (this.attempts.size > 2048) this.attempts.delete(this.attempts.keys().next().value);
  }

  async backfill(replies) {
    if (!this.claimHistoryLookup) return;
    for (const { session, historical = [] } of replies) {
      const id = historical.find((item) => item && this.canRequest(item));
      if (!id) continue;
      if (!this.claimHistoryLookup()) return;
      await this.request({ session, id, historical: true });
      return;
    }
  }
}
