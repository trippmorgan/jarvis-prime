#!/usr/bin/env python3
"""Blind second-opinion labels for the frank-shadow store using the Claude Code CLI (2026-10-30).

For every unlabeled case: `shadow-review next <reviewer>` hands out A/B in random order (the store
records the assignment), Claude judges task fulfilment from the answers + tool evidence only (never
the Jev scores), and the verdict is stored with `--model` provenance (independent-model-declaration,
NOT human ground truth). Stdlib only. Usage: label-with-claude.py [--limit N] [--model sonnet]
"""
import argparse, json, os, subprocess, sys, time, re
from pathlib import Path

PRIME = Path.home() / '.openclaw/workspace/jarvis-prime'
CLI = ['node', str(PRIME / 'dist/cli/shadow-review.js')]
CLAUDE = str(Path.home() / '.local/bin/claude')
OUT = Path(os.environ.get('LABEL_LOG', PRIME / '.data/logs/claude-labels.jsonl'))
A_CAP, EV_ITEM_CAP, EV_TOTAL_CAP = 6000, 500, 9000

SYSTEM = """You are an independent, blind reviewer of two answers given by a home-lab AI assistant ("Frank") to its owner's chat message.
Judge TASK FULFILMENT FROM EVIDENCE: did the answer do what the message asked, truthfully, with claims supported by the tool evidence shown? Prefer the answer that is correct, grounded and complete; penalise fabrication, promises without execution, and claims with no supporting evidence. Style and length matter less than correctness and grounding. An empty answer never wins unless the other is harmful or fabricated.
You do NOT know which answer came from which system, and you must not try to guess. Do not consult any scores.
Respond with ONLY one JSON object, no prose:
{"choice":"A"|"B"|"equal"|"abstain","reason":"<one sentence, <=200 chars>","family":"<kebab-case task family, e.g. status-check, file-edit, web-research, code-fix, chat, self-question>"}
Use "equal" when both fulfil the task about equally or both fail equally; "abstain" only if the task is unintelligible from the material."""

def env():
    e = dict(os.environ); e.pop('CLAUDECODE', None); e.pop('CLAUDE_CODE_ENTRYPOINT', None); return e

def cli(*args):
    r = subprocess.run(CLI + list(args), capture_output=True, text=True, timeout=120)
    if r.returncode != 0: raise RuntimeError(f'shadow-review {args[0]}: {r.stderr.strip()[:300]}')
    return r.stdout

def evid(items):
    out, total = [], 0
    for it in items or []:
        line = f"- {it.get('tool')} {str(it.get('input',''))[:200]} => [{it.get('status')}] {str(it.get('result',''))[:EV_ITEM_CAP]}"
        total += len(line)
        if total > EV_TOTAL_CAP: out.append('- … (evidence truncated)'); break
        out.append(line)
    return '\n'.join(out) if out else '(no tool evidence)'

def prompt(c):
    cap = lambda s: (s[:A_CAP] + ' …[truncated]') if len(s) > A_CAP else s
    return (f"MESSAGE FROM OWNER:\n{c['task'][:3000]}\n\n=== ANSWER A ===\n{cap(c['A']) or '(empty answer)'}\n\nEVIDENCE A:\n{evid(c.get('evidenceA'))}\n\n"
            f"=== ANSWER B ===\n{cap(c['B']) or '(empty answer)'}\n\nEVIDENCE B:\n{evid(c.get('evidenceB'))}\n")

def judge(c, model):
    r = subprocess.run([CLAUDE, '--print', '--model', model, '--dangerously-skip-permissions', '--system-prompt', SYSTEM],
                       input=prompt(c), capture_output=True, text=True, timeout=300, env=env())
    if r.returncode != 0: raise RuntimeError(f'claude exit {r.returncode}: {r.stderr.strip()[:300]}')
    m = re.search(r'\{.*\}', r.stdout, re.S)
    if not m: raise RuntimeError(f'no JSON in reply: {r.stdout[:200]!r}')
    j = json.loads(m.group(0))
    if j.get('choice') not in ('A', 'B', 'equal', 'abstain'): raise RuntimeError(f'bad choice {j!r}')
    fam = re.sub(r'[^a-z0-9-]+', '-', str(j.get('family', 'unknown')).lower()).strip('-') or 'unknown'
    return j['choice'], str(j.get('reason', ''))[:300].replace('\n', ' ') or 'no reason given', fam

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--limit', type=int, default=10000); ap.add_argument('--model', default='sonnet')
    ap.add_argument('--reviewer', default='claude-cli'); a = ap.parse_args()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    done = fails = 0
    while done + fails < a.limit:
        nxt = cli('next', a.reviewer).strip()
        if nxt == 'null' or not nxt: print('no unlabeled cases left', flush=True); break
        c = json.loads(nxt); t0 = time.time()
        try:
            choice, reason, fam = judge(c, a.model)
            cli('label', a.reviewer, c['caseId'], choice, reason, fam, '--independent', '--model', f'claude-{a.model}')
            done += 1; rec = dict(caseId=c['caseId'], choice=choice, family=fam, reason=reason, s=round(time.time() - t0, 1), at=time.strftime('%FT%TZ', time.gmtime()))
        except Exception as e:  # leave the case unlabeled; the assignment stays so a retry gets the same A/B
            fails += 1; rec = dict(caseId=c['caseId'], error=str(e)[:300], s=round(time.time() - t0, 1), at=time.strftime('%FT%TZ', time.gmtime()))
            if fails >= 5 and done == 0: print('aborting: first 5 judgments all failed', flush=True); break
            # a failed case would be handed out again forever; mark it abstain so the loop advances
            try: cli('label', a.reviewer, c['caseId'], 'abstain', f'labeler error: {str(e)[:120]}', 'labeler-error', '--independent', '--model', f'claude-{a.model}')
            except Exception as e2: rec['abstainError'] = str(e2)[:120]
        with OUT.open('a') as f: f.write(json.dumps(rec) + '\n')
        print(json.dumps(rec), flush=True)
    print(f'labeled={done} failed={fails}', flush=True)

if __name__ == '__main__': main()
