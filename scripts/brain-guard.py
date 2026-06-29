#!/usr/bin/env python3
"""PreToolUse guardrail logic for the Argus jarvis-prime brain.

Invoked by brain-guard.sh. Reads the PreToolUse hook payload on stdin.
 - Always appends an audit line (best-effort) for the brain's tool calls.
 - Blocks a tight catastrophe deny-list by printing a token to stderr and
   exiting 2. The wrapper only treats exit 2 + token as a real block, so a
   crash or missing-file can never be mistaken for a deny.

Allow = exit 0. Deny = print 'BRAIN-GUARD BLOCKED: ...' to stderr + exit 2.
Any internal error falls through to exit 0 (fail open).
"""
import sys, json, os, re, datetime

AUDIT_DIR = "/Users/trippmorgan/.openclaw/workspace/jarvis-prime/logs"


def deny(reason):
    sys.stderr.write(
        "BRAIN-GUARD BLOCKED: " + reason +
        " (Argus security policy — denied on the security node).\n"
    )
    sys.exit(2)


def main():
    try:
        raw = sys.stdin.read()
        data = json.loads(raw) if raw.strip() else {}
    except Exception:
        sys.exit(0)  # unparseable payload -> fail open

    # No-op for non-brain sessions (defence in depth; the wrapper checks too).
    if not os.environ.get("JARVIS_BRAIN_GUARD"):
        sys.exit(0)

    tool = data.get("tool_name", "") or ""
    tin = data.get("tool_input", {}) or {}
    if not isinstance(tin, dict):
        tin = {}
    cmd = tin.get("command") or ""
    fpath = tin.get("file_path") or ""

    # ---- audit (best-effort; never blocks) ------------------------------
    try:
        if tool == "Bash":
            summary = cmd[:600]
        elif fpath:
            summary = fpath
        else:
            summary = ",".join(sorted(tin.keys()))[:200]
        os.makedirs(AUDIT_DIR, exist_ok=True)
        day = datetime.date.today().isoformat()
        line = json.dumps({
            "ts": datetime.datetime.now().isoformat(timespec="seconds"),
            "guard": os.environ.get("JARVIS_BRAIN_GUARD", ""),
            "session": data.get("session_id", ""),
            "tool": tool,
            "summary": summary,
        }, ensure_ascii=False)
        with open(os.path.join(AUDIT_DIR, "brain-audit-%s.jsonl" % day), "a") as fh:
            fh.write(line + "\n")
    except Exception:
        pass  # audit failure must not block the brain

    # ---- catastrophe deny-list (high precision, never-legitimate) -------
    if tool == "Bash" and cmd:
        c = re.sub(r"\s+", " ", cmd)  # normalize whitespace

        # 1) recursive delete of a system/home ROOT (not a workspace subpath)
        rm_recursive = re.search(r"\brm\b.*(-{1,2}[a-zA-Z]*[rR]|--recursive)", c)
        root_target = re.search(
            r"(?:\s)(/|/\*|~|~/\*?|\$HOME/?\*?|/Users|/System|/Library|/Volumes|/etc|/var|/bin|/usr)(?:\s|$|/\*|\"|')",
            " " + c + " ",
        )
        if rm_recursive and root_target:
            deny("recursive delete targeting a system/home root")

        # 2) disk destruction / reformat
        if (re.search(r"\b(diskutil\s+(erase|reformat|partitiondisk)\w*|mkfs\S*|newfs\S*)\b", c, re.I)
                or re.search(r"\bdd\b[^|]*\bof=/dev/", c, re.I)
                or re.search(r">\s*/dev/r?disk", c, re.I)):
            deny("disk erase/format/raw-device write")

        # 3) fork bomb
        if re.search(r":\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:", c):
            deny("fork bomb")

        # 4) curl|wget piped straight into a shell (remote code execution)
        if re.search(r"\b(curl|wget|fetch)\b[^|]*\|\s*(sudo\s+)?[a-z]*sh\b", c, re.I):
            deny("piping a downloaded script directly into a shell")

        # 5) self-neutering: don't let the brain disable its own guard / trust
        if re.search(r"\blaunchctl\s+(bootout|disable|unload|remove)\b.*argus", c, re.I):
            deny("disabling the Argus launchd services")
        if (re.search(r"\.ssh/authorized_keys", c)
                and re.search(r"(>|>>|\btee\b|\brm\b|\btruncate\b|sed\s+-i|\bcat\b\s*>)", c)):
            deny("modifying ~/.ssh/authorized_keys")
        if re.search(r"chmod\s+(-R\s+)?0?777\b.*\.ssh", c, re.I):
            deny("world-opening the .ssh directory")
        if re.search(r"(\brm\b|>|>>|\btee\b|\bmv\b|\bcp\b).*\.claude/settings\.json", c):
            deny("tampering with the guard's own settings.json")
        if re.search(r"(\brm\b|>|>>|\btee\b|\bmv\b).*LaunchAgents/com\.jarvis\.argus", c, re.I):
            deny("rewriting the Argus launchd plists")

    elif tool in ("Write", "Edit", "MultiEdit") and fpath:
        if re.search(r"(/\.ssh/authorized_keys$|\.claude/settings\.json$|LaunchAgents/com\.jarvis\.argus[\w.\-]*\.plist$)", fpath):
            deny("writing to a guardrail-protected path (" + fpath + ")")

    sys.exit(0)  # default: allow


try:
    main()
except SystemExit:
    raise
except Exception:
    sys.exit(0)  # any unexpected error -> fail open
