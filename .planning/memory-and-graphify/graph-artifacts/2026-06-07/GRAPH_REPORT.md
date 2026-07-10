# Graph Report - jarvis-prime  (2026-06-07)

## Corpus Check
- 147 files · ~174,108 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1093 nodes · 1893 edges · 76 communities (70 shown, 6 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 3 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]
- [[_COMMUNITY_Community 11|Community 11]]
- [[_COMMUNITY_Community 12|Community 12]]
- [[_COMMUNITY_Community 13|Community 13]]
- [[_COMMUNITY_Community 14|Community 14]]
- [[_COMMUNITY_Community 15|Community 15]]
- [[_COMMUNITY_Community 16|Community 16]]
- [[_COMMUNITY_Community 17|Community 17]]
- [[_COMMUNITY_Community 18|Community 18]]
- [[_COMMUNITY_Community 19|Community 19]]
- [[_COMMUNITY_Community 20|Community 20]]
- [[_COMMUNITY_Community 21|Community 21]]
- [[_COMMUNITY_Community 22|Community 22]]
- [[_COMMUNITY_Community 23|Community 23]]
- [[_COMMUNITY_Community 24|Community 24]]
- [[_COMMUNITY_Community 25|Community 25]]
- [[_COMMUNITY_Community 26|Community 26]]
- [[_COMMUNITY_Community 27|Community 27]]
- [[_COMMUNITY_Community 28|Community 28]]
- [[_COMMUNITY_Community 29|Community 29]]
- [[_COMMUNITY_Community 30|Community 30]]
- [[_COMMUNITY_Community 31|Community 31]]
- [[_COMMUNITY_Community 32|Community 32]]
- [[_COMMUNITY_Community 33|Community 33]]
- [[_COMMUNITY_Community 34|Community 34]]
- [[_COMMUNITY_Community 35|Community 35]]
- [[_COMMUNITY_Community 36|Community 36]]
- [[_COMMUNITY_Community 37|Community 37]]
- [[_COMMUNITY_Community 38|Community 38]]
- [[_COMMUNITY_Community 39|Community 39]]
- [[_COMMUNITY_Community 40|Community 40]]
- [[_COMMUNITY_Community 41|Community 41]]
- [[_COMMUNITY_Community 42|Community 42]]
- [[_COMMUNITY_Community 43|Community 43]]
- [[_COMMUNITY_Community 44|Community 44]]
- [[_COMMUNITY_Community 45|Community 45]]
- [[_COMMUNITY_Community 46|Community 46]]
- [[_COMMUNITY_Community 47|Community 47]]
- [[_COMMUNITY_Community 48|Community 48]]
- [[_COMMUNITY_Community 49|Community 49]]
- [[_COMMUNITY_Community 50|Community 50]]
- [[_COMMUNITY_Community 51|Community 51]]
- [[_COMMUNITY_Community 52|Community 52]]
- [[_COMMUNITY_Community 53|Community 53]]
- [[_COMMUNITY_Community 54|Community 54]]
- [[_COMMUNITY_Community 55|Community 55]]
- [[_COMMUNITY_Community 56|Community 56]]
- [[_COMMUNITY_Community 57|Community 57]]
- [[_COMMUNITY_Community 58|Community 58]]
- [[_COMMUNITY_Community 59|Community 59]]
- [[_COMMUNITY_Community 60|Community 60]]
- [[_COMMUNITY_Community 61|Community 61]]
- [[_COMMUNITY_Community 62|Community 62]]
- [[_COMMUNITY_Community 63|Community 63]]
- [[_COMMUNITY_Community 64|Community 64]]
- [[_COMMUNITY_Community 65|Community 65]]
- [[_COMMUNITY_Community 66|Community 66]]
- [[_COMMUNITY_Community 67|Community 67]]
- [[_COMMUNITY_Community 68|Community 68]]
- [[_COMMUNITY_Community 69|Community 69]]
- [[_COMMUNITY_Community 71|Community 71]]
- [[_COMMUNITY_Community 72|Community 72]]
- [[_COMMUNITY_Community 73|Community 73]]

## God Nodes (most connected - your core abstractions)
1. `MessageProcessor` - 37 edges
2. `corpusCallosum()` - 23 edges
3. `Jarvis Prime — Unified Command Runtime + Corpus Callosum (Dual-Brain)` - 22 edges
4. `HemisphereClient` - 19 edges
5. `QueueMessage` - 15 edges
6. `TelegramPoller` - 15 edges
7. `AthenaWriteLedger` - 14 edges
8. `createTelegramOrchestratorHook()` - 14 edges
9. `Tier0Classifier` - 13 edges
10. `orchestrate()` - 13 edges

## Surprising Connections (you probably didn't know these)
- `makeRouterProcessor()` --calls--> `corpusCallosum()`  [EXTRACTED]
  src/__tests__/telegram-router.e2e.test.ts → src/brain/corpus-callosum.ts
- `ParseResult` --references--> `Dispatch`  [EXTRACTED]
  src/brain/dispatch-parser.ts → src/brain/dispatch-types.ts
- `ClassifyLLMConfig` --references--> `IntentClass`  [EXTRACTED]
  src/orchestrator/classify-llm.ts → src/orchestrator/types.ts
- `makeE2EProcessor()` --calls--> `corpusCallosum()`  [EXTRACTED]
  src/__tests__/corpus-callosum.e2e.test.ts → src/brain/corpus-callosum.ts
- `CallCounter` --references--> `HemisphereClient`  [EXTRACTED]
  src/__tests__/fallback-right-client.test.ts → src/brain/types.ts

## Import Cycles
- None detected.

## Communities (76 total, 6 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.07
Nodes (27): CorpusCallosumDeps, FallbackRightClient, FallbackRightClientConfig, FallbackRightClientLogger, AgentJsonResponse, defaultExec, ExecFileFn, RightBrainAgentClient (+19 more)

### Community 1 - "Community 1"
Cohesion: 0.04
Nodes (45): Acceptance Criteria, Architecture, Claude Code Configuration, Common prefix (both paths), Delivery, Deploy Boundary — Committed ≠ Live, Dual-brain outcome, Dual-brain path (natural language) (+37 more)

### Community 2 - "Community 2"
Cohesion: 0.09
Nodes (28): LeftHemisphereClient, LeftHemisphereConfig, LeftHemisphereLogger, Spawner, StreamSpawner, LeftHemisphereError, formatDeliberationCard(), DEFAULTS (+20 more)

### Community 3 - "Community 3"
Cohesion: 0.10
Nodes (15): defaultEncoderFactory(), dot(), FeatureExtractor, Tier0Classifier, Tier0Config, Tier0Logger, Tier0Result, toFloat32() (+7 more)

### Community 4 - "Community 4"
Cohesion: 0.06
Nodes (30): Acceptance Criteria, Acceptance Criteria (MCS primitive adds to Track B), Cross-track, Dependencies, In-Scope v1, In-Scope v2, Inputs, Interaction with Truth / Index / View Layering (+22 more)

### Community 5 - "Community 5"
Cohesion: 0.07
Nodes (28): Acceptance Mapping (SPEC → Waves), Dependency Graph (waves), Estimated Effort, Gate test (run BEFORE A1 fires), Inventory Snapshot (truth as of 2026-06-06), Open Questions — RESOLVED 2026-06-06, PLAN: Memory Architecture + Graphify Observability, Recon Findings That Change Phase 0 Assumptions (+20 more)

### Community 6 - "Community 6"
Cohesion: 0.16
Nodes (10): OrchestratorKind, MessageKind, buildLangfuseUsage(), isRateLimitOutput(), MessageProcessor, splitMessage(), spawnClaudeStream(), emitTelegramOutbound() (+2 more)

### Community 7 - "Community 7"
Cohesion: 0.14
Nodes (17): ToolsUsedSummary, CallosumEventPayload, corpusCallosum(), CorpusCallosumLogger, buildDraftUser(), formatHistoryLines(), HistoryEntry, integrationPrompt() (+9 more)

### Community 8 - "Community 8"
Cohesion: 0.16
Nodes (18): RelayResult, relayToLieutenant(), formatStatusTable(), getLieutenantStatus(), LieutenantStatus, execLocal(), execRemote(), resolveNode() (+10 more)

### Community 9 - "Community 9"
Cohesion: 0.15
Nodes (22): actionLabel(), composeFinalReply(), dailyRecap(), execFileP, orchestrate(), OrchestrateOptions, ORCHESTRATOR_SKILLS, RECAP_REPOS (+14 more)

### Community 10 - "Community 10"
Cohesion: 0.13
Nodes (17): SkillDispatch, buildSkillPrompt(), defaultLoader(), InvokeOptions, redact(), RightBrainSkillShim, RightBrainSkillShimConfig, RightBrainSkillShimLogger (+9 more)

### Community 11 - "Community 11"
Cohesion: 0.10
Nodes (22): buildAvsoV2PlanStep(), AFFIRM, AthenaConfirmArmResult, AthenaConfirmContext, AthenaConfirmDeliverCfg, AthenaConfirmReplyCfg, AthenaConfirmReplyResult, athenaConfirms (+14 more)

### Community 12 - "Community 12"
Cohesion: 0.09
Nodes (17): GenerationEndInput, GenerationHandle, GenerationStartInput, LangfuseClientLike, LangfuseObservationLike, LangfuseTraceLike, makeReporter(), MakeReporterOptions (+9 more)

### Community 13 - "Community 13"
Cohesion: 0.09
Nodes (22): dependencies, dotenv, fastify, langfuse, @xenova/transformers, zod, description, devDependencies (+14 more)

### Community 14 - "Community 14"
Cohesion: 0.15
Nodes (10): SkillShim, Mode, ModeState, PersistedState, normalizeSlashInput(), DeliberationEvidence, DeliverFn, matchDeepCommand() (+2 more)

### Community 15 - "Community 15"
Cohesion: 0.16
Nodes (16): agentIdProvider(), CachedSession, EmitInput, emitKernelEvent(), emitRoomBridge(), emitTelegramInbound(), endSession(), getAgentId() (+8 more)

### Community 16 - "Community 16"
Cohesion: 0.10
Nodes (20): Architecture notes, Cost / token tracking, Failure modes, Hard off (stop the stack), How to turn it off, How to use the dashboard, Known issue — dual-brain phase timestamps (W8.8.3), Nuclear (delete data) (+12 more)

### Community 17 - "Community 17"
Cohesion: 0.15
Nodes (16): HERE, TIER_POLICY_PATH, AVSO_V2_ABBREV, AVSO_V2_KINDS, AVSO_V2_PLACEHOLDER, AVSO_V2_TIER, AvsoV2Context, AvsoV2Kind (+8 more)

### Community 18 - "Community 18"
Cohesion: 0.14
Nodes (17): ALIAS_TO_AGENT, brokerUnreachable(), emitCommand(), EmitResponse, EnvelopeResponse, httpDefaultBroker(), isPhiBearingKind(), kernelFetch() (+9 more)

### Community 19 - "Community 19"
Cohesion: 0.13
Nodes (6): DebounceState, noopLogger, TelegramResponder, TelegramResponderLogger, TelegramResponderOptions, TelegramSendSurface

### Community 20 - "Community 20"
Cohesion: 0.24
Nodes (16): buildRevisionSystem(), buildSystem(), buildUserMessage(), formatAllowedSkills(), formatHistoryLines(), formatSeconds(), formatToolsBlock(), formatToolsUsedLine() (+8 more)

### Community 21 - "Community 21"
Cohesion: 0.20
Nodes (6): Handler, EventHandler, MessageQueue, QueueEvent, QueueMessage, QueueReceipt

### Community 22 - "Community 22"
Cohesion: 0.16
Nodes (15): buildPlanWithLLM(), cache, cacheGet(), cacheSet(), COMMAND_CATALOG, commandIsValid(), CommandSpec, fetchOllamaPlan() (+7 more)

### Community 23 - "Community 23"
Cohesion: 0.21
Nodes (15): HistoryEntry, ResearchDispatch, SkillInvocationResult, buildRightPass1Prompt(), buildUserMessage(), formatHistoryLines(), renderSkillEvidence(), renderTopics() (+7 more)

### Community 24 - "Community 24"
Cohesion: 0.15
Nodes (14): CorpusCallosumInput, HistoryEntry, IntegrationError, buildDeps(), buildLeftRouterContent(), CallArg, CannedResponse, CapturedInvoke (+6 more)

### Community 25 - "Community 25"
Cohesion: 0.18
Nodes (4): sleep(), TelegramPoller, TelegramPollerConfig, TelegramUpdate

### Community 26 - "Community 26"
Cohesion: 0.20
Nodes (13): cache, cacheGet(), cacheSet(), classifyIntentWithLLM(), ClassifyLLMConfig, fetchOllamaClassification(), FEWSHOTS, normalize() (+5 more)

### Community 27 - "Community 27"
Cohesion: 0.13
Nodes (6): __resetPhiGateBrokerForTest(), __setPhiGateBrokerForTest(), fetchCalls, SYNTH_ENVELOPE, fetchCalls, SYNTH_ENVELOPE

### Community 28 - "Community 28"
Cohesion: 0.12
Nodes (15): compilerOptions, declaration, esModuleInterop, forceConsistentCasingInFileNames, module, moduleResolution, outDir, resolveJsonModule (+7 more)

### Community 29 - "Community 29"
Cohesion: 0.21
Nodes (4): ConversationHistory, HistoryEntry, PromptBuilder, PromptBuilderConfig

### Community 30 - "Community 30"
Cohesion: 0.14
Nodes (13): A — Homebrew + Base Argus Tooling, Argus Mini Migration — SPEC, B — Wazuh Manager + Indexer + Dashboard, C — Code Helper / Stray Process Investigation, Constraints, D — Auth Doctrine Hardening, E — Retire Mac Pro Stanza, Goal (+5 more)

### Community 31 - "Community 31"
Cohesion: 0.24
Nodes (8): isNoConfirm(), classifyIntent(), ClassRule, RULES, COMMAND_TIER, tierFor(), IntentClass, classifyAndPlan()

### Community 32 - "Community 32"
Cohesion: 0.18
Nodes (8): buildPlan(), FieldResolution, PatternToPlan, QUERY_PLANS, statusPlan(), WORKFLOW_PLANS, BuildAvsoV2ContextInput, Plan

### Community 33 - "Community 33"
Cohesion: 0.14
Nodes (4): CallArg, CapturedInvoke, HAPPY_SKILL_RESULT, makeRouterProcessor()

### Community 34 - "Community 34"
Cohesion: 0.15
Nodes (12): atoms, generated_at, note, store_counts, claude-code-auto-memory, conversation-history.jsonl, hippocampus-project_state(jarvis-os), hippocampus-project_state(jarvis-prime-ORPHAN) (+4 more)

### Community 35 - "Community 35"
Cohesion: 0.18
Nodes (8): setAgentIdProvider(), baseSchema, Config, configSchema, loadConfig(), config, kernel, KEYS

### Community 36 - "Community 36"
Cohesion: 0.23
Nodes (4): KernelConfig, KernelRegister, loadKernelConfig(), RegisterOptions

### Community 37 - "Community 37"
Cohesion: 0.17
Nodes (9): AbortReason, AthenaWriteLedgerOptions, ConfirmRequest, LedgerResolution, NowFn, OpenRequest, OpenResult, PendingEntry (+1 more)

### Community 38 - "Community 38"
Cohesion: 0.23
Nodes (10): buildUserBlock(), OversightConfig, OversightInput, OversightVerdict, parseVerdict(), readEnv(), _recordFail(), _resetOversightBreakerForTests() (+2 more)

### Community 39 - "Community 39"
Cohesion: 0.15
Nodes (12): 1. events table, 2. sessions table, 3. envelopes table, 4. agents — tombstone dead, Archive Format, Constraints, Failure Handling, Goal (+4 more)

### Community 40 - "Community 40"
Cohesion: 0.15
Nodes (12): Abort / failure, AutoImporter guardrails (immutable — from the 2026-03-30 broadcast failure), Execution safety (W21 wiring is inert by default), Orchestrator wiring map (W21), Plan shape, Process A — X / Twitter post, Process B — Morning-show production, State machine (+4 more)

### Community 41 - "Community 41"
Cohesion: 0.24
Nodes (11): classifyConfirmReply(), clearConfirmReminder(), createTelegramOrchestratorHook(), endSession(), FAIL_EVENTS, makeHook(), { orchestrate, classifyIntent }, kernelFetch() (+3 more)

### Community 42 - "Community 42"
Cohesion: 0.47
Nodes (7): Dispatch, DispatchMode, ToolEvidence, BrainResult, CallosumTrace, HemisphereCallResult, HemisphereDraft

### Community 43 - "Community 43"
Cohesion: 0.24
Nodes (3): DeliveryClient, DeliveryClientConfig, SpoolEntry

### Community 44 - "Community 44"
Cohesion: 0.20
Nodes (9): 1. Why ratification, 2. Canonical atom (frontmatter form), 3. `type` enum (extended), 4. `source` enum (SPEC §49, extended by recon), 5. `confidence` derivation (B3 migration applies this), 6. Precedence hierarchy (SPEC §261 — lives at the READ site, not write), 7. Two open schema decisions for Tripp (from B1), 8. Next (B2.2 / B2.3 — code, not yet done) (+1 more)

### Community 45 - "Community 45"
Cohesion: 0.28
Nodes (8): CHROME_DEBUG_PORT, CHROME_EXTENSION_PORT, FHIR_SERVER, SCC_BACKEND_URL, node, athena-shadow, browser-bridge, chrome-cdp

### Community 46 - "Community 46"
Cohesion: 0.22
Nodes (8): Cross-tree references, Current State, Decisions log, Discoveries that changed the PLAN vs the SPEC, Next action, Open questions, Recon Summary (Phase 1), STATE: Memory Architecture + Graphify Observability

### Community 47 - "Community 47"
Cohesion: 0.31
Nodes (6): Reporter, OversightTurn, messageSchema, registerMessageRoute(), buildServer(), ServerContext

### Community 48 - "Community 48"
Cohesion: 0.25
Nodes (5): { orchestrate, classifyIntent }, EmitArgs, composeAthenaConfirm(), composeAthenaPatientSearchReply(), __resetAthenaConfirms()

### Community 50 - "Community 50"
Cohesion: 0.39
Nodes (6): formatPortfolioForTelegram(), renderRows(), baseRow, main(), resolveJarvisOsRoot(), resolveStoreRoot()

### Community 51 - "Community 51"
Cohesion: 0.43
Nodes (6): isRecord(), parseDispatch(), parseLeftToolsEvidence(), ParseResult, ParseWarning, isAllowedSkill()

### Community 52 - "Community 52"
Cohesion: 0.25
Nodes (7): How the gate runs, Notes for Tripp, Pre-registered grep baseline (fill during step 2), Q1 — project_state write paths (delegation across a process boundary), Q2 — memory read order + the trim race (DI + line-count-gated control flow), Q3 — message → delivery, including the fallback collapse (closure + catch-block branch), Track A Acceptance Gate — Test Questions (W0.5)

### Community 53 - "Community 53"
Cohesion: 0.25
Nodes (7): How Claude should invoke this, /note — Human-override portfolio upsert  `[T1 WRITE]`, Output (STATE.md missing frontmatter), Output (success), Output (unknown slug), Tier, Usage

### Community 54 - "Community 54"
Cohesion: 0.29
Nodes (4): ALL_TOKENS, countTokens(), expectClean(), { orchestrate, classifyIntent }

### Community 55 - "Community 55"
Cohesion: 0.25
Nodes (3): fetchCalls, SYNTH_ENVELOPE, verifyHits

### Community 56 - "Community 56"
Cohesion: 0.29
Nodes (6): Conflict classes (19 candidates), Deliverables in this dir, Findings that change the PLAN, Recommended PLAN deltas (for Tripp), Store inventory (truth as of 2026-06-07), Track B — Wave B1 Audit Summary (read-only)

### Community 57 - "Community 57"
Cohesion: 0.29
Nodes (6): B2.3 — Does `ProjectStateStore.upsert` generalize? (architecture note), Recommended shape, This resolves D1, What B2.2 delivered (done), What B3 will do with this, Why ProjectStateStore does not generalize

### Community 58 - "Community 58"
Cohesion: 0.47
Nodes (4): ClassifyInput, classifyMessage(), isShortMessageFastLane(), KNOWN_SLASH_COMMANDS

### Community 59 - "Community 59"
Cohesion: 0.33
Nodes (5): Blockers, Current, Jarvis Prime State, Next Action, Notes

### Community 60 - "Community 60"
Cohesion: 0.50
Nodes (4): add(), flush_section(), frontmatter(), Return (meta_dict, body) for a leading --- yaml block, else ({}, text).

### Community 61 - "Community 61"
Cohesion: 0.40
Nodes (4): auto-memory-vs-atom (11), B1.2 Conflict Map — 2026-06-06, duplicate-store (3), prose-vs-atom (5)

### Community 62 - "Community 62"
Cohesion: 0.40
Nodes (4): Auto-memory shape counts, B1.4 Schema Variance + Normalization Plan — 2026-06-06, Normalization rules (for B3 migration), Observed shapes

### Community 63 - "Community 63"
Cohesion: 0.50
Nodes (3): NATURAL_LABELS, phaseLabelForEvent(), SINGLE_BRAIN_LABELS

### Community 64 - "Community 64"
Cohesion: 0.70
Nodes (4): check(), kernelGet(), kernelPost(), run()

### Community 65 - "Community 65"
Cohesion: 0.40
Nodes (4): Env vars, How Claude should invoke this, /projects — Active portfolio [T0 READ], Safety

### Community 66 - "Community 66"
Cohesion: 0.40
Nodes (4): E2E Test Results — 2026-04-16, T20: Simple Message Smoke Tests, T21: Lieutenant Command Tests, T22: Security & Error Handling

### Community 67 - "Community 67"
Cohesion: 0.40
Nodes (3): ALLOWLIST, BLOCKLIST_PATTERNS, Entry

## Knowledge Gaps
- **415 isolated node(s):** `CHROME_EXTENSION_PORT`, `SCC_BACKEND_URL`, `FHIR_SERVER`, `CHROME_DEBUG_PORT`, `generated_at` (+410 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **6 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `MessageProcessor` connect `Community 6` to `Community 33`, `Community 3`, `Community 7`, `Community 14`, `Community 47`, `Community 15`, `Community 19`, `Community 21`, `Community 29`?**
  _High betweenness centrality (0.054) - this node is a cross-community bridge._
- **Why does `RightHemisphereError` connect `Community 0` to `Community 24`, `Community 42`, `Community 3`, `Community 14`?**
  _High betweenness centrality (0.022) - this node is a cross-community bridge._
- **Why does `AthenaWriteLedger` connect `Community 49` to `Community 48`, `Community 11`, `Community 37`, `Community 54`?**
  _High betweenness centrality (0.019) - this node is a cross-community bridge._
- **What connects `CHROME_EXTENSION_PORT`, `SCC_BACKEND_URL`, `FHIR_SERVER` to the rest of the system?**
  _416 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.06848357791754019 - nodes in this community are weakly interconnected._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.043478260869565216 - nodes in this community are weakly interconnected._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.09102564102564102 - nodes in this community are weakly interconnected._