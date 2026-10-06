#!/usr/bin/env python3
"""Recover token usage from Claude Code's transcripts for the time before quota-pilot's usage log.

Writes ~/.cache/cliproxy-kit/usage/history.jsonl in the log's line format, one line per session,
subagent flag, model and local hour (`t` the last request, `f` the first, `n` how many), without
an account (transcripts do not record which account served a request). The panel's all-providers
view and session details read it for the time before the log began. A message resumed or forked
into another transcript counts once.

Run once after the plugin starts logging; running it again rewrites the file.
"""

import json
import os
import sys
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path

HOME = Path.home()
PROJECTS = HOME / ".claude" / "projects"
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


def main() -> int:
    cutoff = log_start_ms()
    earliest = cutoff - DAYS * 86_400_000
    # (session, agent, model, local hour) -> [first ms, last ms, input, output, cache read, cache write, requests]
    sums: dict = defaultdict(lambda: [0, 0, 0, 0, 0, 0, 0])
    seen = set()
    files = list(PROJECTS.glob("*/*.jsonl")) + list(PROJECTS.glob("*/*/subagents/*.jsonl"))
    scanned = 0
    for path in files:
        if path.stat().st_mtime * 1000 < earliest:
            continue
        scanned += 1
        sidechain_file = "subagents" in path.parts
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
                # One response can be split over several entries that repeat its usage, and a
                # resumed or forked session copies earlier messages into its own transcript.
                key = message.get("id") or entry.get("requestId") or entry.get("uuid")
                if key in seen:
                    continue
                seen.add(key)
                t = ms(stamp)
                if t < earliest or t >= cutoff:
                    continue
                agent = sidechain_file or bool(entry.get("isSidechain"))
                hour = datetime.fromtimestamp(t / 1000).strftime("%Y-%m-%d %H")
                row = sums[(session, agent, message.get("model") or "", hour)]
                row[0] = min(row[0], t) if row[0] else t
                row[1] = max(row[1], t)
                row[2] += usage.get("input_tokens") or 0
                row[3] += usage.get("output_tokens") or 0
                row[4] += usage.get("cache_read_input_tokens") or 0
                row[5] += usage.get("cache_creation_input_tokens") or 0
                row[6] += 1

    USAGE.mkdir(parents=True, exist_ok=True)
    out = USAGE / "history.jsonl"
    tmp = out.with_suffix(".tmp")
    with tmp.open("w") as fh:
        for (session, agent, model, _hour), (first, t, i, o, cr, cw, n) in sorted(sums.items(), key=lambda kv: kv[1][1]):
            line = {"t": t, "f": first, "s": session, "acct": "", "p": "claude", "m": model, "i": i, "o": o, "cr": cr, "cw": cw, "n": n}
            if agent:
                line["a"] = True
            fh.write(json.dumps(line, separators=(",", ":")) + "\n")
    os.chmod(tmp, 0o600)
    tmp.replace(out)
    print(f"scanned {scanned} transcripts, wrote {len(sums)} lines before {datetime.fromtimestamp(cutoff / 1000)} to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
