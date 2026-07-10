# SPEC: Graphify Integration into Jarvis Network

**Phase:** 0 — Spec  
**Status:** Awaiting human approval  
**Date:** 2026-06-06  
**Repo:** https://github.com/safishamsi/graphify  
**Package:** `graphifyy` v0.8.33  

---

## 1. What It Is

Graphify is a **KG builder** (knowledge graph builder) — not a graph viz tool, not a graph DB, not a scraper.

Pipeline: `detect() → extract() → build_graph() → cluster() → analyze() → report() → export()`

- Ingests any folder of code, docs, papers, images, or video
- Parses code via tree-sitter AST (28 languages: Python, TypeScript, Go, Rust, Bash, PowerShell, SQL, HCL, and more)
- Builds a NetworkX graph with nodes (symbols) and edges (calls/imports/uses)
- Clusters communities via Leiden algorithm
- Identifies god nodes, surprises, and ambiguous relationships
- Exports: Obsidian vault, `graph.json`, `graph.html`, `graph.svg`, `GRAPH_REPORT.md`
- **MCP stdio server** (`serve.py`) — exposes graph query tools to Claude Code and other agents
- **Optional ingest**: fetches URLs (tweets, arxiv papers, web pages) and saves to corpus

## 2. License

**MIT** — permissive, no restrictions. Gate cleared.

## 3. Classification

| Dimension | Value |
|-----------|-------|
| Category | KG Builder |
| Primary use | Static code analysis → queryable knowledge graph |
| Runtime model | CPU-bound (leiden clustering is light; no GPU requirement) |
| External calls | Ingest URL fetching — optional, disabled by default |
| MCP server | Yes — stdio, integrates with Claude Code natively |
| PHI risk | Yes — if fed clinical-archive paths (see §7) |

## 4. Target Node

**Frank (Voldemort, 192.168.0.108)**

Per routing constraint: KG builder → Frank.

**Trade-off to note:** Frank is the correct home for persistent graph storage and heavy analysis runs. However, the MCP server (`graphify serve`) is most useful running local to whatever Claude Code session queries it. This means:

- Frank: graph builds, corpus storage, scheduled re-analysis
- SuperServer (Prime): `graphify serve` sidecar during active Claude Code sessions, reading Frank-built graphs over a shared mount or rsync

This is not a deviation from routing — it's a deployment topology note.

## 5. Phase 23 Substitute Evaluation

**Verdict: NOT a substitute. Phase 23 proceeds independently.**

Phase 23 ("Athena EMR — Vision + Surfing") is about **runtime DOM navigation** — screenshot → vision model → coordinate click → repeat. Its product is a live data extraction agent that navigates Athena's web UI.

Graphify is **static code analysis** — it reads source files and builds a dependency graph. It cannot click UI elements, interpret screenshots, or extract patient data from a live web session.

The only intersection: graphify *could* map `athena-extractor.ts` and surrounding modules before Phase 23 begins, giving a god-node and dependency report that informs where the CSS selectors are concentrated. That's a Phase 23 prep tool, not a replacement.

**Decision: Do not substitute. Phase 23 scope unchanged.**

## 6. Use Cases Ranked by ROI

### Use Case 1 (Highest ROI): `/projects` Dependency Graph
**What:** Run graphify on the jarvis-prime codebase. Map how skills, services, workers, routers, and MCP tools connect.  
**Value:** Identifies coupling hotspots (god nodes), surfaces unexpected dependencies before Wave 9 execution. Gives Prime a queryable graph of its own architecture via MCP.  
**Effort:** Low — one `graphify .` run in jarvis-prime workspace.  
**Output:** `GRAPH_REPORT.md` + MCP server query interface for codebase Q&A during planning sessions.

### Use Case 2 (Medium ROI): Station Automation Cause/Effect Map
**What:** Run graphify on the PretoriaFields codebase (`/home/djjarvis/.openclaw/workspace/PretoriaFields/`). Map WPFQ automation scripts, cron jobs, watchdogs, and their interdependencies.  
**Value:** The station runs a fragile chain of scripts (scheduler, watchdog, PlayoutONE API, DPL importer). A graph of cause/effect chains would let Prime reason about failure propagation — e.g., "if AutoImporter dies, what else breaks?"  
**Effort:** Medium — requires syncing PretoriaFields src to Frank or running graphify on Pretoria directly.  
**Output:** Automation dependency graph; community report highlighting isolation vs. tightly-coupled nodes.

### Use Case 3 (Lower ROI): DIL Recommendation Chains
**What:** Run graphify on `jarvis-os/src/services/improvement/` to map how the Daily Improvement Loop generates, routes, and applies recommendations.  
**Value:** The DIL pipeline (`jarvis-os` improvement service) is relatively small. Graph value is limited unless the improvement service grows significantly. Useful mainly if DIL is being refactored.  
**Effort:** Low — single-directory run.  
**Output:** Call graph of improvement worker → scorer → recommender → todo-filer chain.  
**Note:** Hold until DIL refactor is on the roadmap; otherwise it's a graph of a stable, small service.

## 7. PHI Containment

Graphify's node extraction is **PHI-unaware** — it will embed whatever text it finds in source files, docstrings, comments, and string literals into the knowledge graph. The `graph.json` output is not encrypted.

**Rules:**
- Never point graphify at `/home/tripp/Documents/claude-team/clinical-archive/` or any path containing patient data
- Never ingest operative notes, EMR extracts, or clinical documents
- If a future use case requires graphing clinical code (not data), ensure no PHI is co-located in that source tree
- Ingest URL feature (`graphify ingest <url>`) must not be used on patient-facing URLs without prior redaction review

## 8. Dependency Surface

| Dependency | Version | Notes |
|------------|---------|-------|
| Python | ≥ 3.10 | Frank runs Ubuntu + Conda — verify Python version |
| networkx | ≥ 3.4 | Core graph engine |
| tree-sitter + 28 grammars | ≥ 0.23.0 | AST parsing for all target langs |
| graspologic (leiden) | optional | `python_version < 3.13`; Frank must verify |
| mcp | optional | Required for MCP stdio server — install `graphifyy[mcp]` |
| neo4j | optional | Not needed for initial integration |
| anthropic / openai | optional | Not needed — we use our own LLM stack |

**Install target:** `uv tool install graphifyy[mcp,leiden,svg]` on Frank. MCP sidecar: `graphifyy[mcp]` on SuperServer (light, no leiden needed).

**Outbound network calls:**
- `ingest.py` — optional URL fetcher (http/https only, size-capped, timeout). Disabled unless explicitly called. Approval required before use on any Jarvis network run.
- No phone-home, no telemetry observed in source.

## 9. Acceptance Criteria

1. `graphify .` runs successfully on jarvis-prime workspace on Frank and produces `graphify-out/graph.json` + `GRAPH_REPORT.md`
2. `graphify serve graphify-out/graph.json` starts MCP stdio server and responds to at least one tool query from Claude Code on SuperServer
3. A god-node report for jarvis-prime codebase is produced and readable
4. No PHI paths are included in any graphify run; CI gate enforces this
5. Ingest URL feature is disabled in default invocation (requires explicit `--ingest` flag or direct `graphify ingest` call)
6. `graphify .` on PretoriaFields completes (Use Case 2 validation)

## 10. Out of Scope

- Neo4j integration — adds operational complexity; not needed for current use cases
- Clinical document ingestion — hard PHI constraint; blocked permanently unless redaction pipeline is built first
- Video/audio transcription feature (`faster-whisper`) — not relevant to Jarvis network use cases
- Google Workspace integration — not a current requirement
- Automated scheduled re-analysis — out of scope for Phase 0; revisit after first manual run proves value
- Replacing Athena Vision Phase 23 — evaluated and rejected (see §5)
- Running graphify on Argus or Scalpel — no use case identified

---

**Phase 0 complete. Awaiting Tripp's review and "approved" gate before Phase 1 begins.**
