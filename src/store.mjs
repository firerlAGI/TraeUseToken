import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { estimateCredits, modelMultiplier } from "./models.mjs";

export class UsageStore extends EventEmitter {
  constructor(path) {
    super();
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        observed_at TEXT NOT NULL,
        source TEXT NOT NULL,
        target_id TEXT,
        request_id TEXT,
        endpoint TEXT,
        model TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        credits REAL,
        credit_kind TEXT NOT NULL DEFAULT 'unknown',
        multiplier REAL,
        raw_json TEXT
      );
      CREATE INDEX IF NOT EXISTS calls_observed_at ON calls(observed_at DESC);
      CREATE INDEX IF NOT EXISTS calls_model ON calls(model);
    `);
    const columns = new Set(this.db.prepare("PRAGMA table_info(calls)").all().map((column) => column.name));
    for (const [name, type] of [["session_id", "TEXT"], ["user_message_id", "TEXT"],
      ["agent_message_id", "TEXT"], ["billing_id", "TEXT"]]) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE calls ADD COLUMN ${name} ${type}`);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS calls_user_message_id ON calls(user_message_id);
      CREATE INDEX IF NOT EXISTS calls_billing_id ON calls(billing_id);
    `);
  }

  record(event) {
    const observedAt = event.observedAt ?? new Date().toISOString();
    const model = event.model || "unknown";
    const values = {
      promptTokens: Math.max(0, Math.round(event.promptTokens || 0)),
      completionTokens: Math.max(0, Math.round(event.completionTokens || 0)),
      totalTokens: Math.max(0, Math.round(event.totalTokens || 0)),
      cachedTokens: Math.max(0, Math.round(event.cachedTokens || 0)),
      cacheWriteTokens: Math.max(0, Math.round(event.cacheWriteTokens || 0))
    };

    const sessionId = event.sessionId ? String(event.sessionId) : null;
    const userMessageId = event.userMessageId ? String(event.userMessageId) : null;
    const agentMessageId = event.agentMessageId ? String(event.agentMessageId) : null;
    const billingId = event.billingId ? String(event.billingId) : null;
    const actualCredits = Number.isFinite(event.credits) ? event.credits : null;

    // Prefer TRAE's stable per-turn identifier. Billing responses call it session_id,
    // although the UI sends the userMessageId in that field.
    let duplicate = null;
    if (userMessageId || billingId) {
      duplicate = this.db.prepare(`
        SELECT * FROM calls
        WHERE (? IS NOT NULL AND user_message_id = ?)
          OR (? IS NOT NULL AND (billing_id = ? OR user_message_id = ?))
        ORDER BY id DESC LIMIT 1
      `).get(userMessageId, userMessageId, billingId, billingId, billingId);
    }

    // A completed historical turn may be billed long after its token event was saved.
    if (!duplicate && actualCredits !== null && event.source === "billing") {
      duplicate = this.db.prepare(`
        SELECT * FROM calls
        WHERE model = ? AND total_tokens = ? AND prompt_tokens = ? AND completion_tokens = ?
          AND credit_kind != 'actual'
        ORDER BY id DESC LIMIT 1
      `).get(model, values.totalTokens, values.promptTokens, values.completionTokens);
    }

    // Merge the same observation reported by Network and Debugger within five seconds.
    if (event.source !== "native" || values.totalTokens > 0) {
      duplicate ??= this.db.prepare(`
        SELECT * FROM calls
        WHERE model = ? AND total_tokens = ? AND prompt_tokens = ? AND completion_tokens = ?
          AND unixepoch(observed_at) >= unixepoch(?) - 5
        ORDER BY id DESC LIMIT 1
      `).get(model, values.totalTokens, values.promptTokens, values.completionTokens, observedAt);
    }

    const estimated = actualCredits === null && !event.skipCreditEstimate ? estimateCredits({
      model,
      promptTokens: values.promptTokens,
      cachedTokens: values.cachedTokens
    }) : null;
    const credits = actualCredits ?? estimated;
    const creditKind = actualCredits !== null ? "actual"
      : event.skipCreditEstimate ? "not_applicable"
        : estimated !== null ? "estimated" : "unknown";

    if (duplicate) {
      const mergedKind = duplicate.credit_kind === "actual" ? "actual"
        : creditKind === "actual" ? "actual"
          : duplicate.credit_kind === "not_applicable" ? "not_applicable" : creditKind;
      const mergedCredits = duplicate.credit_kind === "actual" ? duplicate.credits
        : creditKind === "actual" ? credits
          : duplicate.credit_kind === "not_applicable" ? null : credits;
      const placeholderModels = new Set(["unknown", "TRAE 原生任务", "TRAE 原生积分"]);
      const mergedModel = placeholderModels.has(duplicate.model) && !placeholderModels.has(model)
        ? model : duplicate.model;
      this.db.prepare(`
        UPDATE calls SET source = ?, model = ?, prompt_tokens = MAX(prompt_tokens, ?),
          completion_tokens = MAX(completion_tokens, ?), total_tokens = MAX(total_tokens, ?),
          credits = ?, credit_kind = ?, cached_tokens = MAX(cached_tokens, ?),
          cache_write_tokens = MAX(cache_write_tokens, ?), multiplier = ?, session_id = COALESCE(session_id, ?),
          user_message_id = COALESCE(user_message_id, ?), agent_message_id = COALESCE(agent_message_id, ?),
          billing_id = COALESCE(billing_id, ?), raw_json = COALESCE(raw_json, ?) WHERE id = ?
      `).run([...new Set(`${duplicate.source},${event.source || "unknown"}`.split(","))].join(","),
        mergedModel, values.promptTokens, values.completionTokens, values.totalTokens,
        mergedCredits, mergedKind, values.cachedTokens, values.cacheWriteTokens, modelMultiplier(mergedModel), sessionId,
        userMessageId, agentMessageId, billingId, null, duplicate.id);
      const row = this.getById(duplicate.id);
      this.emit("call", row);
      return row;
    }

    const result = this.db.prepare(`
      INSERT INTO calls (observed_at, source, target_id, request_id, endpoint, model,
        prompt_tokens, completion_tokens, total_tokens, cached_tokens, cache_write_tokens,
        credits, credit_kind, multiplier, raw_json, session_id, user_message_id, agent_message_id, billing_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(observedAt, event.source || "unknown", event.targetId ?? null, event.requestId ?? null,
      event.endpoint ?? null, model, values.promptTokens, values.completionTokens, values.totalTokens,
      values.cachedTokens, values.cacheWriteTokens, credits, creditKind, modelMultiplier(model),
      null, sessionId, userMessageId, agentMessageId, billingId);
    const row = this.getById(Number(result.lastInsertRowid));
    this.emit("call", row);
    return row;
  }

  getById(id) {
    return this.db.prepare(`SELECT id, observed_at, source, target_id, request_id, endpoint, model,
      prompt_tokens, completion_tokens, total_tokens, cached_tokens, cache_write_tokens,
      credits, credit_kind, multiplier, session_id, user_message_id, agent_message_id, billing_id
      FROM calls WHERE id = ?`).get(id);
  }

  recent(limit = 100, since = null) {
    const query = `SELECT id, observed_at, source, target_id, request_id, endpoint, model,
      prompt_tokens, completion_tokens, total_tokens, cached_tokens, cache_write_tokens,
      credits, credit_kind, multiplier, session_id, user_message_id, agent_message_id, billing_id
      FROM calls ${since ? "WHERE observed_at >= ?" : ""} ORDER BY id DESC LIMIT ?`;
    const capped = Math.min(1000, Math.max(1, limit));
    return since ? this.db.prepare(query).all(since, capped) : this.db.prepare(query).all(capped);
  }

  summary(since = null) {
    const where = since ? "WHERE observed_at >= ?" : "";
    const totalQuery = `
      SELECT COUNT(*) calls, COALESCE(SUM(total_tokens), 0) total_tokens,
        COALESCE(SUM(prompt_tokens), 0) prompt_tokens,
        COALESCE(SUM(completion_tokens), 0) completion_tokens,
        COALESCE(SUM(cached_tokens), 0) cached_tokens,
        COALESCE(SUM(CASE WHEN credit_kind = 'actual' THEN credits ELSE 0 END), 0) actual_credits,
        COALESCE(SUM(CASE WHEN credit_kind = 'estimated' THEN credits ELSE 0 END), 0) estimated_credits
      FROM calls ${where}`;
    const modelQuery = `
      SELECT model, COUNT(*) calls, SUM(total_tokens) total_tokens, SUM(cached_tokens) cached_tokens,
        SUM(CASE WHEN credit_kind = 'actual' THEN credits ELSE 0 END) actual_credits,
        SUM(CASE WHEN credit_kind = 'estimated' THEN credits ELSE 0 END) estimated_credits
      FROM calls ${where} GROUP BY model ORDER BY total_tokens DESC`;
    const total = since ? this.db.prepare(totalQuery).get(since) : this.db.prepare(totalQuery).get();
    const models = since ? this.db.prepare(modelQuery).all(since) : this.db.prepare(modelQuery).all();
    return { total, models };
  }

  csv(since = null) {
    const rows = since
      ? this.db.prepare("SELECT * FROM calls WHERE observed_at >= ? ORDER BY id").all(since)
      : this.db.prepare("SELECT * FROM calls ORDER BY id").all();
    const headers = ["id", "observed_at", "model", "prompt_tokens", "completion_tokens", "total_tokens",
      "cached_tokens", "cache_write_tokens", "credits", "credit_kind", "multiplier", "source", "endpoint"];
    const cell = (value) => {
      const text = value === null || value === undefined ? "" : String(value);
      return /[",\r\n]/u.test(text) ? `"${text.replaceAll("\"", "\"\"")}"` : text;
    };
    return `\uFEFF${headers.join(",")}\r\n${rows.map((row) => headers.map((key) => cell(row[key])).join(",")).join("\r\n")}\r\n`;
  }

  close() { this.db.close(); }
}
