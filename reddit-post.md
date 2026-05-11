# Title: I built a web search extension for pi that chains 11 backends together (DuckDuckGo, Tavily, Brave, etc.)

---

## Suggested subreddits

- **r/PiAI** — primary, it's a pi package
- **r/commandline** — pi is a terminal coding agent
- **r/AI_Agents** — developer tooling adjacent
- **r/webdev** — search tooling for dev workflows

---

## Post draft

I've tried a bunch of coding agents over the past year — Claude Code, Aider, Codex CLI, all of them. My favorite was OpenCode for a while, but then I found [pi](https://pi.dev) and honestly I'm kind of in love with it. It just clicks for me.

Anyway, one thing that kept bugging me was the search tool. It worked, but it only had DuckDuckGo. No fallback. If DDG was down or slow, you just waited or got nothing.

So I scratched my own itch and built a unified search extension that chains **11 backends** together with auto-fallback. And yes, the whole thing was built using pi itself — 100%. Felt fitting. Also ran entirely on Deepseek v4, which is insanely cheap — I think the whole project cost me like 30 cents in API calls. If Tavily is rate-limited, it tries Brave. If Brave fails, it hits Exa. DuckDuckGo is always the last resort since it doesn't need a key. Works pretty well in practice.

Here's what it supports out of the box:

- **[DuckDuckGo](https://duckduckgo.com)** — no key, just works (kind of slow though, ~1.1s)
- **[Marginalia](https://www.marginalia.nu)** — anti-SEO search, public API key, surprisingly fast (350ms)
- **[Serper](https://serper.dev)** — Google results via their API, 2500 free/mo
- **[Brave Search](https://brave.com/search/api)** — metered billing ~$5/mo credit, decent speed
- **[Tavily](https://tavily.com)** — best quality results in my testing, 1000 free/mo
- **[Exa](https://exa.ai)** — fastest by far (~137ms), AI-native, 10 QPS free
- **[Firecrawl](https://firecrawl.dev)** — 500 free credits, also does crawling/extraction
- **[LangSearch](https://langsearch.com)** — actually free, no credit card
- **[WebSearchAPI](https://www.websearchapi.ai)** — Google-powered, 2000 free credits
- **[Perplexity Sonar](https://docs.perplexity.ai)** — unlimited free queries, citation-based answers
- **[SearXNG](https://docs.searxng.org)** — self-hosted metasearch, aggregates 70+ providers

Install is just `pi install npm:pi-search-multi` and you're good to go. The agent automatically picks the best backend. If you want to tweak things, you drop a JSON config in `.pi/search.json`.

I also threw in a `/search-setup` command so you can add API keys interactively without editing files, and `/search-status` to see what's active.

Also threw together a benchmark script — ran all 11 backends against real queries and scored relevance quality. [Tavily came out on top](https://github.com/ronnieops/pi-search-multi) quality-wise, Exa was the fastest. The full benchmark report is in the repo if you're into that sort of thing.

**Caveats:** API keys live in local config files (gitignored by default, but don't be that person who commits them). Marginalia's "public" key is shared so it'll be slower under load. And some backends have pretty tight free tiers — you'll probably want 2-3 keys configured before auto mode really shines.

Anyway, it's MIT licensed, open source, feedback welcome.

[https://github.com/ronnieops/pi-search-multi](https://github.com/ronnieops/pi-search-multi)

---

## Post notes (not for Reddit)

- Target audience: devs who already use pi or are curious about it
- Tone: casual dev sharing a tool, not a polished launch
- Avoid obvious GPT tells: no "In today's fast-paced AI landscape", no em dash overuse, no "delve", no closing with "What do you think?"
- Keep it real — mention the warts (slow DDG, shared Marginalia key)
