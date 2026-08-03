import test from "node:test";
import assert from "node:assert/strict";
import { extractUsageEvents, parseResponseBody } from "../src/usage.mjs";

test("extracts OpenAI-style usage and inherited model/credits", () => {
  const events = extractUsageEvents({
    model: "DeepSeek-V4-Flash",
    fee_usage: { credits: 0.03 },
    usage: {
      prompt_tokens: 26105,
      completion_tokens: 13,
      total_tokens: 26118,
      prompt_tokens_details: { cached_tokens: 25600 }
    }
  });
  assert.deepEqual(events, [{
    model: "DeepSeek-V4-Flash", promptTokens: 26105, completionTokens: 13,
    totalTokens: 26118, cachedTokens: 25600, cacheWriteTokens: 0, credits: 0.03
  }]);
});

test("parses SSE response frames", () => {
  const events = parseResponseBody('data: {"model":"GLM-5.2","usage":{"input_tokens":100,"output_tokens":3}}\n\ndata: [DONE]\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].totalTokens, 103);
});

test("inherits a model found in a sibling debugger variable", () => {
  const events = extractUsageEvents({ local: {
    e: { prompt_tokens: 29234, completion_tokens: 18, total_tokens: 29252, cache_read_input_tokens: 29234 },
    t: { telemetry: { model: "Doubao-Seed-Code" } }
  }});
  assert.equal(events.length, 1);
  assert.equal(events[0].model, "Seed-Code");
});

test("parses TRAE get_session_usage billing response", () => {
  const [event] = parseResponseBody(JSON.stringify({
    user_usage_group_by_session: {
      credits_float: 0.04,
      model_name: "Seed-Code",
      session_id: "user-message-1",
      extra_info: { input_token: 29234, output_token: 18, cache_read_token: 29234, cache_write_token: 0 }
    }
  }));
  assert.deepEqual(event, {
    model: "Seed-Code", promptTokens: 29234, completionTokens: 18, totalTokens: 29252,
    cachedTokens: 29234, cacheWriteTokens: 0, credits: 0.04, sessionId: "user-message-1"
  });
});
