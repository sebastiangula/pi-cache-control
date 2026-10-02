import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectPayload } from "../src/payload.ts";
import { CacheTracker, diagnoseMiss } from "../src/tracker.ts";

const payload = (markers: boolean) =>
	inspectPayload({
		messages: [{ role: "user", content: markers ? [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }] : "x" }],
	});
const base = { staticChanged: false, sharedMessages: 1, longRetention: false };
const big = { input: 5000, cacheRead: 0, cacheWrite: 0 };
const prev = { timestamp: 0, model: "m", input: 1, cacheRead: 0, cacheWrite: 0, payload: payload(true) };

test("no markers on a Claude model is the first thing reported", () => {
	const reason = diagnoseMiss(big, { ...base, modelId: "litellm/claude-sonnet-4-5", payload: payload(false), previous: prev });
	assert.match(reason!, /no cache_control markers/);
});

test("hits are not misses", () => {
	assert.equal(diagnoseMiss({ ...big, cacheRead: 10 }, { ...base, modelId: "claude" }), undefined);
});

test("first request writing the cache is expected", () => {
	assert.equal(diagnoseMiss({ ...big, cacheWrite: 4000 }, { ...base, modelId: "claude", payload: payload(true) }), undefined);
});

test("reports short prompts, prefix changes and TTL expiry", () => {
	const ctx = { ...base, modelId: "gpt-4o", payload: payload(true), previous: prev };
	assert.match(diagnoseMiss({ input: 500, cacheRead: 0, cacheWrite: 0 }, ctx)!, /below/);
	assert.match(diagnoseMiss(big, { ...ctx, staticChanged: true })!, /system prompt/);
	assert.match(diagnoseMiss(big, { ...ctx, gapMs: 10 * 60 * 1000 })!, /10 min/);
	assert.equal(diagnoseMiss(big, { ...ctx, gapMs: 10 * 60 * 1000, longRetention: true })?.includes("min since"), false);
});

test("tracker totals and miss streak", () => {
	const t = new CacheTracker();
	t.add({ timestamp: 1, model: "m", input: 100, cacheRead: 0, cacheWrite: 900 });
	t.add({ timestamp: 2, model: "m", input: 50, cacheRead: 900, cacheWrite: 0 });
	assert.equal(t.missStreak(), 0);
	t.add({ timestamp: 3, model: "m", input: 1000, cacheRead: 0, cacheWrite: 0 });
	t.add({ timestamp: 4, model: "m", input: 1000, cacheRead: 0, cacheWrite: 0 });
	assert.equal(t.missStreak(), 2);
	assert.deepEqual(t.totals(), { requests: 4, hits: 1, input: 2150, cacheRead: 900, cacheWrite: 900 });
});

test("observeRequest compares with the previous payload", () => {
	const t = new CacheTracker();
	const first = t.observeRequest(payload(true), 1000);
	assert.equal(first.gapMs, undefined);
	const second = t.observeRequest(payload(false), 4000);
	assert.equal(second.gapMs, 3000);
	assert.equal(second.sharedMessages, 1);
	assert.equal(second.staticChanged, false);
});
