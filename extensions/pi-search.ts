/**
 * Search Extension — Unified web search with multiple backend support
 *
 * Backends (choose any, all disabled by default):
 *   duckduckgo    — ✅ Truly free, no API key needed. 1158ms avg, 3.5/10 quality
 *   marginalia    — ✅ Anti-SEO search, "public" key (no reg). 354ms avg, 3.0/10
 *   serper        — ✅ Google via serper.dev, 2500 free/mo. 667ms, 3.5/10
 *   brave         — ✅ Brave Search, 2000 free/mo. 460ms (rate-limited ~1 req/s)
 *   tavily        — ✅ Tavily AI search, 1000 free/mo. 356ms, 3.7/10 BEST QUALITY
 *   exa           — ✅ Exa AI search, 10 QPS free tier. 137ms, 3.2/10 FASTEST
 *   firecrawl     — ✅ Firecrawl, 500 free credits. 644ms, 3.5/10
 *   langsearch    — ✅ LangSearch, genuinely free. Endpoint: /v1/web-search (Bearer). 10 results/query. 1816ms, 3.2/10
 *   websearchapi  — ✅ WebSearchAPI.ai, 2000 free credits. Endpoint: /ai-search, Bearer token. 1323ms, 3.5/10
 *
 * Benchmark (2026-05-04): All 9 backends confirmed working. See benchmark/ for details.
 *
 * Config file (project takes precedence):
 *   ~/.pi/agent/extensions/search.json (global)
 *   .pi/search.json (project-local)
 *
 * Auto mode: tries each enabled backend in order, falls through on failure.
 * DuckDuckGo is always included as the safety-net backend (no key needed).
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
 *       "websearchapi": { "enabled": true, "apiKey": "..." }
 *     }
 *   }
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Types & Config
// ---------------------------------------------------------------------------

interface BackendConfig {
	enabled?: boolean;
	apiKey?: string;
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
	};
}

function getAgentDir(): string {
	return join(process.env.HOME || process.env.USERPROFILE || "~", ".pi", "agent");
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
	if (existsSync(projectPath)) {
		try {
			const project = JSON.parse(readFileSync(projectPath, "utf-8"));
			config = { ...config, ...project };
			if (project.backends) {
				config.backends = { ...config.backends, ...project.backends };
			}
		} catch {
			// ignore
		}
	}
	return config;
}

const MISSING_KEY_HELP =
	"Set the API key in ~/.pi/agent/extensions/search.json or project .pi/search.json, " +
	"or use duckduckgo which needs no key.";

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
	// Note: execSync is blocking so we cannot abort mid-execution.
	// Check pre-abort and rely on the HTTP_TIMEOUT_MS timeout for cancellation.
	if (signal?.aborted) throw new Error("DuckDuckGo search aborted");
	try {
		const pyScript = `
import json, sys
from ddgs import DDGS
results = []
with DDGS() as ddgs:
    for i, r in enumerate(ddgs.text(${JSON.stringify(query)}, max_results=${numResults})):
        results.append({"title": r.get("title",""), "url": r.get("href",""), "snippet": r.get("body","")})
print(json.dumps({"results": results}))
`;
		const tmpFile = join(tmpdir(), `pi-ddg-${Date.now()}-${Math.random().toString(36).slice(2)}.py`);
		writeFileSync(tmpFile, pyScript, "utf-8");
		try {
			const pythonCmd = process.platform === "win32" ? "python" : "python3";
			const output = execSync(`"${pythonCmd}" "${tmpFile}"`, {
				encoding: "utf-8",
				timeout: HTTP_TIMEOUT_MS,
				maxBuffer: 1024 * 1024,
			});
			return JSON.parse(output.trim());
		} finally {
			try { unlinkSync(tmpFile); } catch {}
		}
	} catch (e) {
		throw new Error(`DuckDuckGo search failed: ${e instanceof Error ? e.message : String(e)}`);
	}
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
// Backend: Brave Search (2000 free queries/month, needs API key)
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
// Result formatting
// ---------------------------------------------------------------------------

interface SearchResultWithBackend extends {
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
		if (r.snippet) {
			const text = r.snippet.slice(0, 500);
			lines.push(`   ${text}${r.snippet.length > 500 ? "..." : ""}`);
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

	// Add backend stats
	const backendLabel: Record<string, string> = {
		duckduckgo: "DuckDuckGo",
		marginalia: "Marginalia",
		serper: "Serper",
		tavily: "Tavily",
		exa: "Exa",
		brave: "Brave",
		langsearch: "LangSearch",
		firecrawl: "Firecrawl",
		websearchapi: "WebSearchAPI",
	};

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
		if (r.snippet) {
			const text = r.snippet.slice(0, 500);
			lines.push(`   ${text}${r.snippet.length > 500 ? "..." : ""}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let config: SearchConfig = { defaultBackend: "duckduckgo", backends: {} };
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
			switch (backend) {
			case "duckduckgo": {
				const ddg = await searchDuckDuckGo(query, numResults, signal);
				return ddg.results;
			}
			case "marginalia": {
				const bc = config.backends?.marginalia;
				const marg = await searchMarginalia(query, numResults, bc?.apiKey, signal);
				return marg.results;
			}
			case "serper": {
				const bc = config.backends?.serper;
				if (!bc?.apiKey) throw new Error(`Serper backend not configured. ${MISSING_KEY_HELP}`);
				const serp = await searchSerper(query, numResults, bc.apiKey, signal);
				return serp.results;
			}
			case "tavily": {
				const bc = config.backends?.tavily;
				if (!bc?.apiKey) throw new Error(`Tavily backend not configured. ${MISSING_KEY_HELP}`);
				const tav = await searchTavily(query, numResults, bc.apiKey, signal);
				return tav.results;
			}
			case "exa": {
				const bc = config.backends?.exa;
				if (!bc?.apiKey) throw new Error(`Exa backend not configured. ${MISSING_KEY_HELP}`);
				const exa = await searchExa(query, numResults, bc.apiKey, signal);
				return exa.results;
			}
			case "brave": {
				const bc = config.backends?.brave;
				if (!bc?.apiKey) throw new Error(`Brave backend not configured. ${MISSING_KEY_HELP}`);
				const br = await searchBrave(query, numResults, bc.apiKey, signal);
				return br.results;
			}
			case "langsearch": {
				const bc = config.backends?.langsearch;
				if (!bc?.apiKey) throw new Error(`LangSearch backend not configured. ${MISSING_KEY_HELP}`);
				const ls = await searchLangSearch(query, numResults, bc.apiKey, signal);
				return ls.results;
			}
			case "firecrawl": {
				const bc = config.backends?.firecrawl;
				if (!bc?.apiKey) throw new Error(`Firecrawl backend not configured. ${MISSING_KEY_HELP}`);
				const fc = await searchFirecrawl(query, numResults, bc.apiKey, signal);
				return fc.results;
			}
			case "websearchapi": {
				const bc = config.backends?.websearchapi;
				if (!bc?.apiKey) throw new Error(`WebSearchAPI backend not configured. ${MISSING_KEY_HELP}`);
				const ws = await searchWebSearchAPI(query, numResults, bc.apiKey, signal);
				return ws.results;
			}
			default:
				throw new Error(`Unknown backend: ${backend}`);
		}
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
			"LangSearch, Firecrawl, and WebSearchAPI (most need API keys). " +
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
				StringEnum(["duckduckgo", "marginalia", "serper", "tavily", "exa",
					"brave", "langsearch", "firecrawl", "websearchapi", "auto"] as const, {
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

				// Merge and deduplicate by URL
				const seenUrls = new Set<string>();
				const combined: SearchResultWithBackend[] = [];
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

					for (const r of results) {
						if (!seenUrls.has(r.url)) {
							seenUrls.add(r.url);
							combined.push(r);
						}
						if (combined.length >= numResults) {
							break;
						}
					}
				}

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
	// Commands
	// -----------------------------------------------------------------------

	pi.registerCommand("search-setup", {
		description: "Configure search backends interactively",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/search-setup requires interactive mode", "error");
				return;
			}

			const backends = [
				"Serper (Google — 2500 free queries/month)",
				"Tavily (AI agent search — 1000 free calls/month)",
				"Exa (AI search — 10 QPS free tier)",
				"Brave Search (2000 free queries/month)",
				"LangSearch (genuinely free, no CC)",
				"Firecrawl (500 free credits)",
				"WebSearchAPI.ai (2000 free credits)",
			];

			const backendKey: Record<string, string> = {
				"Serper (Google — 2500 free queries/month)": "serper",
				"Tavily (AI agent search — 1000 free calls/month)": "tavily",
				"Exa (AI search — 10 QPS free tier)": "exa",
				"Brave Search (2000 free queries/month)": "brave",
				"LangSearch (genuinely free, no CC)": "langsearch",
				"Firecrawl (500 free credits)": "firecrawl",
				"WebSearchAPI.ai (2000 free credits)": "websearchapi",
			};

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

			const updated: SearchConfig = {
				...existing,
				backends: {
					...existing.backends,
					[backend]: { enabled: true, apiKey: key.trim() },
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

			const backendLabels: Record<string, string> = {
				duckduckgo: "DuckDuckGo (free)",
				marginalia: "Marginalia (free/public key)",
				serper: "Serper",
				tavily: "Tavily",
				exa: "Exa",
				brave: "Brave",
				langsearch: "LangSearch",
				firecrawl: "Firecrawl",
				websearchapi: "WebSearchAPI",
			};

			// Collect table rows first to compute aligned column widths
			type Row = [string, string];
			const rows: Row[] = [];

			for (const [name, label] of Object.entries(backendLabels)) {
				const bc = config.backends?.[name as keyof typeof config.backends];
				const keyConfigured = bc?.apiKey ? "✓" : "—";
				if (name === "duckduckgo") {
					rows.push([label, "✓ enabled, key: — (free)"]);
				} else if (name === "marginalia" && bc?.enabled) {
					rows.push([label, "✓ enabled, key: optional (public)"]);
				} else if (bc?.enabled) {
					rows.push([label, `✓ enabled, key: ${keyConfigured}`]);
				} else {
					rows.push([label, `— disabled, key: ${keyConfigured}`]);
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
				lines.push("Run /search-setup to add other backends for better results.");
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
