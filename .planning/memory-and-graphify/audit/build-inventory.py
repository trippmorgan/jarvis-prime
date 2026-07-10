#!/usr/bin/env python3
"""B1 audit: parse every atom across the memory stores into a uniform model.
Read-only. Writes audit/atom-inventory.json + feeds conflict/PHI/stale analyses.
SPEC: PLAN.md Wave B1. No mutations to any source store."""
import json, os, re, sqlite3, hashlib, glob
from datetime import datetime, timezone

WS = "/home/tripp/.openclaw/workspace"
AUDIT = f"{WS}/jarvis-prime/.planning/memory-and-graphify/audit"
NOW = datetime(2026, 6, 6, tzinfo=timezone.utc)

atoms = []

def frontmatter(text):
    """Return (meta_dict, body) for a leading --- yaml block, else ({}, text)."""
    if not text.startswith("---"):
        return {}, text
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}, text
    meta, body = {}, parts[2].strip()
    for line in parts[1].strip().splitlines():
        m = re.match(r"^([A-Za-z0-9_.]+):\s*(.*)$", line.strip())
        if m:
            meta[m.group(1)] = m.group(2).strip().strip('"')
    return meta, body

def add(store, aid, atype, body, ts, source, phi_flag, extra=None):
    atoms.append({
        "store": store, "id": aid, "type": atype,
        "body_chars": len(body or ""),
        "body_preview": (body or "").replace("\n", " ")[:160],
        "ts": ts, "source_inferred": source,
        "phi_flag": phi_flag,
        "extra": extra or {},
        "_body": body or "",
    })

# ---- Store 1: workspace MEMORY.md (prose; split into heading sections) -------
mem = open(f"{WS}/MEMORY.md").read()
mtime = datetime.fromtimestamp(os.path.getmtime(f"{WS}/MEMORY.md"), timezone.utc).isoformat()
cur_h, buf = None, []
def flush_section(h, lines):
    if h is None:
        return
    body = "\n".join(lines).strip()
    add("workspace-MEMORY.md", h, "prose-block", body, mtime, "prose-narrative", False,
        extra={"heading": h})
for ln in mem.splitlines():
    m = re.match(r"^(#{2,3})\s+(.*)$", ln)
    if m:
        flush_section(cur_h, buf)
        cur_h, buf = m.group(2).strip(), []
    elif cur_h is not None:
        buf.append(ln)
flush_section(cur_h, buf)

# ---- Store 2: workspace context docs (static persona) -----------------------
for f in ["SOUL","IDENTITY","USER","AGENTS","HEARTBEAT","TOOLS","ARCHITECTURE",
          "PHI-SECURITY-EDICT","PROJECT-URLS","SLASH_COMMANDS","MORNING-BRIEFING"]:
    p = f"{WS}/{f}.md"
    if os.path.exists(p):
        t = open(p).read()
        ts = datetime.fromtimestamp(os.path.getmtime(p), timezone.utc).isoformat()
        add("workspace-context-docs", f"{f}.md", "static-doc", t, ts, "persona-doc", False)

# ---- Store 3: Claude Code auto-memory ---------------------------------------
ccm = "/home/tripp/.claude/projects/-home-tripp--openclaw-workspace/memory"
for p in sorted(glob.glob(f"{ccm}/*.md")):
    name = os.path.basename(p)
    if name == "MEMORY.md":
        continue
    t = open(p).read()
    meta, body = frontmatter(t)
    # schema variance: detect by which key appears first inside the frontmatter
    fm = t.split("---", 2)[1] if t.startswith("---") else ""
    if re.search(r"^\s*metadata:\s*$", fm, re.M):
        shape = "nested"
    elif re.search(r"^type:", fm, re.M):
        shape = "flat"
    else:
        shape = "none"
    atype = meta.get("type") or "unknown"
    ts = datetime.fromtimestamp(os.path.getmtime(p), timezone.utc).isoformat()
    add("claude-code-auto-memory", name, atype, body, ts,
        meta.get("source", "auto-memory"), str(meta.get("phi","false")).lower()=="true",
        extra={"schema_shape": shape, "name_slug": meta.get("name")})

# ---- Store 4a: hippocampus project_state (jarvis-os — CANONICAL) ------------
for p in sorted(glob.glob(f"{WS}/jarvis-os/.data/project-state/*.md")):
    meta, body = frontmatter(open(p).read())
    add("hippocampus-project_state(jarvis-os)", os.path.basename(p),
        meta.get("type","project_state"), meta.get("summary","")+" || "+meta.get("next_action",""),
        meta.get("updated_at"), meta.get("source","unknown"),
        str(meta.get("phi","false")).lower()=="true",
        extra={"project": meta.get("project"), "status": meta.get("status"),
               "source_path": meta.get("source_path")})

# ---- Store 4b: ORPHANED project_state (jarvis-prime/.data — stale stubs) ----
for p in sorted(glob.glob(f"{WS}/jarvis-prime/.data/hippocampus/project_state/*.md")):
    meta, body = frontmatter(open(p).read())
    add("hippocampus-project_state(jarvis-prime-ORPHAN)", os.path.basename(p),
        meta.get("type","project_state"), meta.get("summary","")+" || "+meta.get("next_action",""),
        meta.get("updated_at"), meta.get("source","unknown"),
        str(meta.get("phi","false")).lower()=="true",
        extra={"project": meta.get("project"), "status": meta.get("status")})

# ---- Store 5: conversation-history.jsonl (truth layer, auto-trims) ----------
hp = f"{WS}/jarvis-prime/.data/conversation-history.jsonl"
hlines = [l for l in open(hp).read().splitlines() if l.strip()]
for i, l in enumerate(hlines):
    d = json.loads(l)
    add("conversation-history.jsonl", f"turn-{i}", f"conv-{d.get('role')}",
        d.get("content",""), d.get("timestamp"), "conversation", False)

# ---- Store 6: hippocampus vault index.db (vector store) ---------------------
db = sqlite3.connect(f"{WS.replace('/workspace','')}/hippocampus-vault/.hippocampus/index.db")
ncount = db.execute("SELECT count(*) FROM notes").fetchone()[0]
for r in db.execute("SELECT slug,type,phi,updated_at,source FROM notes"):
    add("hippocampus-vault(index.db)", r[0], r[1], "", r[3], r[4] or "vault", bool(r[2]))

# ---- write inventory --------------------------------------------------------
os.makedirs(AUDIT, exist_ok=True)
slim = [{k:v for k,v in a.items() if k != "_body"} for a in atoms]
inv = {
    "generated_at": NOW.isoformat(),
    "note": "B1 read-only audit. Bodies omitted from JSON (PHI-safe); previews <=160 chars.",
    "store_counts": {},
    "total_atoms": len(atoms),
    "vault_notes_in_db": ncount,
    "atoms": slim,
}
for a in atoms:
    inv["store_counts"][a["store"]] = inv["store_counts"].get(a["store"], 0) + 1
json.dump(inv, open(f"{AUDIT}/atom-inventory.json","w"), indent=2)

# ---- expose atoms for downstream analyses -----------------------------------
json.dump([{k:v for k,v in a.items()} for a in atoms],
          open(f"{AUDIT}/.atoms-full.json","w"), indent=2)

print("STORE COUNTS")
for s,c in sorted(inv["store_counts"].items()):
    print(f"  {c:>4}  {s}")
print(f"  ---- total {len(atoms)} atoms; vault notes in db = {ncount}")
