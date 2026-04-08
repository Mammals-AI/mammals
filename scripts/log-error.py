#!/usr/bin/env python3
"""
Error Logger for Mammals.
Appends errors/mistakes to a JSONL log file.

Usage:
  python3 log-error.py "source" "what went wrong" "what should have happened"

Examples:
  python3 log-error.py "mink" "Published to WordPress instead of Astro" "Should publish to Astro/Cloudflare Pages"
  python3 log-error.py "main-bot" "Gave outdated info about site stack" "Should have checked current state first"
  python3 log-error.py "bull" "Tried to trade on Binance.US" "Should use Kraken as primary exchange"
"""

import json
import sys
from datetime import datetime
from pathlib import Path

LOG_PATH = Path.home() / "claudeclaw" / "store" / "error-log.jsonl"


def log_error(source: str, error: str, expected: str, context: str = ""):
    entry = {
        "timestamp": datetime.now().isoformat(),
        "date": datetime.now().strftime("%Y-%m-%d"),
        "source": source,
        "error": error,
        "expected": expected,
        "context": context,
        "reviewed": False,
    }

    with open(LOG_PATH, "a") as f:
        f.write(json.dumps(entry) + "\n")

    print(f"Logged error from {source}: {error}")
    return entry


if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("Usage: log-error.py <source> <error> <expected> [context]")
        sys.exit(1)

    source = sys.argv[1]
    error = sys.argv[2]
    expected = sys.argv[3]
    context = sys.argv[4] if len(sys.argv) > 4 else ""

    log_error(source, error, expected, context)
