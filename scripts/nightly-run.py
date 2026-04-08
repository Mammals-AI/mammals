#!/usr/bin/env python3
"""
Nightly Run — Orchestrates the full nightly pipeline:
1. Generate tomorrow's daily note
2. Run consolidation (extract facts from today's conversations)
3. Run review (summarize day, plan tomorrow)

Called by the Mammals scheduler at 10 PM.
"""

import subprocess
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).parent


def run_script(name):
    """Run a script and return its output."""
    script = SCRIPTS_DIR / name
    print(f"\n{'='*40}")
    print(f"Running: {name}")
    print(f"{'='*40}")

    result = subprocess.run(
        [sys.executable, str(script)],
        capture_output=True,
        text=True,
        timeout=180,
        cwd=str(Path.home() / "claudeclaw"),
    )

    if result.stdout:
        print(result.stdout)
    if result.stderr:
        print(f"STDERR: {result.stderr[:500]}")

    return result.returncode == 0


def main():
    print("🌙 Starting nightly pipeline...")

    # Step 1: Daily note for tomorrow
    run_script("daily-note.py")

    # Step 2: Tacit knowledge analysis (learn from behavior)
    run_script("tacit-knowledge.py")

    # Step 3: Consolidation (extract facts from conversations)
    consolidation_ok = run_script("nightly-consolidation.py")

    # Step 4: Review (depends on consolidation having run)
    if consolidation_ok:
        run_script("nightly-review.py")
    else:
        print("\nSkipping review — consolidation failed")

    # Step 5: Error review (analyze mistakes, apply fixes)
    run_script("error-review.py")

    # Step 6: Recommendation compiler (review agent suggestions, auto-implement trivial)
    run_script("recommendation-compiler.py")

    # Step 7: Heartbeat check (system health snapshot)
    run_script("heartbeat.py")

    # === DREAMING CYCLE ===
    # Step 8: Light sleep — triage recent conversations for important memories
    run_script("dream-light.py")

    # Step 9: Deep sleep — reconcile and promote memories
    run_script("dream-deep.py")

    # Step 10: REM — synthesize cross-cutting insights from all memory sources
    run_script("dream-rem.py")

    print("\n✅ Nightly pipeline complete")


if __name__ == "__main__":
    main()
