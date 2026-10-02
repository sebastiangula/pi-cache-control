import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { installSniffer, urlMatches, usageFromSse } from "../src/sniffer.ts";

test("takes the last usage chunk from an SSE stream", () => {
	const sse = [
		'data: {"choices":[{"delta":{"content":"hi"}}]}',
		'data: {"choices":[],"usage":{"prompt_tokens":10,"cache_creation_input_tokens":8}}',
		"data: [DONE]",
	].join("\n\n");
	assert.deepEqual(usageFromSse(sse), { prompt_tokens: 10, cache_creation_input_tokens: 8 });
});

test("url matching respects path boundaries", () => {
	assert.ok(urlMatches("http://proxy:4000/v1/chat/completions", "http://proxy:4000/v1/"));
	assert.ok(!urlMatches("http://proxy:4000/v10/chat", "http://proxy:4000/v1"));
	assert.ok(!urlMatches("http://x", ""));
});

test("reads a clone of matching responses without consuming the original", async () => {
	const server = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end('data: {"usage":{"prompt_tokens":3}}\n\ndata: [DONE]\n\n');
	});
	await new Promise<void>((r) => server.listen(0, r));
	const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
	let captured: Promise<unknown> | undefined;
	let armed = true;
	installSniffer({
		target: () => (armed ? ((armed = false), { baseUrl: base }) : undefined),
		onResponse: (u) => (captured = u),
	});
	try {
		const res = await fetch(`${base}/chat/completions`, { method: "POST" });
		assert.match(await res.text(), /prompt_tokens/);
		assert.deepEqual(await captured, { prompt_tokens: 3 });
		captured = undefined;
		await (await fetch(`${base}/chat/completions`)).text();
		assert.equal(captured, undefined, "one-shot target");
	} finally {
		installSniffer(undefined);
		server.close();
	}
});
