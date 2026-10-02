/**
 * Reads the raw `usage` object from provider responses without disturbing pi.
 *
 * Extensions only see pi's parsed usage, which drops LiteLLM's
 * `cache_creation_input_tokens`. To recover it we wrap `globalThis.fetch`
 * (the OpenAI SDK resolves it per client, and pi builds a client per request)
 * and read a clone of the matching response in the background.
 *
 * The wrapper is installed once per process and survives `/reload`; each
 * extension instance just replaces the active listener.
 */

export interface SniffTarget {
	/** Only responses whose URL starts with this are read. */
	baseUrl: string;
}

export interface SniffListener {
	/** Return a target to read the next matching response, or undefined to pass through. */
	target(): SniffTarget | undefined;
	/** Called as soon as a response is claimed, with a promise of its last usage object. */
	onResponse(usage: Promise<unknown>): void;
}

interface SnifferState {
	original: typeof fetch;
	listener?: SniffListener;
}

const STATE_KEY = Symbol.for("pi-cache-control.fetch-sniffer");

function requestUrl(input: Parameters<typeof fetch>[0]): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

function trimSlash(url: string): string {
	return url.replace(/\/+$/, "");
}

export function urlMatches(url: string, baseUrl: string): boolean {
	const base = trimSlash(baseUrl);
	return base.length > 0 && (url === base || url.startsWith(`${base}/`) || url.startsWith(`${base}?`));
}

/** Last `usage` object in an SSE stream of chat-completion chunks. */
export function usageFromSse(text: string): unknown {
	let usage: unknown;
	for (const line of text.split(/\r?\n/)) {
		if (!line.startsWith("data:")) continue;
		const data = line.slice(5).trim();
		if (!data || data === "[DONE]") continue;
		try {
			const chunk = JSON.parse(data);
			usage = chunk?.usage ?? chunk?.choices?.[0]?.usage ?? chunk?.message?.usage ?? usage;
		} catch {
			// partial or non-JSON line
		}
	}
	return usage;
}

async function readUsage(response: Response): Promise<unknown> {
	const type = response.headers.get("content-type") ?? "";
	const text = await response.text();
	if (type.includes("event-stream")) return usageFromSse(text);
	try {
		return JSON.parse(text)?.usage;
	} catch {
		return undefined;
	}
}

export function installSniffer(listener: SniffListener | undefined): void {
	const g = globalThis as typeof globalThis & { [STATE_KEY]?: SnifferState };
	let state = g[STATE_KEY];
	if (!state) {
		const created: SnifferState = { original: globalThis.fetch };
		state = created;
		g[STATE_KEY] = created;
		globalThis.fetch = async function sniffingFetch(input, init) {
			const response = await created.original(input, init);
			const active = created.listener;
			try {
				const target = active?.target();
				if (active && target && response.body && urlMatches(requestUrl(input), target.baseUrl)) {
					active.onResponse(readUsage(response.clone()).catch(() => undefined));
				}
			} catch {
				// never let tracking break a request
			}
			return response;
		};
	}
	state.listener = listener;
}
