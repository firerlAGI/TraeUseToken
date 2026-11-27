import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageStore } from "../src/store.mjs";
import { estimateCredits } from "../src/models.mjs";

test("persists, estimates and merges duplicate observations", () => {
  const directory = mkdtempSync(join(tmpdir(), "trae-monitor-test-"));
  const store = new UsageStore(join(directory, "usage.db"));
  const first = store.record({ model: "Seed-Code", promptTokens: 1000, completionTokens: 5,
    totalTokens: 1005, cachedTokens: 500, source: "network" });
  assert.equal(first.credit_kind, "estimated");
  const merged = store.record({ model: "Seed-Code", promptTokens: 1000, completionTokens: 5,
    totalTokens: 1005, cachedTokens: 500, credits: 0.04, source: "debugger" });
  assert.equal(store.summary().total.calls, 1);
  assert.equal(merged.credit_kind, "actual");
  assert.equal(merged.credits, 0.04);
  assert.match(store.csv(), /Seed-Code/u);
  store.close();
});

test("keeps different turn IDs separate even when their token counts match", () => {
  const store = new UsageStore(":memory:");
  const usage = { model: "Seed-Code", promptTokens: 1000, completionTokens: 5, totalTokens: 1005 };
  store.record({ ...usage, source: "debugger", userMessageId: "turn-a",
    observedAt: "2026-01-01T00:00:00.000Z" });
  const second = store.record({ ...usage, source: "billing", billingId: "turn-b", credits: 0.04,
    observedAt: "2026-01-01T00:00:02.000Z" });
  const repeat = store.record({ ...usage, source: "billing", billingId: "turn-b", credits: 0.04,
    observedAt: "2026-01-01T00:00:03.000Z" });
  assert.equal(store.summary().total.calls, 2);
  assert.equal(repeat.id, second.id);
  store.close();
});

test("uses model calibration for a fully cached Seed-Code call", () => {
  assert.ok(Math.abs(estimateCredits({ model: "Doubao-Seed-Code", promptTokens: 29234, cachedTokens: 29234 }) - 0.04) < 0.001);
});

test("late TRAE billing replaces the matching estimate", () => {
  const directory = mkdtempSync(join(tmpdir(), "trae-monitor-billing-test-"));
  const store = new UsageStore(join(directory, "usage.db"));
  store.record({ model: "Seed-Code", promptTokens: 29234, completionTokens: 18,
    totalTokens: 29252, cachedTokens: 29234, source: "debugger", userMessageId: "turn-1",
    observedAt: "2026-01-01T00:00:00.000Z" });
  const merged = store.record({ model: "Seed-Code", promptTokens: 29234, completionTokens: 18,
    totalTokens: 29252, cachedTokens: 29234, credits: 0.04, source: "billing",
    userMessageId: "turn-1", billingId: "turn-1", observedAt: "2026-01-01T01:00:00.000Z" });
  assert.equal(store.summary().total.calls, 1);
  assert.equal(merged.credit_kind, "actual");
  assert.equal(merged.credits, 0.04);
  assert.equal(merged.billing_id, "turn-1");
  store.close();
});

test("merges detailed token data into a credit-free native task", () => {
  const directory = mkdtempSync(join(tmpdir(), "trae-monitor-coding-plan-test-"));
  const store = new UsageStore(join(directory, "usage.db"));
  store.record({ model: "TRAE 原生任务", source: "native-task", userMessageId: "turn-plan-1",
    skipCreditEstimate: true });
  const merged = store.record({ model: "Coding Plan Model", promptTokens: 200,
    completionTokens: 10, totalTokens: 210, cachedTokens: 150, source: "debugger",
    userMessageId: "turn-plan-1" });
  assert.equal(store.summary().total.calls, 1);
  assert.equal(merged.model, "Coding Plan Model");
  assert.equal(merged.total_tokens, 210);
  assert.equal(merged.cached_tokens, 150);
  assert.equal(merged.credits, null);
  assert.equal(merged.credit_kind, "not_applicable");
  store.close();
});

test("filters summaries, recent calls and CSV by start time", () => {
  const directory = mkdtempSync(join(tmpdir(), "trae-monitor-range-test-"));
  const store = new UsageStore(join(directory, "usage.db"));
  store.record({ model: "Seed-Code", promptTokens: 100, completionTokens: 1, totalTokens: 101,
    source: "debugger", observedAt: "2026-07-31T23:00:00.000Z" });
  store.record({ model: "GLM-5.2", promptTokens: 200, completionTokens: 2, totalTokens: 202,
    source: "debugger", observedAt: "2026-08-03T02:00:00.000Z" });
  const since = "2026-08-01T00:00:00.000Z";
  assert.equal(store.summary(since).total.calls, 1);
  assert.equal(store.summary(since).total.total_tokens, 202);
  assert.equal(store.recent(100, since).length, 1);
  assert.doesNotMatch(store.csv(since), /Seed-Code/u);
  assert.match(store.csv(since), /GLM-5\.2/u);
  store.close();
});
