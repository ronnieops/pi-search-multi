# pi-search-multi

Unified web search extension for [pi](https://pi.dev) with **11 backend providers** (all working). One `web_search` tool, auto-fallback or combined search across backends.

## Installation

```bash
pi install npm:pi-search-multi
```

> **Note for DuckDuckGo backend:** Requires the `ddgs` Python package. Install with:
> - Linux/macOS: `pip3 install ddgs`
> - Windows: `pip install ddgs`

## Usage

After installing, just ask naturally:

```text
Search for recent AI agent frameworks.
```

```text
What's the latest news on Llama 4?
```

Or call the tool directly via `web_search` — the agent picks the best configured backend automatically.

### Combine Mode

Set `combine=true` to query **ALL enabled backends in parallel** and merge/deduplicate results:

```text
Search for "Rust vs Go performance benchmarks" with combine=true to get results from all backends
```

**Combine mode benefits:**
- Broader coverage across multiple search indexes
- Each result shows which backend found it
- URL deduplication prevents duplicates
- Useful for comprehensive research or when you want diverse sources

**Tradeoff:** Uses more API quota per query (all backends are called), but you get more comprehensive results.

## Supported Backends

| # | Backend               | Free Tier                | API Key? | How to get key                                                    |
| - | --------------------- | ------------------------ | :------: | ----------------------------------------------------------------- |
| 1 | **DuckDuckGo**        | Unlimited (rate-limited) |  **No**  | `pip install ddgs` (Linux/macOS: `pip3`)|
| 2 | **Marginalia Search** | Unlimited (rate-limited) | **No**†  | [marginalia.nu](https://www.marginalia.nu/marginalia-search/api/) |
| 3 | **Tavily**            | 1,000 calls/month        |   Yes    | [tavily.com](https://tavily.com)                                  |
| 4 | **Serper** (Google)   | 2,500 queries/month      |   Yes    | [serper.dev](https://serper.dev)                                  |
| 5 | **Brave**             | Metered ~$5/mo credit    |   Yes    | [brave.com/search/api](https://brave.com/search/api)              |
| 6 | **Firecrawl**         | 500 free credits         |   Yes    | [firecrawl.dev](https://www.firecrawl.dev)                        |
| 7 | **Exa**               | 10 QPS rate-limited      |   Yes    | [exa.ai](https://dashboard.exa.ai/api-keys)                       |
| 8 | **LangSearch**        | Genuinely free, no CC    |   Yes    | [langsearch.com](https://langsearch.com)                          |
| 9  | **WebSearchAPI.ai**   | 2,000 free credits       |   Yes    | [websearchapi.ai](https://www.websearchapi.ai)                    |
| 10 | **Perplexity Sonar**  | Unlimited free queries   |   Yes    | [perplexity.ai](https://docs.perplexity.ai)                       |
| 11 | **SearXNG**           | Self-hosted, unlimited   |  **No**  | [docs.searxng.org](https://docs.searxng.org)                      |

> † Marginalia Search uses `public` as a shared API key — no registration required, but subject to a shared rate limit.

> **SearXNG** is a self-hosted metasearch engine. Run your own instance (or use a public one), no API key required. Configure the instance URL in `.pi/search.json`.

**Removed:** Stract, UnSearch, BoardReader, EntireWeb, Search1API, FreeAPITools.dev — no longer viable (public API removed, requires payment, or endpoint not implemented).

## Benchmark Results (2026-05-04)

**All 11 backends confirmed working** across 3 test queries. Backends 1-9 scored for relevance quality (0-10); Perplexity and SearXNG added in v1.1.0.

> Latest benchmark run: 2026-05-04T18:34 UTC. Full report in [`benchmark/benchmark-report.md`](benchmark/benchmark-report.md).

**How Quality is scored:** Each result is evaluated for keyword relevance (query words matched in title/snippet), source diversity (penalty for generic search engines), and snippet completeness. The average per-result score is then normalized to a 0–10 scale. Time is shown for reference only — it is not a factor in the quality score.

### 🏆 Working Backends

| Backend               | Avg Time  |  Quality   |               Status               |
| --------------------- | :-------: | :--------: | :--------------------------------: |
| **Tavily**            |   356ms   | **3.7/10** |   ✅ Best quality, rich content    |
| **DuckDuckGo**        |  1158ms   |   3.5/10   |     ✅ Reliable, no key needed     |
| **Serper**            |   667ms   |   3.5/10   |         ✅ Google results          |
| **Firecrawl**         |   644ms   |   3.5/10   |    ✅ Search + crawl + extract     |
| **Brave**             |   460ms   |   3.5/10   |      ✅ Fast (~1 req/s free)       |
| **Exa**               | **137ms** |   3.2/10   |        ✅ AI-native search         |
| **Marginalia Search** |   354ms   |   3.0/10   |     ✅ Fastest no-key backend      |
| **LangSearch**        |  1816ms   |   3.2/10   |   ✅ 10 results/query, free tier   |
| **WebSearchAPI.ai**   |  1323ms   |   3.5/10   | ✅ Google-powered, 2K free credits |
| **Perplexity Sonar**  |    —    |    —    |   🆕 Unlimited free queries, citation-based |
| **SearXNG**           |    —    |    —    |   🆕 Self-hosted, 70+ aggregators |

## Configuration

Configure backends globally (all projects) or per-project:

**Global:** `~/.pi/agent/extensions/search.json`
**Project:** `.pi/search.json` (project takes precedence)

```json
{
  "defaultBackend": "auto",
  "backends": {
    "duckduckgo": { "enabled": true },
    "marginalia": { "enabled": true },
    "serper": { "enabled": true, "apiKey": "your-serper-key" },
    "tavily": { "enabled": true, "apiKey": "your-tavily-key" },
    "brave": { "enabled": true, "apiKey": "your-brave-key" },
    "exa": { "enabled": true, "apiKey": "your-exa-key" },
    "firecrawl": { "enabled": true, "apiKey": "your-firecrawl-key" },
    "langsearch": { "enabled": true, "apiKey": "your-langsearch-key" },
    "websearchapi": { "enabled": true, "apiKey": "your-websearchapi-key" },
    "perplexity": { "enabled": true, "apiKey": "your-perplexity-key" },
    "searxng": { "enabled": true, "instanceUrl": "http://localhost:8888" }
  }
}
```

See [`search.json.example`](search.json.example) for a full template.

Or use the interactive setup:

```
/search-setup
```

## Commands

| Command          | Description                                              |
| ---------------- | -------------------------------------------------------- |
| `/search-setup`  | Interactive prompt to configure API keys for any backend |
| `/search-status` | Show which backends are active and which have keys       |

## How auto mode works

### Fallback Mode (default, `combine=false`)

1. Tries each enabled backend in order from your config
2. If a backend fails (rate limit, auth error, etc.), moves to the next one
3. DuckDuckGo requires no API key and is always included as a safety net
4. Returns results from the first backend that succeeds
5. If all backends fail, reports the collected errors

### Combine Mode (`combine=true`)

1. Queries **ALL** enabled backends in parallel
2. Each backend receives `numResults / numBackends` as a target
3. Results are merged and deduplicated by URL
4. Each result shows its source backend (e.g., `*Source: Tavily*`)
5. Backend statistics are displayed (which succeeded, result counts, errors)
6. If any backend fails, its error is shown but others still contribute results

## Security

- API keys are stored in local config files only (`~/.pi/agent/extensions/search.json` or `.pi/search.json`), never sent to any third party besides the chosen backend
- DuckDuckGo queries are executed via spawned Python subprocess (no temp files, abortable via signal)
- All HTTP backends have a 30-second timeout to prevent hanging requests
- Error messages are sanitized — API response bodies are truncated and key-like patterns are redacted before being returned
- The `.pi/` directory is in `.gitignore` — **never commit API keys to version control**

## Testing

```bash
# Run the full benchmark against all backends
node benchmark/benchmark.mjs

# Quick test via curl with your configured key
curl -X POST "https://api.exa.ai/search" \
  -H "Content-Type: application/json" \
  -H "x-api-key: $KEY" \
  -d '{"query": "test", "numResults": 3, "contents": {"text": true}}'

# Quick test Perplexity Sonar
curl -X POST "https://api.perplexity.ai/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $KEY" \
  -d '{"model": "sonar", "messages": [{"role": "user", "content": "test"}], "search_context_size": "low"}'

# Quick test SearXNG (replace URL with your instance)
curl "http://localhost:8888/search?q=test&format=json&count=3"
```

## Adding a new backend

Backends are just async functions that return `{ results: [{ title, url, snippet }] }`. See `extensions/pi-search.ts` for examples.

## License

MIT

---

<p align="center">Proudly created with <a href="https://pi.dev">pi</a></p>
