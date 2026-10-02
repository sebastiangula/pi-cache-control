import assert from "node:assert/strict";
import { test } from "node:test";
import { commonPrefix, countCacheMarkers, injectCacheMarkers, inspectPayload } from "../src/payload.ts";

const chat = () => ({
	model: "claude-sonnet",
	messages: [
		{ role: "system", content: "You are pi." },
		{ role: "user", content: "hi" },
		{ role: "assistant", content: [{ type: "text", text: "hello" }] },
		{ role: "user", content: [{ type: "text", text: "do it" }] },
	],
	tools: [{ type: "function", function: { name: "a" } }, { type: "function", function: { name: "b" } }],
});

test("injects markers on system, last tool and last message", () => {
	const original = chat();
	const out = injectCacheMarkers(original) as any;
	assert.equal(countCacheMarkers(out), 3);
	assert.deepEqual(out.messages[0].content, [{ type: "text", text: "You are pi.", cache_control: { type: "ephemeral" } }]);
	assert.deepEqual(out.tools[1].cache_control, { type: "ephemeral" });
	assert.deepEqual(out.messages[3].content[0].cache_control, { type: "ephemeral" });
	assert.equal(countCacheMarkers(original), 0, "input is not mutated");
});

test("does not inject when markers already exist or for anthropic payloads", () => {
	const marked = injectCacheMarkers(chat())!;
	assert.equal(injectCacheMarkers(marked), undefined);
	assert.equal(injectCacheMarkers({ system: [], messages: [] }), undefined);
});

test("long retention adds ttl", () => {
	const out = injectCacheMarkers(chat(), "1h") as any;
	assert.deepEqual(out.tools[1].cache_control, { type: "ephemeral", ttl: "1h" });
});

test("fingerprints ignore cache markers", () => {
	const a = inspectPayload(chat());
	const b = inspectPayload(injectCacheMarkers(chat()));
	assert.equal(a.staticHash, b.staticHash);
	assert.deepEqual(a.messageHashes, b.messageHashes);
	assert.equal(b.cacheMarkers, 3);
	assert.equal(a.shape, "openai");
});

test("detects system prompt changes and shared prefix", () => {
	const a = inspectPayload(chat());
	const changed = chat();
	changed.messages[0].content = "You are pi v2.";
	changed.messages.push({ role: "user", content: "more" });
	const b = inspectPayload(changed);
	assert.notEqual(a.staticHash, b.staticHash);
	assert.equal(commonPrefix(a.messageHashes, b.messageHashes), 3);
});
