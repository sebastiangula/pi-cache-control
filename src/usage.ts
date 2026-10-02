/**
 * Cache-usage extraction for the raw `usage` objects returned by LiteLLM and
 * other OpenAI-compatible endpoints.
 *
 * LiteLLM normalises provider usage into the OpenAI shape, but keeps the
 * Anthropic-specific counters alongside it:
 *
 *   {
 *     "prompt_tokens": 12034,
 *     "completion_tokens": 210,
 *     "prompt_tokens_details": { "cached_tokens": 11800, "cache_creation_tokens": 0 },
 *     "cache_read_input_tokens": 11800,
 *     "cache_creation_input_tokens": 0
 *   }
 *
 * pi's openai-completions parser reads `prompt_tokens_details.cached_tokens`
 * (and OpenRouter's `cache_write_tokens`) but not `cache_creation_input_tokens`,
 * so cache writes through LiteLLM show up as plain input. This module reads
 * every known variant.
 */

export interface RawCacheUsage {
	/** Prompt tokens as reported by the endpoint (includes cached tokens on LiteLLM). */
	promptTokens: number;
	completionTokens: number;
	cacheRead: number;
	cacheWrite: number;
	/** Which fields the counters came from, for /cache debug output. */
	fields: string[];
}

/** The subset of pi's `Usage` this extension reads and rewrites. */
export interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

/** Per-million-token prices, as in pi's `Model.cost`. */
export interface ModelCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

type Json = Record<string, unknown>;

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function obj(value: unknown): Json | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
}

/** First numeric field found among `candidates`, recording which one matched. */
function pick(fields: string[], candidates: Array<[string, unknown]>): number {
	for (const [name, value] of candidates) {
		const n = num(value);
		if (n !== undefined) {
			fields.push(name);
			return n;
		}
	}
	return 0;
}

export function extractRawUsage(raw: unknown): RawCacheUsage | undefined {
	const usage = obj(raw);
	if (!usage) return undefined;
	const details = obj(usage.prompt_tokens_details) ?? {};
	const fields: string[] = [];

	const cacheRead = pick(fields, [
		["cache_read_input_tokens", usage.cache_read_input_tokens],
		["prompt_tokens_details.cached_tokens", details.cached_tokens],
		["prompt_cache_hit_tokens", usage.prompt_cache_hit_tokens],
	]);
	const cacheWrite = pick(fields, [
		["cache_creation_input_tokens", usage.cache_creation_input_tokens],
		["prompt_tokens_details.cache_creation_tokens", details.cache_creation_tokens],
		["prompt_tokens_details.cache_write_tokens", details.cache_write_tokens],
	]);

	return {
		promptTokens: num(usage.prompt_tokens) ?? num(usage.input_tokens) ?? 0,
		completionTokens: num(usage.completion_tokens) ?? num(usage.output_tokens) ?? 0,
		cacheRead,
		cacheWrite,
		fields,
	};
}

export function computeCost(usage: Omit<UsageLike, "cost" | "totalTokens">, cost: ModelCost): UsageLike["cost"] {
	const input = (usage.input * cost.input) / 1e6;
	const output = (usage.output * cost.output) / 1e6;
	const cacheRead = (usage.cacheRead * cost.cacheRead) / 1e6;
	const cacheWrite = (usage.cacheWrite * cost.cacheWrite) / 1e6;
	return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

/**
 * Merge cache counters pi missed into pi's parsed usage. Returns undefined when
 * pi's numbers already agree with the raw usage.
 *
 * pi computes `input = prompt_tokens - cacheRead - cacheWrite` using the fields
 * it knows. When we find extra cache tokens, they are moved out of `input`
 * (LiteLLM counts cached tokens inside `prompt_tokens`).
 */
export function reconcileUsage(parsed: UsageLike, raw: RawCacheUsage, cost?: ModelCost): UsageLike | undefined {
	const cacheRead = Math.max(parsed.cacheRead, raw.cacheRead);
	const cacheWrite = Math.max(parsed.cacheWrite, raw.cacheWrite);
	if (cacheRead === parsed.cacheRead && cacheWrite === parsed.cacheWrite) return undefined;

	const moved = cacheRead - parsed.cacheRead + (cacheWrite - parsed.cacheWrite);
	// If the endpoint excluded cache tokens from prompt_tokens, pi's input is already
	// net of them; only subtract what still fits.
	const input = Math.max(0, parsed.input - moved);
	const next = { input, output: parsed.output, cacheRead, cacheWrite };
	return {
		...next,
		totalTokens: input + parsed.output + cacheRead + cacheWrite,
		cost: cost ? computeCost(next, cost) : parsed.cost,
	};
}

/** Total prompt-side tokens: uncached input plus cache reads and writes. */
export function promptTotal(usage: Pick<UsageLike, "input" | "cacheRead" | "cacheWrite">): number {
	return usage.input + usage.cacheRead + usage.cacheWrite;
}

/** Fraction of prompt tokens served from cache, or undefined for an empty prompt. */
export function hitRate(usage: Pick<UsageLike, "input" | "cacheRead" | "cacheWrite">): number | undefined {
	const total = promptTotal(usage);
	return total > 0 ? usage.cacheRead / total : undefined;
}
