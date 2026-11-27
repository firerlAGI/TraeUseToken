import test from "node:test";
import assert from "node:assert/strict";
import { isTraeReplyTarget, ReplyUsageWatcher } from "../src/reply-usage.mjs";

test("only enables reply lookups in local TRAE workbench pages", () => {
  const path = "/vs/code/electron-browser/solo/solo-lite.html";
  assert.equal(isTraeReplyTarget({ type: "page", url: `vscode-file://vscode-app${path}` }), true);
  assert.equal(isTraeReplyTarget({ type: "page", url: `https://example.org${path}` }), false);
  assert.equal(isTraeReplyTarget({ type: "worker", url: `vscode-file://vscode-app${path}` }), false);
});

test("backfills loaded missing bills only when the rate limit allows and yields to new replies", async () => {
  let allowed = false;
  const watcher = new ReplyUsageWatcher(null, {
    hasBilling: (id) => id === "already-saved",
    claimHistoryLookup: () => allowed
  });
  const requests = [];
  const reply = { session: "a", id: "latest", ready: true, historical: ["already-saved", "missing"] };
  watcher.evaluate = async (trigger) => {
    if (!trigger) return [reply];
    requests.push(trigger);
    return true;
  };
  await watcher.poll();
  assert.deepEqual(requests, []);
  allowed = true;
  reply.id = "new";
  reply.ready = false;
  await watcher.poll();
  reply.ready = true;
  await watcher.poll();
  await watcher.poll();
  await watcher.poll();
  assert.deepEqual(requests, [
    { session: "a", id: "new" },
    { session: "a", id: "missing", historical: true }
  ]);
});

test("looks up the new reply once after its usage control appears", async () => {
  const watcher = new ReplyUsageWatcher(null);
  const requests = [];
  let replies;
  watcher.evaluate = async (trigger) => {
    if (!trigger) return replies;
    requests.push(trigger);
    return true;
  };
  for (const [session, id, ready] of [
    ["a", "old", true], ["a", "new", false], ["a", "new", true],
    ["a", "new", true], ["b", "another-old", true], ["c", null, false], ["c", "first", true]
  ]) {
    replies = [{ session, id, ready }];
    await watcher.poll();
  }
  assert.deepEqual(requests, [{ session: "a", id: "new" }, { session: "c", id: "first" }]);
});

test("retries a lookup without a saved bill and stops after confirmation", async () => {
  let now = 0;
  let saved = false;
  const watcher = new ReplyUsageWatcher(null, { now: () => now, hasBilling: () => saved });
  const reply = { session: "a", id: "old", ready: true };
  const requests = [];
  watcher.evaluate = async (trigger) => {
    if (!trigger) return [reply];
    requests.push(trigger);
    return true;
  };
  await watcher.poll();
  reply.id = "new";
  await watcher.poll();
  now = 14999;
  await watcher.poll();
  assert.equal(requests.length, 1);
  now = 15000;
  await watcher.poll();
  assert.equal(requests.length, 2);
  saved = true;
  now = 45000;
  await watcher.poll();
  assert.equal(requests.length, 2);
});
