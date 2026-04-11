#!/usr/bin/env python3
"""
Nightly Error Review for Mammals.
Reads unreviewed errors from the log, analyzes patterns,
and generates corrective actions — updating memory files and
agent prompts to prevent repeat mistakes.

Runs as part of the nightly pipeline.
"""

import json
import subprocess
import sys
from datetime import datetime
from pathlib import Path

LOG_PATH = Path.home() / "claudeclaw" / "store" / "error-log.jsonl"
MEMORY_DIR = Path.home() / ".claude" / "projects" / "MAMMALS_PROJECT_DIR" / "memory"
ARCHIVE_DIR = Path.home() / "claudeclaw" / "store" / "error-archive"


def load_unreviewed_errors():
    if not LOG_PATH.exists():
        return []

    errors = []
    with open(LOG_PATH) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                if not entry.get("reviewed", False):
                    errors.append(entry)
            except json.JSONDecodeError:
                continue
    return errors


def mark_all_reviewed():
    if not LOG_PATH.exists():
        return

    lines = []
    with open(LOG_PATH) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                entry["reviewed"] = True
                lines.append(json.dumps(entry))
            except json.JSONDecodeError:
                lines.append(line)

    with open(LOG_PATH, "w") as f:
        f.write("\n".join(lines) + "\n")


def archive_old_entries():
    """Move reviewed entries older than 7 days to archive."""
    if not LOG_PATH.exists():
        return

    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    today = datetime.now().strftime("%Y-%m-%d")

    keep = []
    archive = []

    with open(LOG_PATH) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
                entry_date = entry.get("date", today)
                days_old = (datetime.now() - datetime.strptime(entry_date, "%Y-%m-%d")).days
                if days_old > 7 and entry.get("reviewed", False):
                    archive.append(line)
                else:
                    keep.append(line)
            except (json.JSONDecodeError, ValueError):
                keep.append(line)

    if archive:
        archive_file = ARCHIVE_DIR / f"errors-archived-{today}.jsonl"
        with open(archive_file, "a") as f:
            f.write("\n".join(archive) + "\n")

        with open(LOG_PATH, "w") as f:
            f.write("\n".join(keep) + "\n" if keep else "")

        print(f"Archived {len(archive)} old entries")


def build_review_prompt(errors):
    error_text = ""
    for i, e in enumerate(errors, 1):
        error_text += f"\n--- Error {i} ---\n"
        error_text += f"Date: {e.get('date', 'unknown')}\n"
        error_text += f"Source: {e.get('source', 'unknown')}\n"
        error_text += f"What went wrong: {e.get('error', 'unknown')}\n"
        error_text += f"What should have happened: {e.get('expected', 'unknown')}\n"
        if e.get("context"):
            error_text += f"Context: {e['context']}\n"

    return f"""You are Mammals's error review system. Today is {datetime.now().strftime('%Y-%m-%d')}.

Review these {len(errors)} errors/mistakes from today and generate corrective actions.

ERRORS:
{error_text}

For each error, determine:
1. Is this a one-off or a pattern (has it happened before)?
2. What's the root cause?
3. What specific change would prevent this from happening again?

Respond in EXACTLY this JSON format (no markdown, no code blocks):
{{
  "summary": "1-2 sentence overview of today's mistakes",
  "corrections": [
    {{
      "source": "which agent or system",
      "pattern": "brief description of the mistake pattern",
      "fix_type": "memory_update | agent_prompt | script_fix | manual",
      "fix_description": "exactly what to update and how",
      "priority": "high | medium | low"
    }}
  ],
  "lessons_learned": "1-2 sentences on what to internalize going forward"
}}

Focus on actionable fixes. If an error is trivial or one-off with no systemic fix, still list it but mark priority as low."""


def apply_corrections(review):
    """Apply automatic corrections where possible."""
    corrections = review.get("corrections", [])
    applied = []

    for c in corrections:
        fix_type = c.get("fix_type", "")
        source = c.get("source", "unknown")
        pattern = c.get("pattern", "")
        fix_desc = c.get("fix_description", "")

        if fix_type == "memory_update":
            # Save a feedback memory with the correction
            safe_name = source.replace(" ", "-").replace("/", "-").lower()
            memory_file = MEMORY_DIR / f"feedback_error-fix-{safe_name}-{datetime.now().strftime('%Y%m%d')}.md"

            content = f"""---
name: Error fix - {pattern[:50]}
description: Correction from nightly error review on {datetime.now().strftime('%Y-%m-%d')} for {source}
type: feedback
---

{fix_desc}

**Why:** This mistake was logged on {datetime.now().strftime('%Y-%m-%d')} from {source}.
**How to apply:** {pattern} — follow the fix description above to avoid repeating this.
"""
            memory_file.write_text(content)
            applied.append(f"Saved memory fix: {memory_file.name}")
            print(f"  Applied memory update: {memory_file.name}")

        elif fix_type == "agent_prompt":
            # Flag for manual update — agent prompts need careful editing
            applied.append(f"NEEDS MANUAL: Update {source} agent prompt — {fix_desc[:100]}")
            print(f"  Flagged for manual: {source} agent prompt update")

        elif fix_type == "script_fix":
            applied.append(f"NEEDS MANUAL: Script fix for {source} — {fix_desc[:100]}")
            print(f"  Flagged for manual: script fix for {source}")

        else:
            applied.append(f"NOTED: {pattern[:80]}")

    return applied


def run_claude_analysis(prompt):
    try:
        result = subprocess.run(
            ["claude", "-p", prompt, "--output-format", "json"],
            capture_output=True,
            text=True,
            timeout=120,
            cwd=str(Path.home() / "claudeclaw"),
        )
        if result.returncode != 0:
            print(f"Claude CLI error: {result.stderr[:500]}")
            return None

        try:
            cli_output = json.loads(result.stdout)
            response_text = cli_output.get("result", result.stdout)
        except json.JSONDecodeError:
            response_text = result.stdout

        text = response_text.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[1] if "\n" in text else text[3:]
            if text.endswith("```"):
                text = text[:-3]
            text = text.strip()

        return json.loads(text)
    except subprocess.TimeoutExpired:
        print("Error review timed out")
        return None
    except json.JSONDecodeError as e:
        print(f"Failed to parse review JSON: {e}")
        return None
    except Exception as e:
        print(f"Error running review: {e}")
        return None


def format_telegram_message(review, applied):
    summary = review.get("summary", "No errors to review.")
    lessons = review.get("lessons_learned", "")
    corrections = review.get("corrections", [])

    high_priority = [c for c in corrections if c.get("priority") == "high"]
    manual_needed = [a for a in applied if a.startswith("NEEDS MANUAL")]

    msg = f"📋 Error Review\n\n{summary}\n"

    if high_priority:
        msg += "\n⚠️ High priority fixes:\n"
        for c in high_priority:
            msg += f"  • [{c['source']}] {c['pattern'][:60]}\n"

    if manual_needed:
        msg += "\n🔧 Needs your attention:\n"
        for m in manual_needed:
            msg += f"  • {m.replace('NEEDS MANUAL: ', '')[:80]}\n"

    auto_applied = [a for a in applied if a.startswith("Saved")]
    if auto_applied:
        msg += f"\n✅ Auto-applied {len(auto_applied)} memory fix(es)"

    if lessons:
        msg += f"\n\n💡 {lessons}"

    return msg


def run_error_review():
    print(f"\n=== Error Review: {datetime.now().strftime('%Y-%m-%d %H:%M')} ===\n")

    errors = load_unreviewed_errors()
    print(f"Unreviewed errors: {len(errors)}")

    if not errors:
        print("No errors to review. Clean day!")
        return "No errors logged today. Clean day! ✨"

    prompt = build_review_prompt(errors)
    print("Running Claude analysis...")

    review = run_claude_analysis(prompt)
    if not review:
        print("Analysis failed")
        return None

    print(f"\nReview: {review.get('summary', 'N/A')}")
    print(f"Corrections: {len(review.get('corrections', []))}")

    # Apply what we can automatically
    applied = apply_corrections(review)

    # Mark all errors as reviewed
    mark_all_reviewed()

    # Archive old entries
    archive_old_entries()

    msg = format_telegram_message(review, applied)
    print(f"\n{msg}")
    return msg


if __name__ == "__main__":
    result = run_error_review()
    if result:
        print("\n--- Output for scheduler ---")
        print(result)
