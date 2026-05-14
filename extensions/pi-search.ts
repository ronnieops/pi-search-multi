/**
 * Extension — Unified web search (12 backends) + content extraction (web_read)
 *
 * Backends (choose any, all disabled by default):
 *   duckduckgo    — ✅ Free, no key, via Python ddgs lib. Rate-limited.
 *   jina          — ✅ Free, no key, full markdown content via s.jina.ai (12th backend)
 *   marginalia    — ✅ Anti-SEO, "public" key optional. 354ms avg
 *   serper        — ✅ Google via serper.dev, 2500 free/mo. 667ms
 *   brave         — ✅ Brave Search, 2000 free/mo. 460ms
 *   tavily        — ✅ AI search, 1000 free/mo. 356ms BEST QUALITY
 *   exa           — ✅ AI-native, 10 QPS free tier. 137ms FASTEST
 *   firecrawl     — ✅ Search+crawl, 500 free credits. 644ms
 *   langsearch    — ✅ Free tier, no CC. 1816ms
 *   websearchapi  — ✅ Google-powered, 2000 free credits. 1323ms
 *   perplexity    — ✅ Unlimited free Sonar, citation-based answers
 *   searxng       — ✅ Self-hosted, 70+ aggregators. Needs instance URL
 *
 * Tools: web_search (auto-fallback + RRF combine mode), web_read (URL content)
 * Config: ~/.pi/agent/extensions/search.json + .pi/search.json (project wins)
 * Credentials: env var refs (ALL_CAPS), shell commands (!command), or literal keys
 *
 * Example .pi/search.json:
 *   {
 *     "defaultBackend": "auto",
 *     "backends": {
 *       "duckduckgo": { "enabled": true },
 *       "marginalia": { "enabled": true },
 *       "serper": { "enabled": true, "apiKey": "..." },
 *       "tavily": { "enabled": true, "apiKey": "..." },
 *       "exa": { "enabled": true, "apiKey": "..." },
 *       "firecrawl": { "enabled": true, "apiKey": "..." },
 *       "langsearch": { "enabled": true, "apiKey": "..." },
 *       "websearchapi": { "enabled": true, "apiKey": "..." },
 *       "perplexity": { "enabled": true, "apiKey": "..." },
 *       "searxng": { "enabled": true, "instanceUrl": "http://localhost:8888" }
 *     }
 *   }
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Types & Config
// ---------------------------------------------------------------------------

interface BackendConfig {
	enabled?: boolean;
	apiKey?: string;
	/** SearXNG-specific: base URL of the self-hosted instance (e.g. http://localhost:8888) */
	instanceUrl?: string;
}

interface SearchConfig {
	defaultBackend?: string;
	backends?: {
		duckduckgo?: BackendConfig;
		marginalia?: BackendConfig;

		serper?: BackendConfig;
		tavily?: BackendConfig;
		exa?: BackendConfig;
		brave?: BackendConfig;
		langsearch?: BackendConfig;
		firecrawl?: BackendConfig;
		websearchapi?: BackendConfig;
		perplexity?: BackendConfig;
		searxng?: BackendConfig;
	};
}

function getAgentDir(): string {
	return join(process.env.HOME || process.env.USERPROFILE || "~", ".pi", "agent");
}

const commandValueCache = new Map<string, { value?: string; errorMessage?: string }>();
const COMMAND_TIMEOUT_MS = 5_000;

/**
 * Resolve a credential reference à la pi-web-providers:
 *   • "!command"   → execute shell command, return trimmed stdout (cached)
 *   • "ALL_CAPS"   → read process.env[ALL_CAPS]
 *   • otherwise     → return as literal string (actual key)
 */
function resolveConfigValue(reference: string | undefined): string | undefined {
	if (!reference) return undefined;

	// !command — execute shell command, cache result
	if (reference.startsWith("!")) {
		const cached = commandValueCache.get(reference);
		if (cached) {
			if (cached.errorMessage) throw new Error(cached.errorMessage);
			return cached.value;
		}
		try {
			const output = execSync(reference.slice(1), {
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: COMMAND_TIMEOUT_MS,
			})
				.trim();
			const value = output.length > 0 ? output : undefined;
			commandValueCache.set(reference, { value });
			return value;
		} catch (error) {
			const errorMessage = (error as Error).message;
			commandValueCache.set(reference, { errorMessage });
			throw error;
		}
	}

	// ALL_CAPS → env var lookup
	const envValue = process.env[reference];
	if (envValue !== undefined) return envValue;
	if (/^[A-Z][A-Z0-9_]*$/.test(reference)) {
		// Warn: value looks like an env var reference but the env var is unset.
		// If this was intended as a literal key, rename it or set the env var.
		console.warn(`[pi-search] Credential reference "${reference}" matches ALL_CAPS env-var pattern ` +
			`but process.env.${reference} is not set. If this is a literal key, ` +
			`use a different name to avoid confusion.`);
		return undefined;
	}

	// Otherwise → literal string (actual key in config)
	return reference;
}

/** Convenience env vars checked as fallback when config has no apiKey for a backend. */
const FALLBACK_ENV_MAP: Record<string, string> = {
	jina: "SEARCH_JINA_API_KEY",
	serper: "SEARCH_SERPER_API_KEY",
	tavily: "SEARCH_TAVILY_API_KEY",
	exa: "SEARCH_EXA_API_KEY",
	brave: "SEARCH_BRAVE_API_KEY",
	langsearch: "SEARCH_LANGSEARCH_API_KEY",
	firecrawl: "SEARCH_FIRECRAWL_API_KEY",
	websearchapi: "SEARCH_WEBSEARCHAPI_API_KEY",
	perplexity: "SEARCH_PERPLEXITY_API_KEY",
};

/** Invalidate cached shell-command credentials so key rotation takes effect. */
function clearCredentialCache(): void {
	commandValueCache.clear();
}

/** Lazy resolution: config.apiKey → resolveConfigValue() → FALLBACK_ENV_MAP fallback. */
function resolveBackendKey(backend: string): string | undefined {
	const bc = config.backends?.[backend as keyof typeof config.backends];
	if (bc?.apiKey) {
		const resolved = resolveConfigValue(bc.apiKey);
		if (resolved) return resolved;
	}
	const fallbackEnv = FALLBACK_ENV_MAP[backend];
	if (fallbackEnv) {
		const envValue = process.env[fallbackEnv];
		if (envValue && envValue.trim().length > 0) return envValue.trim();
	}
	return undefined;
}

/** Describe where a backend's key comes from (for search-status display). */
function getKeySource(backend: string): { configured: boolean; source: string } {
	const bc = config.backends?.[backend as keyof typeof config.backends];
	if (!bc?.apiKey) {
		const fallbackEnv = FALLBACK_ENV_MAP[backend];
		if (fallbackEnv && process.env[fallbackEnv]) {
			return { configured: true, source: `env:${fallbackEnv}` };
		}
		return { configured: false, source: "" };
	}
	const ref = bc.apiKey;
	if (ref.startsWith("!")) {
		return { configured: true, source: `shell:${ref.slice(0, 40)}...` };
	}
	if (/^[A-Z][A-Z0-9_]*$/.test(ref)) {
		const envValue = process.env[ref];
		if (envValue) return { configured: true, source: `env:${ref}` };
		return { configured: false, source: `env:${ref} (unset)` };
	}
	return { configured: true, source: "literal" };
}



function loadConfig(cwd: string): SearchConfig {
	const globalPath = join(getAgentDir(), "extensions", "search.json");
	const projectPath = join(cwd, ".pi", "search.json");

	let config: SearchConfig = { defaultBackend: "duckduckgo", backends: {} };

	if (existsSync(globalPath)) {
		try {
			config = { ...config, ...JSON.parse(readFileSync(globalPath, "utf-8")) };
		} catch {
			// ignore
		}
	}

	// Save global backends before project config overwrites them
	const preProjectBackends = { ...(config.backends ?? {}) };

	if (existsSync(projectPath)) {
		try {
			const project = JSON.parse(readFileSync(projectPath, "utf-8"));
			config = { ...config, ...project };
			if (project.backends) {
				// Deep merge: merge per-backend so global backends not re-listed in project config are preserved
				const merged = { ...preProjectBackends, ...config.backends };
				for (const [key, val] of Object.entries(project.backends)) {
					if (val && merged[key]) {
						merged[key] = { ...merged[key], ...val };
					} else {
						merged[key] = val;
					}
				}
				config.backends = merged;
			}
		} catch {
			// ignore
		}
	}

	// Auto-enable backends that have a convenience env var but no explicit config yet.
	// Only enables if the backend is not explicitly disabled (enabled !== false).
	for (const [backend, envVar] of Object.entries(FALLBACK_ENV_MAP)) {
		const envValue = process.env[envVar];
		if (envValue && envValue.trim().length > 0) {
			const configBackends = config.backends ?? {};
			const existing = configBackends[backend as keyof typeof configBackends];
			if (!existing || existing.enabled === undefined) {
				if (!config.backends) config.backends = {};
				(config.backends as Record<string, BackendConfig>)[backend] = {
					...existing,
					enabled: true,
				};
			}
		}
	}

	return config;
}

const MISSING_KEY_HELP =
	"Set the API key via env var (e.g. SEARCH_<BACKEND>_API_KEY), " +
	"config reference (e.g. \"apiKey\": \"SOME_ENV_VAR\"), " +
	"shell command (\"apiKey\": \"!pass show api/backend\"), " +
	"or a literal key in ~/.pi/agent/extensions/search.json or .pi/search.json. " +
	"DuckDuckGo & Marginalia need no key.";

const HTTP_TIMEOUT_MS = 30_000;

/** Simple per-backend cooldown to avoid hammering rate-limited APIs. */
const COOLDOWN_MS = 2_000;
const backendCooldowns = new Map<string, number>();

function waitForCooldown(backend: string): Promise<void> {
	const until = backendCooldowns.get(backend);
	if (!until) return Promise.resolve();
	const delay = until - Date.now();
	if (delay <= 0) return Promise.resolve();
	return new Promise(r => setTimeout(r, delay));
}

function markCooldown(backend: string) {
	backendCooldowns.set(backend, Date.now() + COOLDOWN_MS);
}

/** Combine an optional caller signal with a default timeout. */
function timeoutSignal(signal?: AbortSignal): AbortSignal | undefined {
	if (!signal) return AbortSignal.timeout(HTTP_TIMEOUT_MS);
	return AbortSignal.any([signal, AbortSignal.timeout(HTTP_TIMEOUT_MS)]);
}

/** Sanitize API error text — truncate and strip potential secrets. */
function sanitizeError(status: number, text: string): string {
	const safe = text
		// Redact "Bearer <token>" and "Token <value>" patterns
		.replace(/(bearer|token)\s+[\w.\/-]{8,}/gi, "$1 [redacted]")
		// Redact key=value or "key": "value" pairs for known secret keys
		.replace(/(api[-_]?key|bearer|token|authorization|secret|password)["']?\s*[:=]\s*["']?[\w.\/-]{8,}/gi, "[redacted]")
		// Redact JSON key-value pairs where the value looks like a key
		.replace(/"(?:api[-_]?key|apiKey|token|secret|password|bearer)"\s*:\s*"[^"']{8,}"/gi, '"[redacted]"')
		// Redact x-api-key / Authorization header values in raw text
		.replace(/(x-api-key|authorization)\s*:\s*[\w.\/-]{8,}/gi, "$1: [redacted]")
		.slice(0, 300);
	return `API error (${status}): ${safe}`;
}


// ---------------------------------------------------------------------------
// Backend: DuckDuckGo (free, no key needed)
// ---------------------------------------------------------------------------

interface DuckDuckGoResult {
	title: string;
	url: string;
	snippet: string;
}

async function searchDuckDuckGo(
	query: string,
	numResults: number,
	signal?: AbortSignal,
): Promise<{ results: DuckDuckGoResult[] }> {
	if (signal?.aborted) throw new Error("DuckDuckGo search aborted");

	const pyScript = `
import json, sys
from ddgs import DDGS
results = []
with DDGS() as ddgs:
    for i, r in enumerate(ddgs.text(${JSON.stringify(query)}, max_results=${numResults})):
        results.append({"title": r.get("title",""), "url": r.get("href",""), "snippet": r.get("body","")})
print(json.dumps({"results": results}))
`;

	return new Promise((resolve, reject) => {
		const pythonCmd = process.platform === "win32" ? "python" : "python3";
		const proc = spawn(pythonCmd, ["-c", pyScript], {
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
		proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

		// Timeout timer
		const timeout = setTimeout(() => {
			proc.kill();
			reject(new Error("DuckDuckGo search timed out"));
		}, HTTP_TIMEOUT_MS);

		// Abort signal handler
		const onAbort = () => {
			clearTimeout(timeout);
			proc.kill();
			reject(new Error("DuckDuckGo search aborted"));
		};
		if (signal) {
			if (signal.aborted) { clearTimeout(timeout); reject(new Error("DuckDuckGo search aborted")); return; }
			signal.addEventListener("abort", onAbort, { once: true });
		}

		proc.on("close", (code) => {
			clearTimeout(timeout);
			if (signal) signal.removeEventListener("abort", onAbort);
			if (code === 0) {
				try {
					resolve(JSON.parse(stdout.trim()));
				} catch {
					reject(new Error(`DuckDuckGo search: invalid JSON output: ${stdout.slice(0, 200)}`));
				}
			} else {
				const msg = stderr.trim().slice(0, 300);
				reject(new Error(`DuckDuckGo search failed (exit ${code}): ${msg || "unknown error"}`));
			}
		});

		proc.on("error", (err) => {
			clearTimeout(timeout);
			if (signal) signal.removeEventListener("abort", onAbort);
			reject(new Error(`DuckDuckGo search failed: ${err.message}`));
		});
	});
}

// ---------------------------------------------------------------------------
// Backend: Marginalia Search (anti-SEO independent search, uses "public" key)
// ---------------------------------------------------------------------------

async function searchMarginalia(
	query: string,
	numResults: number,
	apiKey: string | undefined,
	signal?: AbortSignal,
): Promise<{ results: Array<{ title: string; url: string; snippet: string }> }> {
	const key = apiKey || "public";
	const response = await fetch(
		`https://api.marginalia.nu/${encodeURIComponent(key)}/search/${encodeURIComponent(query)}?index=0&count=${Math.min(numResults, 50)}`,
		{
			signal: timeoutSignal(signal),
			headers: { "Accept": "application/json" },
		},
	);

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Marginalia ${sanitizeError(response.status, text)}`);
	}

	const data = (await response.json()) as Record<string, unknown>;
	const results = (data.results || []) as Array<Record<string, unknown>>;

	return {
		results: results.slice(0, numResults).map((r) => ({
			title: (r.title as string) || "",
			url: (r.url as string) || "",
			snippet: (r.description as string || "").slice(0, 500),
		})),
	};
}

// ---------------------------------------------------------------------------
// Backend: Serper.dev (Google search, needs API key)
// ---------------------------------------------------------------------------

async function searchSerper(
	query: string,
	numResults: number,
	apiKey: string,
	signal?: AbortSignal,
): Promise<{ results: Array<{ title: string; url: string; snippet: string }> }> {
	const body = { q: query, num: Math.min(numResults, 100) };
	const response = await fetch("https://google.serper.dev/search", {
		method: "POST",
		headers: {
			"X-API-KEY": apiKey,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal: timeoutSignal(signal),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Serper ${sanitizeError(response.status, text)}`);
	}
	const data = (await response.json()) as Record<string, unknown>;
	const rawResults = data.organic;
	const results = Array.isArray(rawResults) ? rawResults : [];
	return {
		results: results.slice(0, numResults).map((r) => ({
			title: (r.title as string) || "",
			url: (r.link as string) || "",
			snippet: (r.snippet as string) || "",
		})),
	};
}

// ---------------------------------------------------------------------------
// Backend: Tavily (AI-agent search, needs API key)
// ---------------------------------------------------------------------------

async function searchTavily(
	query: string,
	numResults: number,
	apiKey: string,
	signal?: AbortSignal,
): Promise<{ results: Array<{ title: string; url: string; snippet: string; content?: string }> }> {
	const body = {
		query,
		max_results: Math.min(numResults, 20),
		include_answer: false,
	};
	const response = await fetch("https://api.tavily.com/search", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
		signal: timeoutSignal(signal),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Tavily ${sanitizeError(response.status, text)}`);
	}
	const data = (await response.json()) as Record<string, unknown>;
	const rawResults = data.results;
	const results = Array.isArray(rawResults) ? rawResults : [];
	return {
		results: results.slice(0, numResults).map((r) => ({
			title: (r.title as string) || "",
			url: (r.url as string) || "",
			snippet: (r.content as string) || "",
			content: r.content as string,
		})),
	};
}

// ---------------------------------------------------------------------------
// Backend: Exa (optional, needs API key)
// ---------------------------------------------------------------------------

async function searchExa(
	query: string,
	numResults: number,
	apiKey: string,
	signal?: AbortSignal,
): Promise<{ results: Array<{ title: string; url: string; snippet?: string }> }> {
	const body = {
		query,
		numResults: Math.min(numResults, 25),
		contents: { text: true, highlights: true },
	};
	const response = await fetch("https://api.exa.ai/search", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": apiKey,
		},
		body: JSON.stringify(body),
		signal: timeoutSignal(signal),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		let detail = text;
		try {
			const json = JSON.parse(text);
			detail = json.error || json.message || text;
		} catch {
			// use raw
		}
		throw new Error(`Exa ${sanitizeError(response.status, detail)}`);
	}
	const data = (await response.json()) as Record<string, unknown>;
	const rawResults = data.results;
	const results = Array.isArray(rawResults) ? rawResults : [];
	return {
		results: results.slice(0, numResults).map((r) => ({
			title: (r.title as string) || "",
			url: (r.url as string) || "",
			snippet: ((r.text as string) || (r.highlight as string) || "").slice(0, 500),
		})),
	};
}

// ---------------------------------------------------------------------------
// Backend: Brave Search (metered billing ~$5/mo credit, needs API key)
// ---------------------------------------------------------------------------

async function searchBrave(
	query: string,
	numResults: number,
	apiKey: string,
	signal?: AbortSignal,
): Promise<{ results: Array<{ title: string; url: string; snippet?: string }> }> {
	const params = new URLSearchParams({ q: query, count: String(Math.min(numResults, 20)) });
	const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
		method: "GET",
		headers: {
			"Accept": "application/json",
			"Accept-Encoding": "gzip",
			"X-Subscription-Token": apiKey,
		},
		signal: timeoutSignal(signal),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Brave ${sanitizeError(response.status, text)}`);
	}
	const data = (await response.json()) as Record<string, unknown>;
	const web = data.web;
	if (!web || typeof web !== "object") {
		return { results: [] };
	}
	const rawResults = (web as Record<string, unknown>).results;
	const results = Array.isArray(rawResults) ? rawResults : [];
	return {
		results: results.slice(0, numResults).map((r) => ({
			title: (r.title as string) || "",
			url: (r.url as string) || "",
			snippet: (r.description as string || "").slice(0, 500),
		})),
	};
}

// ---------------------------------------------------------------------------
// Backend: LangSearch (genuinely free tier, no credit card, needs API key)
// Endpoint: POST /v1/web-search, auth: Authorization: Bearer
// ---------------------------------------------------------------------------

async function searchLangSearch(
	query: string,
	numResults: number,
	apiKey: string,
	signal?: AbortSignal,
): Promise<{ results: Array<{ title: string; url: string; snippet?: string }> }> {
	const body = { query, max_results: Math.min(numResults, 20) };
	const response = await fetch("https://api.langsearch.com/v1/web-search", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Authorization": `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
		signal: timeoutSignal(signal),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`LangSearch ${sanitizeError(response.status, text)}`);
	}
	const data = (await response.json()) as Record<string, unknown>;
	const pages = (data.data as Record<string, unknown>)?.webPages as Record<string, unknown> | undefined;
	const results = (pages?.value || data.results || data.data || []) as Array<Record<string, unknown>>;
	return {
		results: results.slice(0, numResults).map((r) => ({
			title: (r.name as string) || (r.title as string) || "",
			url: (r.url as string) || (r.link as string) || "",
			snippet: ((r.snippet as string) || (r.description as string) || "").slice(0, 500),
		})),
	};
}

// ---------------------------------------------------------------------------
// Backend: Firecrawl (500 free credits, search+crawl+extract, needs API key)
// ---------------------------------------------------------------------------

async function searchFirecrawl(
	query: string,
	numResults: number,
	apiKey: string,
	signal?: AbortSignal,
): Promise<{ results: Array<{ title: string; url: string; snippet?: string }> }> {
	const body = { query, limit: Math.min(numResults, 20) };
	const response = await fetch("https://api.firecrawl.dev/v1/search", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Authorization": `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
		signal: timeoutSignal(signal),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Firecrawl ${sanitizeError(response.status, text)}`);
	}
	const data = (await response.json()) as Record<string, unknown>;
	const results = (data.data || data.results || []) as Array<Record<string, unknown>>;
	return {
		results: results.slice(0, numResults).map((r) => ({
			title: (r.title as string) || "",
			url: (r.url as string) || "",
			snippet: ((r.description as string) || (r.snippet as string) || "").slice(0, 500),
		})),
	};
}

// ---------------------------------------------------------------------------
// Backend: WebSearchAPI.ai (2000 free credits, needs API key)
// Endpoint: POST /ai-search, auth: Authorization: Bearer
// Params: maxResults, includeContent, country, language
// ---------------------------------------------------------------------------

async function searchWebSearchAPI(
	query: string,
	numResults: number,
	apiKey: string,
	signal?: AbortSignal,
): Promise<{ results: Array<{ title: string; url: string; snippet?: string }> }> {
	const body = {
		query,
		maxResults: Math.min(numResults, 20),
		includeContent: false,
		country: "us",
		language: "en",
	};
	const response = await fetch("https://api.websearchapi.ai/ai-search", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Authorization": `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
		signal: timeoutSignal(signal),
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`WebSearchAPI ${sanitizeError(response.status, text)}`);
	}
	const data = (await response.json()) as Record<string, unknown>;
	const rawResults = data.organic;
	const organic = Array.isArray(rawResults) ? rawResults : [];
	return {
		results: organic.slice(0, numResults).map((r) => ({
			title: (r.title as string) || "",
			url: (r.url as string) || "",
			snippet: ((r.description as string) || "").slice(0, 500),
		})),
	};
}
// ---------------------------------------------------------------------------
// Backend: Perplexity Sonar (free tier, unlimited queries, needs API key)
// Endpoint: POST /chat/completions, auth: Authorization: Bearer
// Uses sonar-pro model, extracts citations from response as search results
// ---------------------------------------------------------------------------

async function searchPerplexity(
	query: string,
	numResults: number,
	apiKey: string,
	signal?: AbortSignal,
): Promise<{ results: Array<{ title: string; url: string; snippet?: string }> }> {
	const body = {
		model: "sonar",
		messages: [
			{
				role: "user",
				content: query,
			},
		],
		search_context_size: "high",
	};

	const response = await fetch("https://api.perplexity.ai/chat/completions", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Authorization": `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
		signal: timeoutSignal(signal),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Perplexity ${sanitizeError(response.status, text)}`);
	}

	const data = (await response.json()) as Record<string, unknown>;

	// Extract citations from the response
	const citations = (data.citations as string[]) || [];
	const message = (data.choices as Array<Record<string, unknown>>)?.[0]?.message as Record<string, unknown> | undefined;
	const answerText = (message?.content as string) || "";

	// Build results from citations; use the answer text as the first result's snippet
	const results: Array<{ title: string; url: string; snippet: string }> = [];

	if (answerText) {
		results.push({
			title: `Answer: ${query}`,
			url: citations[0] || "",
			snippet: answerText.slice(0, 500),
		});
	}

	for (const url of citations) {
		// Extract a readable title from the URL
		try {
			const u = new URL(url);
			const title = u.hostname.replace(/^www\./, "") + (u.pathname !== "/" ? u.pathname.slice(0, 60) : "");
			results.push({ title: title || url, url, snippet: "" });
		} catch {
			results.push({ title: url, url, snippet: "" });
		}
	}

	return { results: results.slice(0, numResults) };
}

// ---------------------------------------------------------------------------
// Backend: SearXNG (self-hosted metasearch, aggregates 70+ providers)
// Endpoint: GET /search?q=<query>&format=json, optional auth via API key header
// Needs instance URL configured in search.json
// ---------------------------------------------------------------------------

async function searchSearXNG(
	query: string,
	numResults: number,
	apiKey: string | undefined,
	instanceUrl: string | undefined,
	signal?: AbortSignal,
): Promise<{ results: Array<{ title: string; url: string; snippet?: string }> }> {
	if (!instanceUrl) {
		throw new Error("SearXNG instance URL not configured. Set searxng.instanceUrl in search.json (e.g. http://localhost:8888)");
	}

	const baseUrl = instanceUrl.replace(/\/+$/, "");
	const params = new URLSearchParams({
		q: query,
		format: "json",
		count: String(Math.min(numResults, 50)),
	});

	const headers: Record<string, string> = {
		"Accept": "application/json",
	};
	if (apiKey) {
		headers["Authorization"] = `Bearer ${apiKey}`;
	}

	const response = await fetch(`${baseUrl}/search?${params}`, {
		method: "GET",
		headers,
		signal: timeoutSignal(signal),
	});

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`SearXNG ${sanitizeError(response.status, text)}`);
	}

	const data = (await response.json()) as Record<string, unknown>;
	const rawResults = data.results as Array<Record<string, unknown>> | undefined;
	const results = Array.isArray(rawResults) ? rawResults : [];

	return {
		results: results.slice(0, numResults).map((r) => ({
			title: (r.title as string) || "",
			url: (r.url as string) || "",
			snippet: ((r.content as string) || (r.snippet as string) || "").slice(0, 500),
		})),
	};
}

// ---------------------------------------------------------------------------
// Backend: Jina AI (s.jina.ai) — free, no API key needed, returns full markdown content
// Endpoint: GET https://s.jina.ai/?q=<query>, returns 5 results as markdown or JSON
// ---------------------------------------------------------------------------

interface JinaResult {
	title: string;
	url: string;
	content: string;
}

async function searchJina(
	query: string,
	numResults: number,
	apiKey?: string,
	signal?: AbortSignal,
): Promise<{ results: JinaResult[] }> {
	const url = `https://s.jina.ai/?q=${encodeURIComponent(query)}&format=json`;
	const headers: Record<string, string> = {
		"Accept": "application/json",
	};
	if (apiKey) {
		headers["Authorization"] = `Bearer ${apiKey}`;
	}
	const response = await fetch(url, {
		signal: timeoutSignal(signal),
		headers,

	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`Jina AI ${sanitizeError(response.status, text)}`);
	}

	const data = (await response.json()) as Record<string, unknown>;
	// s.jina.ai returns { code, status, data: [{ url, title, content, ... }] }
	const rawData = data.data as Array<Record<string, unknown>> | undefined;
	const results = Array.isArray(rawData) ? rawData : [];

	return {
		results: results.slice(0, numResults).map((r) => ({
			title: (r.title as string) || "",
			url: (r.url as string) || "",
			content: ((r.content as string) || (r.description as string) || "").slice(0, 2000),
		})),
	};
}

// ---------------------------------------------------------------------------
// Backend Registry
// ---------------------------------------------------------------------------

interface BackendRunner {
	needsKey: boolean;
	needsKeyFromConfig: boolean;
	needsInstanceUrl: boolean;
	label: string;
	setupLabel: string | null;
	search: (query: string, numResults: number, deps: { key?: string; instanceUrl?: string; signal?: AbortSignal }) => Promise<{ results: Array<{ title: string; url: string; snippet?: string; content?: string }> }>;
}

const BACKEND_DEFS: Record<string, BackendRunner> = {
	duckduckgo: {
		needsKey: false,
		needsKeyFromConfig: false,
		needsInstanceUrl: false,
		label: "DuckDuckGo",
		setupLabel: null,
		search: async (query, numResults, { signal }) => {
			const ddg = await searchDuckDuckGo(query, numResults, signal);
			return { results: ddg.results };
		},
	},
	jina: {
		needsKey: true,
		needsKeyFromConfig: false,
		needsInstanceUrl: false,
		label: "Jina AI",
		setupLabel: "Jina AI (free tier, API key required)",
		search: async (query, numResults, { key, signal }) => {
			return await searchJina(query, numResults, key, signal);
		},
	},
	marginalia: {
		needsKey: false,
		needsKeyFromConfig: true,
		needsInstanceUrl: false,
		label: "Marginalia",
		setupLabel: null,
		search: async (query, numResults, { key, signal }) => {
			const marg = await searchMarginalia(query, numResults, key, signal);
			return { results: marg.results };
		},
	},
	serper: {
		needsKey: true,
		needsKeyFromConfig: false,
		needsInstanceUrl: false,
		label: "Serper",
		setupLabel: "Serper (Google — 2500 free queries/month)",
		search: async (query, numResults, { key, signal }) => {
			const serp = await searchSerper(query, numResults, key!, signal);
			return { results: serp.results };
		},
	},
	tavily: {
		needsKey: true,
		needsKeyFromConfig: false,
		needsInstanceUrl: false,
		label: "Tavily",
		setupLabel: "Tavily (AI agent search — 1000 free calls/month)",
		search: async (query, numResults, { key, signal }) => {
			const tav = await searchTavily(query, numResults, key!, signal);
			return { results: tav.results };
		},
	},
	exa: {
		needsKey: true,
		needsKeyFromConfig: false,
		needsInstanceUrl: false,
		label: "Exa",
		setupLabel: "Exa (AI search — 10 QPS free tier)",
		search: async (query, numResults, { key, signal }) => {
			const exa = await searchExa(query, numResults, key!, signal);
			return { results: exa.results };
		},
	},
	brave: {
		needsKey: true,
		needsKeyFromConfig: false,
		needsInstanceUrl: false,
		label: "Brave",
		setupLabel: "Brave Search (metered billing ~$5/mo credit)",
		search: async (query, numResults, { key, signal }) => {
			const br = await searchBrave(query, numResults, key!, signal);
			return { results: br.results };
		},
	},
	langsearch: {
		needsKey: true,
		needsKeyFromConfig: false,
		needsInstanceUrl: false,
		label: "LangSearch",
		setupLabel: "LangSearch (genuinely free, no CC)",
		search: async (query, numResults, { key, signal }) => {
			const ls = await searchLangSearch(query, numResults, key!, signal);
			return { results: ls.results };
		},
	},
	firecrawl: {
		needsKey: true,
		needsKeyFromConfig: false,
		needsInstanceUrl: false,
		label: "Firecrawl",
		setupLabel: "Firecrawl (500 free credits)",
		search: async (query, numResults, { key, signal }) => {
			const fc = await searchFirecrawl(query, numResults, key!, signal);
			return { results: fc.results };
		},
	},
	websearchapi: {
		needsKey: true,
		needsKeyFromConfig: false,
		needsInstanceUrl: false,
		label: "WebSearchAPI",
		setupLabel: "WebSearchAPI.ai (2000 free credits)",
		search: async (query, numResults, { key, signal }) => {
			const ws = await searchWebSearchAPI(query, numResults, key!, signal);
			return { results: ws.results };
		},
	},
	perplexity: {
		needsKey: true,
		needsKeyFromConfig: false,
		needsInstanceUrl: false,
		label: "Perplexity Sonar",
		setupLabel: "Perplexity Sonar (unlimited free queries)",
		search: async (query, numResults, { key, signal }) => {
			const pp = await searchPerplexity(query, numResults, key!, signal);
			return { results: pp.results };
		},
	},
	searxng: {
		needsKey: false,
		needsKeyFromConfig: false,
		needsInstanceUrl: true,
		label: "SearXNG",
		setupLabel: "SearXNG (self-hosted, needs instance URL)",
		search: async (query, numResults, { key, instanceUrl, signal }) => {
			const sx = await searchSearXNG(query, numResults, key, instanceUrl, signal);
			return { results: sx.results };
		},
	},
};

// ---------------------------------------------------------------------------
// Reciprocal Rank Fusion
// ---------------------------------------------------------------------------

/**
 * RRF (Reciprocal Rank Fusion) — rank-based merge across backends.
 * Constant k=60 is standard from the original RRF paper.
 */
const RRF_K = 60;

function reciprocalRankFusion(
	backendResults: Array<{ backend: string; results: SearchResultWithBackend[] }>,
	numResults: number,
): SearchResultWithBackend[] {
	// Score each unique result by its rank positions across backends
	const urlScores = new Map<string, { score: number; result: SearchResultWithBackend; seenBackends: Set<string> }>();

	for (const { backend, results } of backendResults) {
		for (let i = 0; i < results.length; i++) {
			const r = results[i];
			const normalizedUrl = r.url.replace(/\/$/, "").toLowerCase(); // normalize trailing slash

			let entry = urlScores.get(normalizedUrl);
			if (!entry) {
				entry = { score: 0, result: r, seenBackends: new Set() };
				urlScores.set(normalizedUrl, entry);
			}

			// RRF: score += 1 / (k + rank)
			entry.score += 1 / (RRF_K + i);
			entry.seenBackends.add(backend);

			// Keep the result with the most complete data (prefer content over snippet)
			if (r.content && !entry.result.content) {
				entry.result = r;
			}
		}
	}

	// Sort by RRF score descending, then by number of backends that found it
	const sorted = Array.from(urlScores.values())
		.sort((a, b) => {
			const scoreDiff = b.score - a.score;
			if (scoreDiff !== 0) return scoreDiff;
			return b.seenBackends.size - a.seenBackends.size;
		})
		.slice(0, numResults)
		.map(e => e.result);

	return sorted;
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

interface SearchResultWithBackend {
	title: string;
	url: string;
	snippet?: string;
	content?: string;
	backend?: string;
}

function formatResults(
	query: string,
	backend: string,
	results: Array<{ title: string; url: string; snippet?: string; content?: string }>,
): string {
	// Escape newlines and markdown heading chars in query to prevent injection
	const safeQuery = query.replace(/[\n\r]/g, " ").replace(/^#/gm, "\\#");
	const lines: string[] = [
		`## Search Results: "${safeQuery}"`,
		`Backend: ${backend}  ·  Results: ${results.length}`,
		"",
	];
	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		lines.push(`### ${i + 1}. ${r.title || "Untitled"}`);
		lines.push(`   URL: ${r.url}`);
		const displayText = r.snippet || r.content || "";
		if (displayText) {
			const text = displayText.slice(0, 500);
			lines.push(`   ${text}${displayText.length > 500 ? "..." : ""}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

function formatCombinedResults(
	query: string,
	results: SearchResultWithBackend[],
	backendStats: Map<string, { success: boolean; count: number; error?: string }>,
): string {
	const safeQuery = query.replace(/[\n\r]/g, " ").replace(/^#/gm, "\\#");
	const lines: string[] = [
		`## Search Results: "${safeQuery}"`,
		`Mode: combined  ·  Results: ${results.length}`,
		"",
	];

	// Add backend stats (derived from registry)
	const backendLabel = Object.fromEntries(
		Object.entries(BACKEND_DEFS).map(([k, v]) => [k, v.label])
	) as Record<string, string>;

	lines.push("**Backends queried:**");
	for (const [backend, stats] of backendStats.entries()) {
		const label = backendLabel[backend] || backend;
		if (stats.success) {
			lines.push(`  - ${label}: ${stats.count} results`);
		} else {
			lines.push(`  - ${label}: failed (${stats.error || "unknown error"})`);
		}
	}
	lines.push("");

	// Add results
	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		lines.push(`### ${i + 1}. ${r.title || "Untitled"}`);
		if (r.backend) {
			lines.push(`   *Source: ${backendLabel[r.backend] || r.backend}*`);
		}
		lines.push(`   URL: ${r.url}`);
		const displayText = r.snippet || r.content || "";
		if (displayText) {
			const text = displayText.slice(0, 500);
			lines.push(`   ${text}${displayText.length > 500 ? "..." : ""}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/** Module-level config accessible from helper functions like resolveBackendKey(). */
let config: SearchConfig = { defaultBackend: "duckduckgo", backends: {} };

export default function (pi: ExtensionAPI) {
	let activeBackends: string[] = [];
	let configCacheTime = 0;
	const CONFIG_TTL_MS = 10_000; // re-read config at most every 10s

	function refreshConfig(cwd: string, force = false) {
		const now = Date.now();
		if (!force && now - configCacheTime < CONFIG_TTL_MS) return;

		config = loadConfig(cwd);
		configCacheTime = now;

		activeBackends = Object.entries(config.backends || {})
			.filter(([_, bc]) => bc?.enabled)
			.map(([name]) => name);

		// Always add duckduckgo if no backends explicitly enabled, since it needs no key
		if (activeBackends.length === 0) {
			activeBackends.push("duckduckgo");
		}

		// Honor defaultBackend: put it first in the auto-try order
		if (config.defaultBackend && activeBackends.includes(config.defaultBackend)) {
			activeBackends = [
				config.defaultBackend,
				...activeBackends.filter(b => b !== config.defaultBackend),
			];
		} else {
			config.defaultBackend = activeBackends[0];
		}

		// Invalidate credential cache so shell-command keys refresh after config reload
		clearCredentialCache();
	}

	// -----------------------------------------------------------------------
	// Backend dispatcher
	// -----------------------------------------------------------------------

	async function runBackend(
		backend: string,
		query: string,
		numResults: number,
		signal?: AbortSignal,
	): Promise<Array<{ title: string; url: string; snippet?: string; content?: string }>> {
		await waitForCooldown(backend);
		try {
			const def = BACKEND_DEFS[backend];
			if (!def) throw new Error(`Unknown backend: ${backend}`);

			let key: string | undefined;
			if (def.needsKeyFromConfig) {
				const bc = (config.backends as Record<string, BackendConfig> | undefined)?.[backend];
				key = bc?.apiKey;
			} else if (def.needsKey) {
				key = resolveBackendKey(backend);
				if (!key) {
					const label = def.label;
					throw new Error(`${label} backend not configured. ${MISSING_KEY_HELP}`);
				}
			}

			let instanceUrl: string | undefined;
			if (def.needsInstanceUrl) {
				const bc = (config.backends as Record<string, BackendConfig> | undefined)?.[backend];
				instanceUrl = bc?.instanceUrl;
				if (!instanceUrl) {
					throw new Error(`SearXNG instance URL not configured. Set searxng.instanceUrl in search.json`);
				}
			}

			const result = await def.search(query, numResults, { key, instanceUrl, signal });
			return result.results;
		} finally {
			markCooldown(backend);
		}
	}

	// -----------------------------------------------------------------------
	// Tool: web_search
	// -----------------------------------------------------------------------

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web using one of several backend search engines. " +
			"Supports DuckDuckGo (free, no key), " +
			"Marginalia Search (free, shared public key), Serper, Tavily, Exa, Brave, " +
			"LangSearch, Firecrawl, WebSearchAPI, Perplexity Sonar, and SearXNG (most need API keys). " +
			"The best available backend is used automatically. " +
			"Use combine=true to query all enabled backends in parallel for broader coverage. " +
			"Use for fact-finding, research, documentation lookups, and current events.",
		promptSnippet: "Search the web (supports multiple search backends)",
		promptGuidelines: [
			"Use web_search when you need up-to-date information, facts, or documentation from the web",
			"Auto mode tries enabled backends in order (DuckDuckGo is the free fallback)",
			"Set combine=true to query ALL backends in parallel and merge/deduplicate results",
			"Configure additional backends in .pi/search.json for better quality results",
		],
		parameters: Type.Object({
			query: Type.String({
				description: "Search query (natural language works best)",
			}),
			numResults: Type.Optional(
				Type.Number({
					description: "Number of results (1-20, default 10)",
					default: 10,
				}),
			),
			backend: Type.Optional(
				StringEnum(["duckduckgo", "jina", "marginalia", "serper", "tavily", "exa",
					"brave", "langsearch", "firecrawl", "websearchapi", "perplexity", "searxng", "auto"] as const, {
					description:
						"Backend to use. 'auto' picks the best configured backend (default)",
				}),
			),
			combine: Type.Optional(
				Type.Boolean({
					description:
						"When true, queries ALL enabled backends in parallel and merges/deduplicates results. " +
						"Default is false (fallback mode: uses first successful backend only). " +
						"Ignored when a specific backend is requested (backend != 'auto').",
					default: false,
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			refreshConfig(ctx.cwd);
			const numResults = Math.max(1, Math.min(params.numResults ?? 10, 20));
			const requestedBackend = params.backend || "auto";
			const combine = params.combine ?? false;

			if (requestedBackend !== "auto") {
				// Specific backend requested — try it directly
				const results = await runBackend(requestedBackend, params.query, numResults, signal);
				return {
					content: [{ type: "text", text: formatResults(params.query, requestedBackend, results) }],
					details: { backend: requestedBackend, resultCount: results.length },
				};
			}

			// Auto mode
			if (combine) {
				// Combine mode: query all enabled backends in parallel
				const resultsPerBackend = await Promise.all(
					activeBackends.map(async (backend) => {
						try {
							const results = await runBackend(
								backend,
								params.query,
								Math.ceil(numResults / activeBackends.length),
								signal,
							);
							return {
								backend,
								results: results.map((r) => ({ ...r, backend })) as SearchResultWithBackend[],
								success: true,
							};
						} catch (err) {
							return {
								backend,
								results: [] as SearchResultWithBackend[],
								success: false,
								error: (err as Error).message,
							};
						}
					}),
				);

				// Build backend stats map
				const backendStats = new Map<
					string,
					{ success: boolean; count: number; error?: string }
				>();

				for (const { backend, results, success, error } of resultsPerBackend) {
					backendStats.set(backend, {
						success,
						count: results.length,
						error,
					});
				}

				// Merge and re-rank using Reciprocal Rank Fusion
				const successfulBackends = resultsPerBackend
					.filter(r => r.success && r.results.length > 0)
					.map(r => ({ backend: r.backend, results: r.results }));

				const combined = successfulBackends.length > 0
					? reciprocalRankFusion(successfulBackends, numResults)
					: [];

				return {
					content: [
						{
							type: "text",
							text: formatCombinedResults(params.query, combined, backendStats),
						},
					],
					details: {
						backend: "combined",
						resultCount: combined.length,
						backendStats: Object.fromEntries(backendStats),
					},
				};
			} else {
				// Fallback mode: try each enabled backend in order
				const errors: string[] = [];
				for (const backend of activeBackends) {
					try {
						const results = await runBackend(backend, params.query, numResults, signal);
						return {
							content: [
								{
									type: "text",
									text: errors.length > 0
										? `${errors.join("; ")}\n\n${formatResults(params.query, backend, results)}`
										: formatResults(params.query, backend, results),
								},
							],
							details: {
								backend: errors.length > 0 ? `${backend} (fallback)` : backend,
								resultCount: results.length,
								errors: errors.length > 0 ? errors : undefined,
							},
						};
					} catch (err) {
						errors.push(`${backend}: ${(err as Error).message}`);
					}
				}

				throw new Error(`All backends failed: ${errors.join("; ")}`);
			}
		},
	});

	// -----------------------------------------------------------------------
	// Tool: web_read — Read/extract content from a URL
	// -----------------------------------------------------------------------

	pi.registerTool({
		name: "web_read",
		label: "Read Web Page",
		description:
			"Fetch a URL as markdown. Use objective for a concrete question, keywords for long pages, " +
			"rush for speed, smart for better narrowing.",
		promptSnippet: "Read content from a web page (supports markdown extraction)",
		promptGuidelines: [
			"Use web_read when you need to read the content of a specific URL",
			"Set objective for a concrete question when only part of the page matters",
			"Add keywords for long pages when you know the relevant terms",
			"Choose rush for speed or smart for higher-quality narrowing",
		],
		parameters: Type.Object({
			url: Type.String({
				description: "HTTP(S) URL or bare domain to fetch",
			}),
			fresh: Type.Optional(
				Type.Boolean({
					description: "Bypass cache when freshness matters",
				}),
			),
			keywords: Type.Optional(
				Type.Array(Type.String(), {
					description: "Keyword to focus extraction on relevant sections",
				}),
			),
			mode: Type.Optional(
				StringEnum(["rush", "smart"] as const, {
					description: "rush = faster mode, smart = better section selection on long/noisy pages",
				}),
			),
			objective: Type.Optional(
				Type.String({
					description:
						"Specific question to answer from the page. Use when only part matters.",
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const url = params.url.startsWith("https://") || params.url.startsWith("http://")
				? params.url
				: `https://${params.url}`;

			// Build Jina Reader URL (free, no key, returns markdown)
			const readerUrl = new URL("https://r.jina.ai/" + url);

			const headers: Record<string, string> = {
				"Accept": "text/plain",
			};

			if (params.fresh) {
				headers["x-no-cache"] = "true";
			}
			if (params.keywords && params.keywords.length > 0) {
				headers["x-keywords"] = params.keywords.join(", ");
			}
			if (params.mode) {
				headers["x-respond-with"] = params.mode === "rush" ? "text" : "markdown";
			}
			if (params.objective) {
				headers["x-target-selector"] = params.objective;
			}

			const response = await fetch(readerUrl.toString(), {
				signal: timeoutSignal(signal),
				headers,
			});

			if (!response.ok) {
				const text = await response.text().catch(() => "");
				throw new Error(`Failed to read ${url}: ${sanitizeError(response.status, text)}`);
			}

			const content = await response.text();
			const truncated = content.length > 10000
				? content.slice(0, 10000) + `\n\n[... truncated, full length: ${content.length} chars]`
				: content;

			return {
				content: [{ type: "text", text: truncated }],
				details: {
					url,
					length: content.length,
					truncated: content.length > 10000,
				},
			};
		},
	});

	// -----------------------------------------------------------------------
	// Commands
	// -----------------------------------------------------------------------

	pi.registerCommand("search-setup", {
		description: "Configure search backends interactively",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/search-setup requires interactive mode", "error");
				return;
			}

			const backends = Object.values(BACKEND_DEFS)
				.filter(d => d.setupLabel !== null)
				.map(d => d.setupLabel!);

			const backendKey: Record<string, string> = Object.fromEntries(
				Object.entries(BACKEND_DEFS)
					.filter(([_, d]) => d.setupLabel !== null)
					.map(([k, d]) => [d.setupLabel!, k])
			);

			const option = await ctx.ui.select("Which backend do you want to configure?", [
				...backends,
				"✅ Done — save and exit",
			]);

			if (!option || option.startsWith("✅ Done")) {
				ctx.ui.notify("Search setup complete.", "info");
				return;
			}

			const backend = backendKey[option];
			const label = option;

			const key = await ctx.ui.input(`Enter your ${label} API key:`, {
				placeholder: "sk-...",
				validate: (v: string) =>
					v.trim().length > 0 ? undefined : "Key cannot be empty",
			});

			if (!key) {
				ctx.ui.notify("Setup cancelled.", "info");
				return;
			}

			const configDir = join(getAgentDir(), "extensions");
			const configPath = join(configDir, "search.json");

			mkdirSync(configDir, { recursive: true });

			let existing: SearchConfig = {};
			if (existsSync(configPath)) {
				try {
					existing = JSON.parse(readFileSync(configPath, "utf-8"));
				} catch {
					// ignore
				}
			}

			// SearXNG setup needs both instance URL and optional API key
			let backendConfig: BackendConfig = { enabled: true };
			if (backend === "searxng") {
				const url = await ctx.ui.input("Enter your SearXNG instance URL (e.g. http://localhost:8888):", {
					placeholder: "http://localhost:8888",
					validate: (v: string) =>
						v.trim().length > 0 ? undefined : "URL cannot be empty",
				});
				if (!url) {
					ctx.ui.notify("Setup cancelled.", "info");
					return;
				}
				backendConfig.instanceUrl = url.trim();
				// Optionally ask for API key (some instances require auth)
				const optionalKey = await ctx.ui.input("Optional API key (leave empty if none):", {
					placeholder: "sk-... (optional)",
				});
				if (optionalKey && optionalKey.trim()) {
					backendConfig.apiKey = optionalKey.trim();
				}
			} else {
				backendConfig.apiKey = key?.trim() || "";
			}

			const updated: SearchConfig = {
				...existing,
				backends: {
					...existing.backends,
					[backend]: backendConfig,
				},
			};

			writeFileSync(configPath, JSON.stringify(updated, null, 2) + "\n", { mode: 0o600 });

			ctx.ui.notify(
				`${label} API key saved to ${configPath}. Run /reload to activate.`,
				"success",
			);
		},
	});

	pi.registerCommand("search-status", {
		description: "Show which search backends are configured and active",
		handler: async (_args, ctx) => {
			refreshConfig(ctx.cwd);

			const backendLabels: Record<string, string> = Object.fromEntries(
				Object.entries(BACKEND_DEFS).map(([k, v]) => [k, `${v.label}${k === "duckduckgo" ? " (free)" : k === "marginalia" ? " (free/public key)" : ""}`])
			);

			// Collect table rows first to compute aligned column widths
			type Row = [string, string];
			const rows: Row[] = [];

			for (const [name, label] of Object.entries(backendLabels)) {
				const { configured, source } = getKeySource(name);
				const bc = config.backends?.[name as keyof typeof config.backends];
				if (name === "duckduckgo") {
					rows.push([label, "✓ enabled, key: — (free)"]);
				} else if (name === "marginalia" && bc?.enabled) {
					rows.push([label, "✓ enabled, key: optional (public)"]);
				} else if (name === "searxng" && bc?.enabled) {
					const urlInfo = bc.instanceUrl ? `url: ${bc.instanceUrl}` : "no URL set";
					rows.push([label, `✓ enabled, ${urlInfo}${configured ? `, key: ✓ (${source})` : ", key: —"}`]);
				} else if (bc?.enabled) {
					rows.push([label, `✓ enabled, key: ✓${source ? ` (${source})` : ""}`]);
				} else {
					rows.push([label, `— disabled${configured ? `, key: ✓ (${source})` : ""}`]);
				}
			}

			// Compute column widths from headers + data
			const col1Header = "Backend";
			const col2Header = "Status";
			const w1 = rows.reduce((max, [c]) => Math.max(max, c.length), col1Header.length);
			const w2 = rows.reduce((max, [, s]) => Math.max(max, s.length), col2Header.length);

			const pad = (s: string, w: number) => s + " ".repeat(w - s.length);

			const tableLines = [
				`| ${pad(col1Header, w1)} | ${pad(col2Header, w2)} |`,
				`| ${"-".repeat(w1)} | ${"-".repeat(w2)} |`,
				...rows.map(([c1, c2]) => `| ${pad(c1, w1)} | ${pad(c2, w2)} |`),
			];

			const resolvedDefault = activeBackends[0] || "none";
			const lines: string[] = [
				"## Search Backend Status",
				`Configured default: ${config.defaultBackend || "none"}`,
				`Resolved default: ${resolvedDefault}`,
				`Active: ${activeBackends.join(", ") || "none"}`,
				"",
				...tableLines,
			];

			if (activeBackends.length === 1 && activeBackends[0] === "duckduckgo") {
				lines.push("");
				lines.push("Only DuckDuckGo is active (no API key needed).");
				lines.push("Add Jina AI (free, no key) or run /search-setup to add other backends.");
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// -----------------------------------------------------------------------
	// Session start
	// -----------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		backendCooldowns.clear();
		refreshConfig(ctx.cwd);
		const status = activeBackends.join(", ");
		ctx.ui.setStatus("search", `search: ${status}`);
	});
}
