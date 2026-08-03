export const MODEL_MULTIPLIERS = new Map([
  ["seed-2.1-pro", 0.77],
  ["seed-2.1-turbo", 0.10],
  ["seed-code", 0.03],
  ["glm-5.2", 0.40],
  ["glm-5.1", 0.83],
  ["glm-5", 0.70],
  ["deepseek-v4-pro", 0.32],
  ["deepseek-v4-flash", 0.05],
  ["kimi-k2.7-code", 0.62],
  ["minimax-m3", 0.26],
  ["qwen3.7-plus", 0.25]
]);

// Local TRAE CN calibration samples: [uncached prompt tokens, displayed credits].
// They keep estimates useful for each model instead of applying one global intercept
// to both cheap and expensive models.
const CREDIT_SAMPLES = new Map([
  ["seed-2.1-pro", [[26883, 6.60], [26883, 6.59], [0, 1.43]]],
  ["seed-2.1-turbo", [[12631, 0.48], [343, 0.19], [26967, 0.82]]],
  ["seed-code", [[27386, 0.17], [0, 0.04], [0, 0.04]]],
  ["glm-5.2", [[22779, 2.63], [22459, 2.60], [25211, 2.83]]],
  ["glm-5.1", [[699, 1.05], [59, 0.96], [59, 0.96]]],
  ["glm-5", [[24610, 3.29], [34, 0.86], [34, 0.91]]],
  ["deepseek-v4-pro", [[25080, 6.63], [14840, 3.94], [5624, 1.51]]],
  ["deepseek-v4-flash", [[24313, 0.94], [505, 0.03], [505, 0.03]]],
  ["kimi-k2.7-code", [[22473, 4.51], [22473, 4.50], [25033, 4.90]]],
  ["minimax-m3", [[23361, 2.01], [23361, 2.02], [14, 0.42]]],
  ["qwen3.7-plus", [[25799, 2.08], [327, 0.45], [327, 0.45]]]
]);

export function normalizeModelName(value) {
  if (!value) return "unknown";
  const normalized = String(value).trim().replace(/正式版/gu, "").replace(/\s+/gu, " ");
  return normalized.replace(/^Doubao-/iu, "");
}

export function modelMultiplier(model) {
  const key = normalizeModelName(model).toLowerCase();
  if (MODEL_MULTIPLIERS.has(key)) return MODEL_MULTIPLIERS.get(key);
  for (const [name, multiplier] of MODEL_MULTIPLIERS) {
    if (key.includes(name)) return multiplier;
  }
  return null;
}

// Empirical calibration from the 2026-08-03 local experiment. This is never
// presented as an actual TRAE charge and can be replaced when an actual fee is seen.
export function estimateCredits({ model, promptTokens = 0, cachedTokens = 0 }) {
  const multiplier = modelMultiplier(model);
  if (multiplier === null) return null;
  const uncached = Math.max(0, promptTokens - cachedTokens);
  const samples = CREDIT_SAMPLES.get(normalizeModelName(model).toLowerCase());
  if (samples) {
    const meanX = samples.reduce((sum, [x]) => sum + x, 0) / samples.length;
    const meanY = samples.reduce((sum, [, y]) => sum + y, 0) / samples.length;
    const denominator = samples.reduce((sum, [x]) => sum + (x - meanX) ** 2, 0);
    const slope = denominator ? samples.reduce((sum, [x, y]) => sum + (x - meanX) * (y - meanY), 0) / denominator : 0;
    return Math.max(0, meanY + slope * (uncached - meanX));
  }
  return Math.max(0, 0.355 + 0.290 * multiplier * (uncached + 0.116 * cachedTokens) / 1000);
}
