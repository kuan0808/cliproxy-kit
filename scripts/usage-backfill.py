#!/usr/bin/env python3
"""Recover token usage from Claude Code's transcripts for the time before quota-pilot's usage log.

Writes ~/.cache/cliproxy-kit/usage/history.jsonl in the log's line format, one line per session,
subagent flag, model and local hour (`t` the last request, `f` the first, `n` how many), without
an account (transcripts do not record which account served a request). The provider is read from
the model that answered, since a Claude Code session can use a Codex model through the proxy; a
model that names neither leaves it empty. The panel's all-providers view and session details read
it for the time before the log began. A message resumed or forked into another transcript counts
once, in the session it came from.

Reads the transcripts in CLAUDE_CONFIG_DIR, else ~/.claude, as scripts/connect-claude-code.sh does.
Run once after the plugin starts logging; running it again rewrites the file, unless it finds
nothing to write.
"""

import json
import os
import re
import subprocess
import sys
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path

HOME = Path.home()
PROJECTS = Path(os.environ.get("CLAUDE_CONFIG_DIR") or HOME / ".claude") / "projects"
USAGE = HOME / ".cache" / "cliproxy-kit" / "usage"
DAYS = 35


def log_start_ms() -> int:
    """When the usage log began: its earliest line, or now when there is none yet."""
    starts = []
    for f in sorted(USAGE.glob("20*.jsonl")):
        with f.open() as fh:
            for line in fh:
                try:
                    starts.append(json.loads(line)["t"])
                except (ValueError, KeyError):
                    continue
        if starts:
            break
    return min(starts) if starts else int(time.time() * 1000)


def ms(stamp: str) -> int:
    return int(datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp() * 1000)


def provider(model: str) -> str:
    """The provider that serves a model, named as the usage log names providers, or "" when the
    model does not tell."""
    m = model.lower()
    if "claude" in m:
        return "claude"
    if m.startswith("gpt-") or "codex" in m or re.match(r"o\d", m):
        return "codex"
    return ""


def born(path: Path) -> float:
    """When a transcript was created. A fork copies its parent's history from the first response on
    and its transcript says nothing of where it came from, so the two begin alike and only this
    tells the fork, the later file, from its parent. macOS keeps it in stat; on Linux GNU stat reads
    it where the file system keeps one (ext4, btrfs, xfs). Where neither does, 0: the two are told
    apart by path, and copies may count in the fork."""
    st = path.stat()
    if hasattr(st, "st_birthtime"):
        return st.st_birthtime
    try:
        out = subprocess.run(["stat", "--format=%W", str(path)], capture_output=True, text=True, timeout=5)
        return max(0.0, float(out.stdout.strip() or 0))
    except (OSError, ValueError, subprocess.SubprocessError):
        return 0.0


def main() -> int:
    cutoff = log_start_ms()
    earliest = cutoff - DAYS * 86_400_000
    # One response can be split over several entries that repeat its usage, filled in as it
    # streams, and a resumed or forked session copies earlier messages into its own transcript,
    # where a copy can carry no usage. So every copy is gathered first, whatever order the files
    # come in: a response counts the largest usage any copy holds, in the transcript that began
    # first, the one the others copied from (see born).
    # response -> [(total, (input, output, cache read, cache write)), (began, born, agent, session, path, ms, model)]
    best: dict = {}
    files = list(PROJECTS.glob("*/*.jsonl")) + list(PROJECTS.glob("*/*/subagents/*.jsonl"))
    scanned = 0
    for path in files:
        if path.stat().st_mtime * 1000 < earliest:
            continue
        scanned += 1
        sidechain_file = "subagents" in path.parts
        copies = []
        with path.open(errors="replace") as fh:
            for line in fh:
                if '"type":"assistant"' not in line or '"usage"' not in line:
                    continue
                try:
                    entry = json.loads(line)
                except ValueError:
                    continue
                message = entry.get("message") or {}
                usage = message.get("usage") or {}
                stamp = entry.get("timestamp")
                session = entry.get("sessionId")
                # "<synthetic>" marks messages Claude Code wrote itself, not model calls.
                if not usage or not stamp or not session or message.get("model") == "<synthetic>":
                    continue
                key = message.get("id") or entry.get("requestId") or entry.get("uuid")
                counts = tuple(usage.get(name) or 0 for name in
                               ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))
                agent = sidechain_file or bool(entry.get("isSidechain"))
                copies.append((key, counts, ms(stamp), session, agent, message.get("model") or ""))
        if not copies:
            continue
        began, created = min(c[2] for c in copies), born(path)
        for key, counts, t, session, agent, model in copies:
            usage, origin = (sum(counts), counts), (began, created, agent, session, str(path), t, model)
            have = best.setdefault(key, [usage, origin])
            have[0], have[1] = max(have[0], usage), min(have[1], origin)

    # (session, agent, model, local hour) -> [first ms, last ms, input, output, cache read, cache write, requests]
    sums: dict = defaultdict(lambda: [0, 0, 0, 0, 0, 0, 0])
    for (_, (i, o, cr, cw)), (_, _, agent, session, _, t, model) in best.values():
        if t < earliest or t >= cutoff:
            continue
        hour = datetime.fromtimestamp(t / 1000).strftime("%Y-%m-%d %H")
        row = sums[(session, agent, model, hour)]
        row[0] = min(row[0], t) if row[0] else t
        row[1] = max(row[1], t)
        row[2] += i
        row[3] += o
        row[4] += cr
        row[5] += cw
        row[6] += 1

    out = USAGE / "history.jsonl"
    before = datetime.fromtimestamp(cutoff / 1000)
    if not sums:
        # An empty file would only replace history recovered before, from the right folder.
        print(f"found no usage before {before} in {scanned} transcripts under {PROJECTS} "
              f"(set CLAUDE_CONFIG_DIR to Claude Code's folder if it is elsewhere); {out} is left as it was",
              file=sys.stderr)
        return 1
    USAGE.mkdir(parents=True, exist_ok=True)
    tmp = out.with_suffix(".tmp")
    with tmp.open("w") as fh:
        for (session, agent, model, _hour), (first, t, i, o, cr, cw, n) in sorted(sums.items(), key=lambda kv: (kv[1][1], kv[0])):
            line = {"t": t, "f": first, "s": session, "acct": "", "p": provider(model), "m": model, "i": i, "o": o, "cr": cr, "cw": cw, "n": n}
            if agent:
                line["a"] = True
            fh.write(json.dumps(line, separators=(",", ":")) + "\n")
    os.chmod(tmp, 0o600)
    tmp.replace(out)
    print(f"scanned {scanned} transcripts, wrote {len(sums)} lines before {before} to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
