#!/usr/bin/env python3
"""B1.2-B1.5 analyses over .atoms-full.json: conflicts, PHI scan, schema
normalization plan, stale shortlist. Read-only. Writes markdown + phi log."""
import json, re, os
from datetime import datetime, timezone

AUDIT = os.path.dirname(os.path.abspath(__file__))
NOW = datetime(2026, 6, 6, tzinfo=timezone.utc)
atoms = json.load(open(f"{AUDIT}/.atoms-full.json"))

def parse_ts(s):
    if not s: return None
    try: return datetime.fromisoformat(s.replace("Z","+00:00"))
    except Exception: return None

# ===== B1.3 PHI SCAN (run first; halt-worthy) ================================
PHI_PATTERNS = {
    "SSN": re.compile(r"\b\d{3}-\d{2}-\d{4}\b"),
    "MRN": re.compile(r"\bMRN[:#\s]*\d{5,}\b", re.I),
    "DOB": re.compile(r"\b(0?[1-9]|1[0-2])[/-](0?[1-9]|[12]\d|3[01])[/-](19|20)\d\d\b"),
    "phone": re.compile(r"\b\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b"),
    "insurance": re.compile(r"\b(policy|member|subscriber)\s*(id|#|no)[:#\s]*\w{6,}\b", re.I),
}
# Files whose PURPOSE is documenting PHI patterns — a regex match there is the
# policy describing itself, not patient data. Classified BENIGN-SELFREF, not HALT.
POLICY_DOCS = {"PHI-SECURITY-EDICT.md"}
phi_hits, benign = [], []
for a in atoms:
    body = a["_body"]
    for label, rx in PHI_PATTERNS.items():
        if rx.search(body):
            rec = {"store": a["store"], "id": a["id"], "pattern": label}  # never echo match text
            (benign if a["id"] in POLICY_DOCS else phi_hits).append(rec)
with open(f"{AUDIT}/phi-scan.log", "w") as f:
    f.write(f"# B1.3 PHI scan — {NOW.isoformat()}\n")
    f.write(f"# atoms scanned: {len(atoms)}\n")
    f.write(f"# patterns: {', '.join(PHI_PATTERNS)}\n")
    if not phi_hits:
        f.write("RESULT: CLEAN — zero real-PHI pattern matches across all stores.\n")
    else:
        f.write(f"RESULT: {len(phi_hits)} POTENTIAL HIT(S) — HALT, review with Tripp.\n")
        for h in phi_hits:
            f.write(f"  HIT  store={h['store']}  id={h['id']}  pattern={h['pattern']}\n")
    if benign:
        f.write(f"\n# {len(benign)} BENIGN-SELFREF (policy doc documenting the pattern, not PHI):\n")
        for h in benign:
            f.write(f"  BENIGN  store={h['store']}  id={h['id']}  pattern={h['pattern']}\n")
PHI_CLEAN = not phi_hits

# ===== B1.2 CONFLICT DETECTION ===============================================
# Key heuristic: project-name match across stores asserting differing state.
def project_key(a):
    ex = a.get("extra") or {}
    if ex.get("project"): return ex["project"]
    # MEMORY.md prose / pointers / auto-memory: infer slug from id/body
    txt = (a["id"] + " " + a["body_preview"]).lower()
    for slug in ["jarvis-prime","jarvis-os","frank-v3","frank","pretoria","athena-scribe",
                 "athena-emr","kitchen-hub","hippocampus","corpus-callosum","phi-flow",
                 "self-healing","improvement-loop","portfolio-surface"]:
        if slug in txt: return slug.replace("frank","frank-v3") if slug=="frank" else slug
    return None

by_proj = {}
for a in atoms:
    k = project_key(a)
    if k: by_proj.setdefault(k, []).append(a)

conflicts = []
# duplicate project_state across the two physical stores
osps = {a["extra"].get("project"): a for a in atoms
        if a["store"].startswith("hippocampus-project_state(jarvis-os")}
orph = {a["extra"].get("project"): a for a in atoms
        if "ORPHAN" in a["store"]}
for proj, oa in orph.items():
    ca = osps.get(proj)
    conflicts.append({
        "kind": "duplicate-store",
        "project": proj,
        "detail": f"ORPHAN stub ({oa['ts']}) vs canonical jarvis-os atom "
                  f"({ca['ts'] if ca else 'MISSING'}). Orphan body: '{oa['body_preview'][:60]}'",
    })

# prose (MEMORY.md) vs atom divergence on same project
mem_blocks = [a for a in atoms if a["store"]=="workspace-MEMORY.md"]
for proj, atomrec in osps.items():
    # find a memory prose block mentioning this project
    hits = [m for m in mem_blocks if proj and proj in (m["id"]+m["_body"]).lower()]
    if hits and atomrec:
        conflicts.append({
            "kind": "prose-vs-atom",
            "project": proj,
            "detail": f"MEMORY.md prose mentions '{proj}' in {len(hits)} section(s); "
                      f"canonical atom status='{atomrec['extra'].get('status')}' "
                      f"updated {atomrec['ts']}. Verify prose not stale vs atom.",
        })

# auto-memory project_* files vs project_state atoms (two narratives, same project)
am = [a for a in atoms if a["store"]=="claude-code-auto-memory" and a["type"]=="project"]
for proj, atomrec in osps.items():
    hits = [x for x in am if proj and proj.split("-")[0] in x["id"].lower()]
    if hits:
        conflicts.append({
            "kind": "auto-memory-vs-atom",
            "project": proj,
            "detail": f"{len(hits)} Claude-Code auto-memory project file(s) overlap "
                      f"canonical atom for '{proj}' — two parallel narratives to reconcile.",
        })

with open(f"{AUDIT}/conflicts.md", "w") as f:
    f.write(f"# B1.2 Conflict Map — {NOW.date()}\n\n")
    f.write(f"Atoms analyzed: {len(atoms)} across 7 physical stores.\n\n")
    f.write(f"**{len(conflicts)} conflict candidate(s)** found. Grouped by kind.\n\n")
    for kind in ["duplicate-store","prose-vs-atom","auto-memory-vs-atom"]:
        rows = [c for c in conflicts if c["kind"]==kind]
        if not rows: continue
        f.write(f"## {kind} ({len(rows)})\n\n")
        f.write("| project | detail |\n|---|---|\n")
        for c in rows:
            f.write(f"| `{c['project']}` | {c['detail']} |\n")
        f.write("\n")

# ===== B1.4 SCHEMA VARIANCE NORMALIZATION PLAN ===============================
shapes = {}
for a in atoms:
    if a["store"]=="claude-code-auto-memory":
        s = a["extra"].get("schema_shape","?")
        shapes.setdefault(s, []).append(a["id"])
with open(f"{AUDIT}/schema-normalization-plan.md","w") as f:
    f.write(f"# B1.4 Schema Variance + Normalization Plan — {NOW.date()}\n\n")
    f.write("## Observed shapes\n\n")
    f.write("| store | type field | notes |\n|---|---|---|\n")
    f.write("| hippocampus-project_state (jarvis-os) | flat `type: project_state` + full provenance | **canonical target** — has source/source_path/owner/updated_at/visibility/phi |\n")
    f.write("| hippocampus-vault index.db | SQL column `type` CHECK IN (user,feedback,project,reference) | **empty (0 rows)** — schema only; narrower type enum than atoms |\n")
    f.write("| claude-code-auto-memory | mixed flat vs nested `metadata.type` | see counts below |\n")
    f.write("| workspace-MEMORY.md | none (prose) | heading-derived; no machine schema |\n")
    f.write("| conversation-history.jsonl | `{role,content,timestamp}` | truth layer; no type/provenance |\n\n")
    f.write("## Auto-memory shape counts\n\n")
    for s, ids in shapes.items():
        f.write(f"- **{s}**: {len(ids)} files\n")
    f.write("\n## Normalization rules (for B3 migration)\n\n")
    f.write("1. Canonical schema = the jarvis-os project_state frontmatter "
            "(source, source_path, owner, updated_at, visibility, phi) extended with "
            "`name`, `description`, `confidence`.\n")
    f.write("2. Auto-memory **nested** (`metadata.type`/`metadata.node_type`) → lift to flat "
            "`type`; map `node_type` to `source` where present.\n")
    f.write("3. Auto-memory **flat** (`type:`) → pass through; backfill `updated_at` from mtime, "
            "`source: claude-code-auto-memory`.\n")
    f.write("4. Vault type enum (user/feedback/project/reference) is a **subset** — when migrating "
            "atoms of type session-summary/static-doc/mcs-confirmed INTO the vault, either widen the "
            "CHECK constraint or keep those types out of the vault and only in project_state-style files.\n")
    f.write("5. conversation-history turns are NOT atoms — they are TRUTH-layer events; migration "
            "extracts confirmed facts FROM them, never rewrites them (SPEC Q1).\n")

# ===== B1.5 STALE SHORTLIST ==================================================
stale = []
for a in atoms:
    ts = parse_ts(a["ts"])
    if ts is None: continue
    age = (NOW - ts).days
    if age > 60:
        stale.append((age, a))
stale.sort(key=lambda x: x[0], reverse=True)
with open(f"{AUDIT}/stale-candidates.md","w") as f:
    f.write(f"# B1.5 Stale Atom Shortlist (>60d, as of {NOW.date()})\n\n")
    f.write("Age-based only; cross-reference with recent conversation before pruning. "
            "Static persona docs are expected-stale and flagged as KEEP.\n\n")
    f.write("| age(d) | store | id | type | source |\n|---|---|---|---|---|\n")
    for age, a in stale:
        keep = " *(KEEP: persona)*" if a["type"] in ("static-doc",) else ""
        f.write(f"| {age} | {a['store'].split('(')[0]} | `{a['id']}` | {a['type']}{keep} | {a['source_inferred']} |\n")

print(f"PHI scan: {'CLEAN' if PHI_CLEAN else str(len(phi_hits))+' HITS — HALT'}")
print(f"Conflicts: {len(conflicts)} candidates")
print(f"Auto-memory shapes: {{ {', '.join(f'{k}:{len(v)}' for k,v in shapes.items())} }}")
print(f"Stale (>60d): {len(stale)} atoms")
