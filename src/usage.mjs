import { normalizeModelName } from "./models.mjs";

const numberKeys = {
  promptTokens: ["prompt_tokens", "input_tokens", "input_token", "promptTokens", "inputTokens"],
  completionTokens: ["completion_tokens", "output_tokens", "output_token", "completionTokens", "outputTokens"],
  totalTokens: ["total_tokens", "totalTokens"],
  cachedTokens: ["cached_tokens", "cache_read_input_tokens", "cache_read_token", "cachedTokens", "cacheReadInputTokens"],
  cacheWriteTokens: ["cache_creation_input_tokens", "cache_write_input_tokens", "cache_write_token", "cacheCreationInputTokens"]
};

const modelKeys = ["model", "model_name", "modelName", "display_model", "displayModel"];
const creditKeys = ["credits", "credits_float", "credit", "points", "point", "fee", "cost_credits", "credit_cost"];
const identifierKeys = {
  sessionId: ["sessionId", "session_id"],
  userMessageId: ["userMessageId", "user_message_id"],
  agentMessageId: ["agentMessageId", "agent_message_id"]
};

function finiteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function directNumber(object, keys) {
  for (const key of keys) {
    const value = finiteNumber(object?.[key]);
    if (value !== null) return value;
  }
  return null;
}

function nestedCachedTokens(object) {
  const details = object?.prompt_tokens_details ?? object?.input_tokens_details ?? object?.promptTokensDetails;
  return directNumber(details, ["cached_tokens", "cache_read_tokens", "cachedTokens"]);
}

function directModel(object) {
  for (const key of modelKeys) {
    if (typeof object?.[key] === "string" && object[key]) return normalizeModelName(object[key]);
  }
  return null;
}

function directCredits(object) {
  for (const key of creditKeys) {
    const value = finiteNumber(object?.[key]);
    if (value !== null && value >= 0) return value;
  }
  const feeUsage = object?.fee_usage ?? object?.feeUsage;
  if (feeUsage && typeof feeUsage === "object") return directCredits(feeUsage);
  return null;
}

function directIdentifier(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if ((typeof value === "string" || typeof value === "number") && String(value)) return String(value);
  }
  return null;
}

function looksLikeUsage(object) {
  if (!object || typeof object !== "object" || Array.isArray(object)) return false;
  const keys = Object.keys(object);
  return keys.some((key) => /(?:prompt|input|completion|output|total|cached|cache).*tokens?/iu.test(key));
}

function deepContext(payload) {
  const queue = [{ value: payload, depth: 0 }];
  const seen = new WeakSet();
  let model = null;
  while (queue.length) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== "object" || depth > 10 || seen.has(value)) continue;
    seen.add(value);
    if (!model) {
      const candidate = directModel(value);
      if (candidate && candidate.toLowerCase() !== "unknown") model = candidate;
    }
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") queue.push({ value: child, depth: depth + 1 });
    }
  }
  return { model };
}

function normalizeUsage(object, inherited) {
  const promptTokens = directNumber(object, numberKeys.promptTokens) ?? 0;
  const completionTokens = directNumber(object, numberKeys.completionTokens) ?? 0;
  const totalTokens = directNumber(object, numberKeys.totalTokens) ?? promptTokens + completionTokens;
  const cachedTokens = directNumber(object, numberKeys.cachedTokens) ?? nestedCachedTokens(object) ?? 0;
  const cacheWriteTokens = directNumber(object, numberKeys.cacheWriteTokens) ?? 0;
  if (totalTokens <= 0 && promptTokens <= 0 && completionTokens <= 0) return null;
  const result = {
    model: directModel(object) ?? inherited.model ?? "unknown",
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    cacheWriteTokens,
    credits: directCredits(object) ?? inherited.credits ?? null
  };
  const sessionId = directIdentifier(object, identifierKeys.sessionId) ?? inherited.sessionId;
  const userMessageId = directIdentifier(object, identifierKeys.userMessageId) ?? inherited.userMessageId;
  const agentMessageId = directIdentifier(object, identifierKeys.agentMessageId) ?? inherited.agentMessageId;
  if (sessionId) result.sessionId = sessionId;
  if (userMessageId) result.userMessageId = userMessageId;
  if (agentMessageId) result.agentMessageId = agentMessageId;
  return result;
}

export function extractUsageEvents(payload, { inferSiblingModel = true } = {}) {
  const events = [];
  const seenObjects = new WeakSet();
  const signatures = new Set();

  function visit(value, inherited = {}, depth = 0) {
    if (!value || typeof value !== "object" || depth > 12) return;
    if (seenObjects.has(value)) return;
    seenObjects.add(value);

    const context = {
      model: directModel(value) ?? inherited.model ?? null,
      credits: directCredits(value) ?? inherited.credits ?? null,
      sessionId: directIdentifier(value, identifierKeys.sessionId) ?? inherited.sessionId ?? null,
      userMessageId: directIdentifier(value, identifierKeys.userMessageId) ?? inherited.userMessageId ?? null,
      agentMessageId: directIdentifier(value, identifierKeys.agentMessageId) ?? inherited.agentMessageId ?? null
    };
    if (looksLikeUsage(value)) {
      const event = normalizeUsage(value, context);
      if (event) {
        const signature = [event.model, event.promptTokens, event.completionTokens, event.totalTokens,
          event.cachedTokens, event.cacheWriteTokens, event.credits, event.sessionId,
          event.userMessageId, event.agentMessageId];
        const key = JSON.stringify(signature);
        if (!signatures.has(key)) {
          signatures.add(key);
          events.push(event);
        }
      }
    }
    for (const child of Object.values(value)) visit(child, context, depth + 1);
  }

  visit(payload, inferSiblingModel ? deepContext(payload) : {});
  return events;
}

export function parseResponseBody(body) {
  if (typeof body !== "string" || !body.trim()) return [];
  const payloads = [];
  try {
    payloads.push(JSON.parse(body));
  } catch {
    for (const line of body.split(/\r?\n/u)) {
      const text = line.startsWith("data:") ? line.slice(5).trim() : line.trim();
      if (!text || text === "[DONE]") continue;
      try { payloads.push(JSON.parse(text)); } catch { /* Ignore non-JSON stream frames. */ }
    }
  }
  return payloads.flatMap((payload) => extractUsageEvents(payload, { inferSiblingModel: false }));
}
