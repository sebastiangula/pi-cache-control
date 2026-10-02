# pi-cache-control

A [pi](https://github.com/badlogic/pi-mono) extension that shows whether prompt caching is actually working, with a focus on models served through a [LiteLLM](https://github.com/BerriAI/litellm) proxy.

When pi talks to LiteLLM via `openai-completions`, cache problems are easy to miss: Claude models only cache when `cache_control` markers are sent, and LiteLLM reports cache writes as `cache_creation_input_tokens`, which pi's OpenAI-compatible parser ignores. The writes then show up as ordinary input tokens, and cost is wrong.

## What it does

- **Footer status** after every response: `cache 91% 3.0k read · session 46%`, `cache write 3.0k`, or `cache miss`.
- **Miss warnings**, once per streak of misses, with a likely reason:
  - no `cache_control` markers sent to a Claude model
  - prompt below the ~1024-token minimum
  - system prompt or tool definitions changed
  - conversation history rewritten (compaction, branch switch)
  - gap longer than the cache TTL (5 min, or 1 h with `PI_CACHE_RETENTION=long`)
  - prefix written but never read (LiteLLM routing to another deployment, eviction)
- **Usage fix-up**: reads the raw `usage` from the response stream and, when it contains cache counters pi missed, rewrites the assistant message's usage (and cost) before it is saved. pi's own footer and session stats then show the right numbers.
- **`/cache`**: session report with hit rate, tokens read/written, estimated savings, and the last 15 requests.
- **`/cache inject on|off`**: adds Anthropic-style `cache_control` markers (system prompt, last tool, last message) to chat-completions requests that have none.
- **`/cache debug`**: shows the last raw `usage` object and which fields were read.

## Install

```bash
pi install git:github.com/sebastiangula/pi-cache-control
# or try it for one run
pi -e git:github.com/sebastiangula/pi-cache-control
# or from a checkout
pi -e ./extensions/cache-control.ts
```

## Making LiteLLM cache Claude prompts

The proper fix is to tell pi to send markers for that model, in `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "litellm": {
      "baseUrl": "http://localhost:4000/v1",
      "api": "openai-completions",
      "apiKey": "sk-...",
      "models": [
        {
          "id": "claude-sonnet-4-5",
          "compat": { "cacheControlFormat": "anthropic" },
          "cost": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 }
        }
      ]
    }
  }
}
```

`/cache inject on` (or `PI_CACHE_CONTROL_INJECT=1`) does the same from the extension without editing config. Set `cost` on LiteLLM models if you want savings estimates and correct cost.

OpenAI, DeepSeek and Gemini models cache automatically; for those the extension only tracks and reports.

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `PI_CACHE_CONTROL_INJECT` | off | Start with marker injection on. |
| `PI_CACHE_CONTROL_SNIFF` | on | Set to `0` to stop reading raw response usage (disables the usage fix-up). |
| `PI_CACHE_RETENTION` | – | pi's own setting; `long` makes injected markers use a 1 h TTL and changes the TTL used in miss diagnosis. |

## How the raw usage is read

Extensions only see pi's parsed usage. To recover LiteLLM's extra fields, the extension wraps `globalThis.fetch` once per process and, for the single request pi is about to send to the current `openai-completions` model's `baseUrl`, reads a `clone()` of the response in the background. The response pi consumes is untouched, and any error in this path is swallowed. `anthropic-messages` models are not sniffed: pi already parses their cache counters.

Supported usage fields: `cache_read_input_tokens`, `cache_creation_input_tokens` (LiteLLM/Anthropic), `prompt_tokens_details.cached_tokens` / `cache_creation_tokens` / `cache_write_tokens` (OpenAI, LiteLLM, OpenRouter), `prompt_cache_hit_tokens` (DeepSeek).

## Development

```bash
npm install
npm run check   # tsc + node --test
```
