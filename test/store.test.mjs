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
