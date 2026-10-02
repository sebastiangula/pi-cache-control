import assert from "node:assert/strict";
import { test } from "node:test";
import { extractRawUsage, hitRate, reconcileUsage, type UsageLike } from "../src/usage.ts";

const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

test("reads LiteLLM's Anthropic cache counters", () => {
	const raw = extractRawUsage({
		prompt_tokens: 12034,
		completion_tokens: 210,
		prompt_tokens_details: { cached_tokens: 0 },
		cache_creation_input_tokens: 11800,
		cache_read_input_tokens: 0,
	});
	assert.equal(raw?.cacheWrite, 11800);
	assert.equal(raw?.cacheRead, 0);
	assert.deepEqual(raw?.fields, ["cache_read_input_tokens", "cache_creation_input_tokens"]);
});

test("falls back to OpenAI / OpenRouter / DeepSeek fields", () => {
	assert.equal(extractRawUsage({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 7 } })?.cacheRead, 7);
	assert.equal(extractRawUsage({ prompt_tokens_details: { cache_write_tokens: 5 } })?.cacheWrite, 5);
	assert.equal(extractRawUsage({ prompt_cache_hit_tokens: 3 })?.cacheRead, 3);
	assert.equal(extractRawUsage(null), undefined);
});

test("moves cache writes pi missed out of input and recomputes cost", () => {
	// What pi parses from the LiteLLM response above: writes counted as input.
	const parsed: UsageLike = { input: 12034, output: 210, cacheRead: 0, cacheWrite: 0, totalTokens: 12244, cost: zeroCost };
	const raw = extractRawUsage({ prompt_tokens: 12034, completion_tokens: 210, cache_creation_input_tokens: 11800 })!;
	const fixed = reconcileUsage(parsed, raw, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 })!;
	assert.equal(fixed.input, 234);
	assert.equal(fixed.cacheWrite, 11800);
	assert.equal(fixed.totalTokens, 12244);
	assert.ok(Math.abs(fixed.cost.total - (234 * 3 + 210 * 15 + 11800 * 3.75) / 1e6) < 1e-12);
});

test("leaves usage alone when pi already has the numbers", () => {
	const parsed: UsageLike = { input: 100, output: 5, cacheRead: 900, cacheWrite: 0, totalTokens: 1005, cost: zeroCost };
	const raw = extractRawUsage({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 900 } })!;
	assert.equal(reconcileUsage(parsed, raw), undefined);
});

test("hit rate is reads over all prompt tokens", () => {
	assert.equal(hitRate({ input: 100, cacheRead: 900, cacheWrite: 0 }), 0.9);
	assert.equal(hitRate({ input: 0, cacheRead: 0, cacheWrite: 0 }), undefined);
});
