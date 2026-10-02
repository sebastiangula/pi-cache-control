/**
 * Per-request cache records, session totals and miss diagnosis.
 */

import { commonPrefix, type PayloadInfo } from "./payload.ts";
import { hitRate, promptTotal, type ModelCost, type UsageLike } from "./usage.ts";

export interface RequestRecord {
	timestamp: number;
	model: string;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	/** Payload facts, when the request was observed live (not restored from the session). */
	payload?: PayloadInfo;
	/** Leading conversation messages unchanged since the previous request. */
	sharedMessages?: number;
	staticChanged?: boolean;
	/** Milliseconds since the previous request. */
	gapMs?: number;
	/** Set when the extension corrected pi's usage from the raw response. */
	reconciled?: boolean;
	missReason?: string;
}

export interface Totals {
	requests: number;
	hits: number;
	input: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface MissContext {
	modelId: string;
	payload?: PayloadInfo;
	previous?: RequestRecord;
	staticChanged: boolean;
	sharedMessages: number;
	gapMs?: number;
	longRetention: boolean;
}

/** Anthropic's smallest cacheable prefix; shorter prompts are never cached. */
const MIN_CACHEABLE_TOKENS = 1024;
const SHORT_TTL_MS = 5 * 60 * 1000;
const LONG_TTL_MS = 60 * 60 * 1000;

export function looksLikeClaude(modelId: string): boolean {
	return /claude|anthropic/i.test(modelId);
}

/**
 * Best guess at why a request read nothing from cache. Returns undefined for
 * expected misses (first request, nothing to reuse yet).
 */
export function diagnoseMiss(usage: Pick<UsageLike, "input" | "cacheRead" | "cacheWrite">, ctx: MissContext): string | undefined {
	if (usage.cacheRead > 0) return undefined;
	const markers = ctx.payload?.cacheMarkers ?? 0;

	if (ctx.payload && markers === 0 && looksLikeClaude(ctx.modelId)) {
		return 'no cache_control markers were sent; Claude only caches marked prefixes. Set compat.cacheControlFormat: "anthropic" on the LiteLLM model or run /cache inject on';
	}
	if (promptTotal(usage) < MIN_CACHEABLE_TOKENS) {
		return `prompt is ${promptTotal(usage)} tokens, below the ~${MIN_CACHEABLE_TOKENS}-token minimum most providers cache`;
	}
	if (!ctx.previous) {
		return usage.cacheWrite > 0 ? undefined : "first request: nothing cached yet";
	}
	if (ctx.staticChanged) return "system prompt or tool definitions changed since the previous request";
	if (ctx.payload && ctx.sharedMessages === 0 && (ctx.previous.payload?.messageHashes.length ?? 0) > 0) {
		return "conversation history was rewritten (e.g. compaction or branch switch); no shared prefix";
	}
	const ttl = ctx.longRetention ? LONG_TTL_MS : SHORT_TTL_MS;
	if (ctx.gapMs !== undefined && ctx.gapMs > ttl) {
		return `${Math.round(ctx.gapMs / 60000)} min since the previous request; cache TTL is ${ttl / 60000} min`;
	}
	if (usage.cacheWrite > 0) {
		return "prefix was written but not read; LiteLLM may have routed to a different deployment, or the cached prefix was evicted";
	}
	return "provider reported no cache activity; check that the LiteLLM deployment supports prompt caching and passes cache usage through";
}

export class CacheTracker {
	records: RequestRecord[] = [];
	private lastPayload?: PayloadInfo;
	private lastRequestAt?: number;

	reset(): void {
		this.records = [];
		this.lastPayload = undefined;
		this.lastRequestAt = undefined;
	}

	/** Seed from assistant messages already in the session (no payload facts). */
	restore(entries: Array<{ timestamp: number; model: string; usage: UsageLike }>): void {
		this.reset();
		for (const e of entries) {
			this.records.push({
				timestamp: e.timestamp,
				model: e.model,
				input: e.usage.input,
				cacheRead: e.usage.cacheRead,
				cacheWrite: e.usage.cacheWrite,
			});
		}
	}

	/** Remember the outgoing payload; returns facts compared to the previous request. */
	observeRequest(payload: PayloadInfo, now = Date.now()) {
		const previous = this.lastPayload;
		const facts = {
			payload,
			staticChanged: !!previous && previous.staticHash !== payload.staticHash,
			sharedMessages: previous ? commonPrefix(previous.messageHashes, payload.messageHashes) : 0,
			gapMs: this.lastRequestAt !== undefined ? now - this.lastRequestAt : undefined,
		};
		this.lastPayload = payload;
		this.lastRequestAt = now;
		return facts;
	}

	add(record: RequestRecord): void {
		this.records.push(record);
	}

	last(): RequestRecord | undefined {
		return this.records.at(-1);
	}

	totals(): Totals {
		const t: Totals = { requests: 0, hits: 0, input: 0, cacheRead: 0, cacheWrite: 0 };
		for (const r of this.records) {
			t.requests++;
			if (r.cacheRead > 0) t.hits++;
			t.input += r.input;
			t.cacheRead += r.cacheRead;
			t.cacheWrite += r.cacheWrite;
		}
		return t;
	}

	/** Consecutive trailing requests with no cache read (ignoring the first request). */
	missStreak(): number {
		let n = 0;
		for (let i = this.records.length - 1; i > 0 && this.records[i].cacheRead === 0; i--) n++;
		return n;
	}
}

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

export function formatPercent(rate: number | undefined): string {
	return rate === undefined ? "–" : `${Math.round(rate * 100)}%`;
}

/** Dollars saved by cache reads versus paying full input price. */
export function savings(cacheRead: number, cost: ModelCost | undefined): number | undefined {
	if (!cost || cost.input <= 0) return undefined;
	return (cacheRead * (cost.input - cost.cacheRead)) / 1e6;
}

export function formatRecord(r: RequestRecord, index: number): string {
	const rate = formatPercent(hitRate(r));
	const parts = [
		`#${index + 1}`.padEnd(4),
		rate.padStart(4),
		`read ${formatTokens(r.cacheRead)}`.padEnd(12),
		`write ${formatTokens(r.cacheWrite)}`.padEnd(13),
		`input ${formatTokens(r.input)}`.padEnd(13),
	];
	if (r.payload) parts.push(`markers ${r.payload.cacheMarkers}`);
	if (r.reconciled) parts.push("(usage fixed)");
	if (r.missReason) parts.push(`– ${r.missReason}`);
	return parts.join(" ");
}
