#!/usr/bin/env node

/**
 * Benchmark for the backends currently in pi-search-multi extension.
 * Tests each backend one at a time, one query at a time.
 *
 * Usage: node benchmark/benchmark-current.mjs
 */

import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, "..", ".pi", "search.json");
const REPORT_PATH = join(__dirname, "benchmark-current-report.md");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const QUERIES = [
  "latest AI frameworks 2025",
  "climate change solutions",
  "python async programming best practices",
];

const NUM_RESULTS = 5;

const BACKENDS = [
  { name: "duckduckgo",   label: "DuckDuckGo",          needsPy: true },
  { name: "marginalia",   label: "Marginalia Search",    needsPy: false },
  { name: "serper",       label: "Serper",               needsPy: false },
  { name: "tavily",       label: "Tavily",               needsPy: false },
  { name: "exa",          label: "Exa",                  needsPy: false },
  { name: "brave",        label: "Brave Search",         needsPy: false },
  { name: "langsearch",   label: "LangSearch",           needsPy: false },
  { name: "firecrawl",    label: "Firecrawl",            needsPy: false },
  { name: "websearchapi", label: "WebSearchAPI.ai",      needsPy: false },
  { name: "perplexity",   label: "Perplexity Sonar",     needsPy: false },
  { name: "searxng",      label: "SearXNG",              needsPy: false },
];

// ---------------------------------------------------------------------------
// Direct HTTP tests for each backend (mirrors search.ts implementation)
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from "node:fs";

function loadApiKey(backend) {
  // Try .pi/search.json (project-level)
  const configPath = join(__dirname, "..", ".pi", "search.json");
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      const bc = config.backends?.[backend];
      if (bc?.apiKey) return bc.apiKey;
    } catch {}
  }
  // Try ~/.pi/agent/extensions/search.json (global)
  const globalPath = join(process.env.HOME || "~", ".pi", "agent", "extensions", "search.json");
  if (existsSync(globalPath)) {
    try {
      const config = JSON.parse(readFileSync(globalPath, "utf-8"));
      const bc = config.backends?.[backend];
      if (bc?.apiKey) return bc.apiKey;
    } catch {}
  }
  return undefined;
}



// --- DuckDuckGo (via Python, async spawn) ---
async function testDuckDuckGo(query, numResults) {
  const pyScript = `
import json, sys, time
from ddgs import DDGS
t0 = time.time()
results = []
with DDGS() as ddgs:
    for i, r in enumerate(ddgs.text(${JSON.stringify(query)}, max_results=${numResults})):
        results.append({"title": r.get("title",""), "url": r.get("href",""), "snippet": r.get("body","")})
elapsed = time.time() - t0
print(json.dumps({"results": results, "elapsed": elapsed}))
`;
  return new Promise((resolve, reject) => {
    const proc = spawn("python3", ["-c", pyScript], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    proc.stdout.on("data", d => stdout += d.toString());
    proc.stderr.on("data", d => stderr += d.toString());
    const timeout = setTimeout(() => { proc.kill(); reject(new Error("DuckDuckGo timed out")); }, 30000);
    proc.on("close", code => {
      clearTimeout(timeout);
      if (code === 0) {
        try { resolve(JSON.parse(stdout.trim())); }
        catch { reject(new Error(`DuckDuckGo: invalid JSON: ${stdout.slice(0, 200)}`)); }
      } else {
        reject(new Error(`DuckDuckGo failed (exit ${code}): ${stderr.slice(0, 200)}`));
      }
    });
    proc.on("error", err => { clearTimeout(timeout); reject(new Error(`DuckDuckGo failed: ${err.message}`)); });
  });
}

// --- Generic HTTP test ---
async function testHttp(label, url, init, query) {
  const t0 = Date.now();
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const elapsed = (Date.now() - t0) / 1000;
  const data = await res.json();
  return { data, elapsed };
}

// --- Marginalia ---
async function testMarginalia(query, numResults) {
  const { data, elapsed } = await testHttp(
    "Marginalia",
    `https://api.marginalia.nu/public/search/${encodeURIComponent(query)}?index=0&count=${numResults}`,
    { headers: { Accept: "application/json" } },
    query
  );
  const results = ((data.results || [])).slice(0, numResults).map(r => ({
    title: r.title || "", url: r.url || "", snippet: (r.description || "").slice(0, 500),
  }));
  return { results, elapsed };
}

// --- Perplexity Sonar ---
async function testPerplexity(query, numResults, apiKey) {
  const { data, elapsed } = await testHttp(
    "Perplexity", "https://api.perplexity.ai/chat/completions",
    { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: "sonar", messages: [{ role: "user", content: query }], search_context_size: "high" }) },
    query
  );
  const citations = data.citations || [];
  const answerText = data.choices?.[0]?.message?.content || "";
  const results = [];
  if (answerText) {
    results.push({ title: `Answer: ${query}`, url: citations[0] || "", snippet: answerText.slice(0, 500) });
  }
  for (const url of citations) {
    try {
      const u = new URL(url);
      const title = u.hostname.replace(/^www\./, "") + (u.pathname !== "/" ? u.pathname.slice(0, 60) : "");
      results.push({ title: title || url, url, snippet: "" });
    } catch {
      results.push({ title: url, url, snippet: "" });
    }
  }
  return { results: results.slice(0, numResults), elapsed };
}

// --- SearXNG ---
async function testSearXNG(query, numResults, apiKey, instanceUrl) {
  const baseUrl = (instanceUrl || "http://localhost:8888").replace(/\/+$/, "");
  const params = new URLSearchParams({ q: query, format: "json", count: String(Math.min(numResults, 50)) });
  const headers = { Accept: "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const { data, elapsed } = await testHttp("SearXNG", `${baseUrl}/search?${params}`, { headers }, query);
  const rawResults = data.results || [];
  const results = rawResults.slice(0, numResults).map(r => ({
    title: r.title || "", url: r.url || "", snippet: (r.content || r.snippet || "").slice(0, 500),
  }));
  return { results, elapsed };
}

// --- Serper ---
async function testSerper(query, numResults, apiKey) {
  const { data, elapsed } = await testHttp(
    "Serper", "https://google.serper.dev/search",
    { method: "POST", headers: { "X-API-KEY": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ q: query, num: numResults }) },
    query
  );
  const results = ((data.organic || [])).slice(0, numResults).map(r => ({
    title: r.title || "", url: r.link || "", snippet: r.snippet || "",
  }));
  return { results, elapsed };
}

// --- Tavily ---
async function testTavily(query, numResults, apiKey) {
  const { data, elapsed } = await testHttp(
    "Tavily", "https://api.tavily.com/search",
    { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, max_results: numResults, include_answer: false }) },
    query
  );
  const results = ((data.results || [])).slice(0, numResults).map(r => ({
    title: r.title || "", url: r.url || "", snippet: (r.content || "").slice(0, 500),
  }));
  return { results, elapsed };
}

// --- Exa ---
async function testExa(query, numResults, apiKey) {
  const { data, elapsed } = await testHttp(
    "Exa", "https://api.exa.ai/search",
    { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ query, numResults, contents: { text: true, highlights: true } }) },
    query
  );
  const results = ((data.results || [])).slice(0, numResults).map(r => ({
    title: r.title || "", url: r.url || "",
    snippet: ((r.text || r.highlight || "")).slice(0, 500),
  }));
  return { results, elapsed };
}

// --- Brave ---
async function testBrave(query, numResults, apiKey) {
  const params = new URLSearchParams({ q: query, count: String(numResults) });
  const { data, elapsed } = await testHttp(
    "Brave", `https://api.search.brave.com/res/v1/web/search?${params}`,
    { headers: { Accept: "application/json", "Accept-Encoding": "gzip", "X-Subscription-Token": apiKey } },
    query
  );
  const results = ((data.web?.results || [])).slice(0, numResults).map(r => ({
    title: r.title || "", url: r.url || "", snippet: (r.description || "").slice(0, 500),
  }));
  return { results, elapsed };
}

// --- LangSearch ---
async function testLangSearch(query, numResults, apiKey) {
  const { data, elapsed } = await testHttp(
    "LangSearch", "https://api.langsearch.com/v1/web-search",
    { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, max_results: numResults }) },
    query
  );
  const results = ((data.data?.webPages?.value || data.results || data.data || [])).slice(0, numResults).map(r => ({
    title: r.name || r.title || "", url: r.url || r.link || "",
    snippet: (r.snippet || r.description || "").slice(0, 500),
  }));
  return { results, elapsed };
}

// --- Firecrawl ---
async function testFirecrawl(query, numResults, apiKey) {
  const { data, elapsed } = await testHttp(
    "Firecrawl", "https://api.firecrawl.dev/v1/search",
    { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, limit: numResults }) },
    query
  );
  const results = ((data.data || data.results || [])).slice(0, numResults).map(r => ({
    title: r.title || "", url: r.url || "", snippet: (r.description || r.snippet || "").slice(0, 500),
  }));
  return { results, elapsed };
}

// --- WebSearchAPI ---
async function testWebSearchAPI(query, numResults, apiKey) {
  const { data, elapsed } = await testHttp(
    "WebSearchAPI", "https://api.websearchapi.ai/ai-search",
    { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ query, maxResults: numResults, includeContent: false, country: "us", language: "en" }) },
    query
  );
  const results = ((data.organic || [])).slice(0, numResults).map(r => ({
    title: r.title || "", url: r.url || "", snippet: (r.description || "").slice(0, 500),
  }));
  return { results, elapsed };
}

// ---------------------------------------------------------------------------
// Quality scoring
// ---------------------------------------------------------------------------
function scoreResults(results, query) {
  let score = 0;
  const qWords = query.toLowerCase().split(/\s+/);
  for (const r of results) {
    const title = (r.title || "").toLowerCase();
    const snippet = (r.snippet || "").toLowerCase();
    const matchedWords = qWords.filter(w => title.includes(w) || snippet.includes(w));
    score += matchedWords.length / qWords.length;
    if (r.url && !r.url.match(/^(https?:\/\/)?(www\.)?(google|yahoo|duckduckgo)\./)) score += 0.5;
    if (r.snippet && r.snippet.length > 20) score += 0.5;
  }
  return Math.min(10, Math.round((score / Math.max(results.length, 1)) * 2 * 10) / 10);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const results = {};

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  pi-search-multi — Backend Benchmark (one at a time)   ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  for (const backend of BACKENDS) {
    const { name, label, needsPy } = backend;
    console.log(`\n${"=".repeat(60)}`);
    console.log(`  ${label}`);
    console.log(`${"=".repeat(60)}`);

    results[name] = { label, queries: {} };
    let totalTime = 0, okCount = 0, errCount = 0, totalResults = 0;

    for (const query of QUERIES) {
      process.stdout.write(`  "${query.slice(0, 50)}..." → `);

      try {
        let result;
        if (name === "duckduckgo") {
          result = await testDuckDuckGo(query, NUM_RESULTS);
        } else if (name === "marginalia") {
          result = await testMarginalia(query, NUM_RESULTS);
        } else if (name === "perplexity") {
          const apiKey = loadApiKey(name);
          if (!apiKey) throw new Error(`No API key for ${name}`);
          result = await testPerplexity(query, NUM_RESULTS, apiKey);
        } else if (name === "searxng") {
          const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
          const bc = config.backends?.searxng || {};
          result = await testSearXNG(query, NUM_RESULTS, bc.apiKey, bc.instanceUrl);
        } else {
          const apiKey = loadApiKey(name);
          if (!apiKey) throw new Error(`No API key for ${name}`);
          const testers = {
            serper: testSerper, tavily: testTavily, exa: testExa,
            brave: testBrave, langsearch: testLangSearch,
            firecrawl: testFirecrawl, websearchapi: testWebSearchAPI,
          };
          result = await testers[name](query, NUM_RESULTS, apiKey);
        }

        const elapsedMs = Math.round((result.elapsed || 0) * 1000);
        const resCount = result.results?.length || 0;
        const score = scoreResults(result.results || [], query);

        results[name].queries[query] = {
          status: "ok",
          elapsed: `${elapsedMs}ms`,
          elapsedMs,
          resultCount: resCount,
          qualityScore: score,
          sampleTitle: result.results?.[0]?.title || "(no results)",
        };

        totalTime += elapsedMs;
        okCount++;
        totalResults += resCount;
        console.log(`✓ ${elapsedMs}ms | ${resCount} results | score: ${score}/10`);
      } catch (err) {
        const msg = err.message || String(err);
        results[name].queries[query] = { status: "error", error: msg.slice(0, 300) };
        errCount++;
        console.log(`✗ ERROR: ${msg.slice(0, 120)}`);
      }
    }

    results[name].summary = {
      successRate: `${Math.round((okCount / (okCount + errCount)) * 100)}%`,
      avgTime: okCount > 0 ? `${Math.round(totalTime / okCount)}ms` : "N/A",
      avgScore: okCount > 0
        ? (Object.values(results[name].queries).filter(q => q.status === "ok").reduce((s, q) => s + q.qualityScore, 0) / okCount).toFixed(1)
        : "N/A",
      totalResults,
      errors: errCount,
    };
  }

  // Generate report
  const report = generateReport(results);
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, report, "utf-8");

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║       Benchmark Complete!                               ║");
  console.log(`║       Report: ${REPORT_PATH.padEnd(38)}║`);
  console.log("╚══════════════════════════════════════════════════════════╝\n");
  console.log(report);
}

function generateReport(data) {
  const lines = [];
  const emit = (l = "") => lines.push(l);

  emit("# 🔍 pi-search-multi — Backend Benchmark Report");
  emit();
  emit(`**Date:** ${new Date().toISOString().split("T")[0]}`);
  emit(`**Test queries:** ${QUERIES.map(q => `"${q}"`).join(", ")}`);
  emit(`**Results requested per query:** ${NUM_RESULTS}`);
  emit();

  emit("## 📊 Overall Summary\n");
  emit("| # | Backend | Avg Time | Success | Results | Avg Score |");
  emit("|---|---------|----------|---------|---------|-----------|");

  const sorted = [...BACKENDS]
    .map(b => ({ ...b, ...data[b.name] }))
    .filter(r => r.summary)
    .sort((a, b) => {
      const aOk = parseInt(a.summary.successRate);
      const bOk = parseInt(b.summary.successRate);
      if (aOk !== bOk) return bOk - aOk;
      return (parseFloat(b.summary.avgScore) || 0) - (parseFloat(a.summary.avgScore) || 0);
    });

  sorted.forEach((b, i) => {
    const badge = b.summary.successRate === "100%" ? "✅" : b.summary.errors > 0 ? "❌" : "⚠️";
    emit(`| ${i+1} | ${b.label} | ${b.summary.avgTime} | ${badge} ${b.summary.successRate} | ${b.summary.totalResults} | ${b.summary.avgScore}/10 |`);
  });
  emit();

  emit("## 📋 Detailed Per-Backend Results\n");
  for (const backend of BACKENDS) {
    const r = data[backend.name];
    if (!r) continue;
    emit(`### ${backend.label}\n`);
    for (const query of QUERIES) {
      const qr = r.queries[query];
      if (!qr) continue;
      emit(`**Query:** "${query}"`);
      if (qr.status === "ok") {
        emit(`- ✅ **Time:** ${qr.elapsed} | **Results:** ${qr.resultCount} | **Score:** ${qr.qualityScore}/10`);
        emit(`- 🏷 **Sample:** "${qr.sampleTitle}"`);
      } else {
        emit(`- ❌ **Error:** ${qr.error}`);
      }
      emit();
    }
    emit("---\n");
  }

  emit("## 🏆 Top Performers\n");
  const best = sorted.filter(b => parseFloat(b.summary.avgScore) > 0);
  if (best.length > 0) {
    emit(`**Best quality:** ${best[0].label} (**${best[0].summary.avgScore}/10**)`);
    const fastest = sorted.filter(b => b.summary.avgTime !== "N/A").sort((a, b) => {
      return parseInt(a.summary.avgTime) - parseInt(b.summary.avgTime);
    });
    if (fastest.length > 0) emit(`**Fastest:** ${fastest[0].label} (**${fastest[0].summary.avgTime}**)`);
  }
  emit();

  emit("---\n");
  emit(`_Generated by pi-search-multi benchmark on ${new Date().toISOString()}_`);

  return lines.join("\n");
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
