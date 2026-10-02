/**
 * pi-cache-control: shows whether prompt caching is actually working, with a
 * focus on models served through a LiteLLM proxy.
 *
 * - Footer status with the last request's cache hit rate and the session rate.
 * - Warns (once per streak) when requests stop hitting the cache, with a reason.
 * - Recovers cache-write counts that pi's OpenAI-compatible parser drops for
 *   LiteLLM (`cache_creation_input_tokens`) and fixes the session's usage/cost.
 * - `/cache` for a per-request report, `/cache inject on|off` to add
 *   Anthropic `cache_control` markers to chat-completions requests.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { injectCacheMarkers, inspectPayload, type PayloadInfo } from "../src/payload.ts";
import { installSniffer } from "../src/sniffer.ts";
import { CacheTracker, diagnoseMiss, formatPercent, formatRecord, formatTokens, savings } from "../src/tracker.ts";
import { extractRawUsage, hitRate, reconcileUsage, type RawCacheUsage, type UsageLike } from "../src/usage.ts";

const STATUS_KEY = "cache-control";
/** How long message_end waits for the background read of the raw response. */
const SNIFF_WAIT_MS = 1500;
const REPORT_ROWS = 15;

interface PendingRequest {
	modelId: string;
	facts: ReturnType<CacheTracker["observeRequest"]>;
	rawUsage?: Promise<unknown>;
}

function envFlag(name: string): boolean | undefined {
	const v = process.env[name]?.toLowerCase();
	if (v === undefined || v === "") return undefined;
	return v === "1" || v === "true" || v === "on" || v === "yes";
}

function isLiteLLM(model: ExtensionContext["model"]): boolean {
	if (!model) return false;
	return /litellm/i.test(`${model.provider} ${model.baseUrl}`);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
	return Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms).unref())]);
}

export default function cacheControl(pi: ExtensionAPI) {
	const tracker = new CacheTracker();
	let pending: PendingRequest | undefined;
	let sniffArmed: { baseUrl: string } | undefined;
	let lastRaw: { raw: unknown; parsed?: RawCacheUsage } | undefined;
	let litellmHeadersSeen = false;
	let warnedStreak = 0;
	let inject = envFlag("PI_CACHE_CONTROL_INJECT") ?? false;
	const sniff = envFlag("PI_CACHE_CONTROL_SNIFF") ?? true;
	const longRetention = process.env.PI_CACHE_RETENTION === "long";

	installSniffer(
		sniff
			? {
					target() {
						const target = sniffArmed;
						sniffArmed = undefined;
						return target;
					},
					onResponse(usage) {
						if (pending) pending.rawUsage = usage;
					},
				}
			: undefined,
	);

	function updateStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		const last = tracker.last();
		if (!last) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const theme = ctx.ui.theme;
		const totals = tracker.totals();
		const session = formatPercent(hitRate(totals));
		let text: string;
		if (last.cacheRead > 0) {
			text = theme.fg("success", `cache ${formatPercent(hitRate(last))}`) + theme.fg("dim", ` ${formatTokens(last.cacheRead)} read`);
		} else if (last.cacheWrite > 0) {
			text = theme.fg("accent", "cache write") + theme.fg("dim", ` ${formatTokens(last.cacheWrite)}`);
		} else if (tracker.records.length > 1 || last.missReason) {
			text = theme.fg("warning", "cache miss");
		} else {
			text = theme.fg("dim", "cache –");
		}
		ctx.ui.setStatus(STATUS_KEY, `${text}${theme.fg("dim", ` · session ${session}`)}`);
	}

	function restore(ctx: ExtensionContext) {
		const entries: Array<{ timestamp: number; model: string; usage: UsageLike }> = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const m = entry.message;
			if (!m.usage || m.usage.input + m.usage.cacheRead + m.usage.cacheWrite === 0) continue;
			entries.push({ timestamp: m.timestamp, model: `${m.provider}/${m.model}`, usage: m.usage });
		}
		tracker.restore(entries);
		pending = undefined;
		warnedStreak = 0;
		updateStatus(ctx);
	}

	pi.on("session_start", async (_event, ctx) => restore(ctx));
	pi.on("session_tree", async (_event, ctx) => restore(ctx));
	pi.on("model_select", async (_event, ctx) => updateStatus(ctx));

	pi.on("before_provider_request", (event, ctx) => {
		let payload = event.payload;
		if (inject && ctx.model?.api === "openai-completions") {
			payload = injectCacheMarkers(payload, longRetention ? "1h" : undefined) ?? payload;
		}
		const info: PayloadInfo = inspectPayload(payload);
		pending = { modelId: ctx.model?.id ?? "", facts: tracker.observeRequest(info) };
		// Anthropic-messages responses are parsed fully by pi; only chat-completions needs the raw read.
		sniffArmed = sniff && ctx.model?.api === "openai-completions" ? { baseUrl: ctx.model.baseUrl } : undefined;
		return payload === event.payload ? undefined : payload;
	});

	pi.on("after_provider_response", (event) => {
		if (Object.keys(event.headers).some((h) => h.toLowerCase().startsWith("x-litellm-"))) litellmHeadersSeen = true;
	});

	pi.on("message_end", async (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant" || !message.usage) return;
		const request = pending;
		pending = undefined;
		sniffArmed = undefined;

		let usage: UsageLike = message.usage;
		let reconciled = false;
		if (request?.rawUsage) {
			const raw = await withTimeout(request.rawUsage, SNIFF_WAIT_MS);
			const parsed = extractRawUsage(raw);
			lastRaw = { raw, parsed };
			const fixed = parsed && reconcileUsage(usage, parsed, ctx.model?.cost);
			if (fixed) {
				usage = fixed;
				reconciled = true;
			}
		}
		if (usage.input + usage.cacheRead + usage.cacheWrite === 0) return;

		const previous = tracker.last();
		const missReason = diagnoseMiss(usage, {
			modelId: request?.modelId ?? message.model,
			payload: request?.facts.payload,
			previous,
			staticChanged: request?.facts.staticChanged ?? false,
			sharedMessages: request?.facts.sharedMessages ?? 0,
			gapMs: request?.facts.gapMs,
			longRetention,
		});
		tracker.add({
			timestamp: message.timestamp,
			model: `${message.provider}/${message.model}`,
			input: usage.input,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			payload: request?.facts.payload,
			sharedMessages: request?.facts.sharedMessages,
			staticChanged: request?.facts.staticChanged,
			gapMs: request?.facts.gapMs,
			reconciled,
			missReason,
		});

		const streak = tracker.missStreak();
		if (streak === 0) {
			warnedStreak = 0;
		} else if (warnedStreak === 0 && missReason && ctx.hasUI) {
			warnedStreak = streak;
			ctx.ui.notify(`Prompt cache miss: ${missReason}`, "warning");
		}
		updateStatus(ctx);

		return reconciled ? { message: { ...message, usage } } : undefined;
	});

	function report(ctx: ExtensionContext): string {
		const model = ctx.model;
		const totals = tracker.totals();
		const lines: string[] = [];
		const via = isLiteLLM(model) || litellmHeadersSeen ? " (via LiteLLM)" : "";
		lines.push(`Model: ${model ? `${model.provider}/${model.id} [${model.api}]` : "none"}${via}`);
		lines.push(
			`Session: ${totals.requests} requests, ${totals.hits} with cache hits, hit rate ${formatPercent(hitRate(totals))}`,
		);
		lines.push(
			`Tokens: ${formatTokens(totals.cacheRead)} read from cache, ${formatTokens(totals.cacheWrite)} written, ${formatTokens(totals.input)} uncached`,
		);
		const saved = savings(totals.cacheRead, model?.cost);
		if (saved !== undefined) lines.push(`Estimated savings: $${saved.toFixed(4)}`);
		lines.push(`Marker injection: ${inject ? "on" : "off"} · raw usage sniffing: ${sniff ? "on" : "off"}`);
		const lastPayload = tracker.records.findLast((r) => r.payload)?.payload;
		if (lastPayload) {
			lines.push(
				`Last request: ${lastPayload.cacheMarkers} cache_control markers, prompt_cache_key ${lastPayload.promptCacheKey ? "set" : "not set"}`,
			);
		}
		const rows = tracker.records.slice(-REPORT_ROWS);
		if (rows.length > 0) {
			lines.push("", `Last ${rows.length} requests:`);
			const offset = tracker.records.length - rows.length;
			rows.forEach((r, i) => lines.push(formatRecord(r, offset + i)));
		}
		return lines.join("\n");
	}

	pi.registerCommand("cache", {
		description: "Prompt cache report; /cache inject on|off, /cache debug",
		getArgumentCompletions: (prefix) => {
			const items = ["inject on", "inject off", "debug"].map((value) => ({ value, label: value }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const [sub, value] = args.trim().split(/\s+/);
			if (sub === "inject") {
				if (value === "on" || value === "off") inject = value === "on";
				ctx.ui.notify(
					`cache_control marker injection ${inject ? "on" : "off"}` +
						(inject && ctx.model?.api !== "openai-completions"
							? ` (only applies to openai-completions models; current is ${ctx.model?.api})`
							: ""),
					"info",
				);
				return;
			}
			if (sub === "debug") {
				ctx.ui.notify(
					lastRaw
						? `Last raw usage:\n${JSON.stringify(lastRaw.raw, null, 2)}\nRead from: ${lastRaw.parsed?.fields.join(", ") || "nothing"}`
						: "No raw usage captured yet (only chat-completions responses are read).",
					"info",
				);
				return;
			}
			ctx.ui.notify(report(ctx), "info");
		},
	});
}
