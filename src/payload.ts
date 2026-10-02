/**
 * Inspection (and optional patching) of the provider payload pi is about to
 * send, so a cache miss can be explained: were there cache_control markers,
 * did the system prompt or tool list change, how much of the conversation is
 * an unchanged prefix of the previous request.
 */

import { createHash } from "node:crypto";

type Json = Record<string, unknown>;

export interface PayloadInfo {
	/** "openai" for chat-completions payloads, "anthropic" for messages payloads. */
	shape: "openai" | "anthropic" | "unknown";
	/** Number of `cache_control` markers anywhere in the payload. */
	cacheMarkers: number;
	/** Whether `prompt_cache_key` (OpenAI-style cache routing hint) is set. */
	promptCacheKey: boolean;
	/** Hash of system prompt + tool definitions, ignoring cache markers. */
	staticHash: string;
	/** Hash of each conversation message, ignoring cache markers. */
	messageHashes: string[];
}

function isObj(value: unknown): value is Json {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

export function countCacheMarkers(value: unknown): number {
	if (Array.isArray(value)) return value.reduce((n: number, item) => n + countCacheMarkers(item), 0);
	if (!isObj(value)) return 0;
	let n = isObj(value.cache_control) ? 1 : 0;
	for (const [key, child] of Object.entries(value)) {
		if (key !== "cache_control") n += countCacheMarkers(child);
	}
	return n;
}

/** `[{type: "text", text}]` and `"text"` are the same prompt; adding a marker converts one into the other. */
function singleText(content: unknown): string | undefined {
	if (!Array.isArray(content) || content.length !== 1) return undefined;
	const part = content[0];
	return isObj(part) && part.type === "text" && typeof part.text === "string" ? part.text : undefined;
}

/**
 * Stable JSON with cache markers stripped, so moving a marker (which pi does
 * every request) doesn't look like a prefix change.
 */
function canonical(value: unknown): string {
	return JSON.stringify(value, (key, v) => {
		if (key === "cache_control") return undefined;
		if (key === "content") return singleText(v) ?? v;
		if (isObj(v)) {
			return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]));
		}
		return v;
	});
}

function hash(value: unknown): string {
	return createHash("sha256").update(canonical(value) ?? "").digest("hex").slice(0, 16);
}

function isSystemRole(role: unknown): boolean {
	return role === "system" || role === "developer";
}

export function inspectPayload(payload: unknown): PayloadInfo {
	if (!isObj(payload) || !Array.isArray(payload.messages)) {
		return { shape: "unknown", cacheMarkers: countCacheMarkers(payload), promptCacheKey: false, staticHash: "", messageHashes: [] };
	}
	const messages = payload.messages as unknown[];
	const shape = "system" in payload || "anthropic_version" in payload ? "anthropic" : "openai";
	const systemMessages = messages.filter((m) => isObj(m) && isSystemRole(m.role));
	const conversation = messages.filter((m) => !(isObj(m) && isSystemRole(m.role)));
	return {
		shape,
		cacheMarkers: countCacheMarkers(payload),
		promptCacheKey: typeof payload.prompt_cache_key === "string" && payload.prompt_cache_key.length > 0,
		staticHash: hash({ system: payload.system ?? systemMessages, tools: payload.tools ?? [] }),
		messageHashes: conversation.map(hash),
	};
}

/** Number of leading messages shared by two requests. */
export function commonPrefix(previous: string[], current: string[]): number {
	let i = 0;
	while (i < previous.length && i < current.length && previous[i] === current[i]) i++;
	return i;
}

const EPHEMERAL = { type: "ephemeral" } as const;

/** Put a marker on the last text part of a chat-completions message, converting string content. */
function markMessage(message: Json, marker: Json): boolean {
	if (typeof message.content === "string") {
		if (!message.content) return false;
		message.content = [{ type: "text", text: message.content, cache_control: marker }];
		return true;
	}
	if (Array.isArray(message.content)) {
		for (let i = message.content.length - 1; i >= 0; i--) {
			const part = message.content[i];
			if (isObj(part) && part.type === "text" && typeof part.text === "string" && part.text) {
				part.cache_control = marker;
				return true;
			}
		}
	}
	return false;
}

/**
 * Add Anthropic-style `cache_control` markers to an OpenAI chat-completions
 * payload (what LiteLLM forwards to Claude, Bedrock and Vertex): on the system
 * prompt, the last tool, and the last user/assistant message. Mirrors pi's
 * `compat.cacheControlFormat: "anthropic"`. Leaves payloads that already carry
 * markers untouched. Returns the patched copy, or undefined if nothing changed.
 */
export function injectCacheMarkers(payload: unknown, ttl?: "1h"): Json | undefined {
	if (!isObj(payload) || !Array.isArray(payload.messages) || "system" in payload) return undefined;
	if (countCacheMarkers(payload) > 0) return undefined;

	const marker: Json = ttl ? { ...EPHEMERAL, ttl } : { ...EPHEMERAL };
	const next = structuredClone(payload) as Json;
	const messages = next.messages as Json[];
	let added = 0;

	const system = messages.filter((m) => isObj(m) && isSystemRole(m.role)).at(-1);
	if (system && markMessage(system, marker)) added++;

	const tools = Array.isArray(next.tools) ? next.tools : [];
	const lastTool = tools.at(-1);
	if (isObj(lastTool)) {
		lastTool.cache_control = marker;
		added++;
	}

	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (isObj(m) && (m.role === "user" || m.role === "assistant") && markMessage(m, marker)) {
			added++;
			break;
		}
	}
	return added > 0 ? next : undefined;
}
