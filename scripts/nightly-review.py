#!/usr/bin/env python3
"""
Nightly Review Agent for Mammals.
Runs after consolidation. Generates an end-of-day summary,
identifies tomorrow's priorities, and updates the daily note.

Can also send results to Telegram via the bot.
"""

import json
import os
import socket
import sqlite3
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path
from urllib.request import urlopen
from urllib.error import URLError

DB_PATH = Path.home() / "claudeclaw" / "store" / "claudeclaw.db"
NOTES_DIR = Path.home() / "claudeclaw" / "daily-notes"


def check_service(url, timeout=4):
    try:
        urlopen(url, timeout=timeout)
        return True
    except Exception:
        return False


def check_host(host, port, timeout=4):
    try:
        s = socket.create_connection((host, port), timeout=timeout)
        s.close()
        return True
    except Exception:
        return False


def get_live_system_status():
    """Actually check services in real time."""
    checks = {
        "Monitor dashboard (5065)": check_service("http://localhost:5065"),
        "Solar dashboard (5050)": check_service("http://localhost:5050"),
        "Crypto bot (5051)": check_service("http://localhost:5051"),
        "x402 service (4021)": check_service("http://localhost:4021"),
        "Solar Assistant (192.168.1.252)": check_host("192.168.1.252", 80),
        "Chrome bridge (9222)": check_host("localhost", 9222),
    }
    lines = []
    for name, up in checks.items():
        lines.append(f"  {name}: {'UP' if up else 'DOWN'}")
    return "\n".join(lines)


def get_today_note():
    """Read today's daily note."""
    today = datetime.now()
    note_path = NOTES_DIR / str(today.year) / f"{today.month:02d}" / f"{today.strftime('%Y-%m-%d')}.md"
    if note_path.exists():
        return note_path.read_text()
    return None


def get_pending_follow_ups():
    """Check recent daily notes for unresolved follow-ups."""
    follow_ups = []
    today = datetime.now()

    for days_ago in range(1, 4):  # Check last 3 days
        d = today - timedelta(days=days_ago)
        note_path = NOTES_DIR / str(d.year) / f"{d.month:02d}" / f"{d.strftime('%Y-%m-%d')}.md"
        if not note_path.exists():
            continue

        content = note_path.read_text()
        in_followups = False
        for line in content.split("\n"):
            if "## Open Questions / Follow-ups" in line:
                in_followups = True
                continue
            if line.startswith("## ") and in_followups:
                break
            if in_followups and line.strip().startswith("- ") and len(line.strip()) > 2:
                follow_ups.append(f"[{d.strftime('%m/%d')}] {line.strip()[2:]}")

    return follow_ups


def get_active_tasks():
    """Get active scheduled tasks."""
    if not DB_PATH.exists():
        return []
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    try:
        return [
            dict(r)
            for r in conn.execute(
                "SELECT id, prompt, schedule, last_result FROM scheduled_tasks WHERE status = 'active'"
            ).fetchall()
        ]
    except Exception:
        return []
    finally:
        conn.close()


def get_conversation_count():
    """Count today's human messages from the conversations table."""
    if not DB_PATH.exists():
        return 0
    conn = sqlite3.connect(str(DB_PATH))
    today_start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    start_ms = int(today_start.timestamp() * 1000)
    try:
        row = conn.execute(
            "SELECT COUNT(*) FROM conversations WHERE role = 'user' AND created_at >= ?",
            (start_ms,),
        ).fetchone()
        return row[0] if row else 0
    except Exception:
        return 0
    finally:
        conn.close()


def get_agent_status():
    """Get named agents and their last activity."""
    if not DB_PATH.exists():
        return []
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    try:
        return [
            dict(r)
            for r in conn.execute(
                "SELECT name, description FROM agents ORDER BY created_at"
            ).fetchall()
        ]
    except Exception:
        return []
    finally:
        conn.close()


def get_skill_usage_summary():
    """Get today's skill usage and any deviations for self-improvement tracking."""
    if not DB_PATH.exists():
        return None
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    try:
        today_start = int(datetime.now().replace(hour=0, minute=0, second=0).timestamp())
        usage = [dict(r) for r in conn.execute(
            "SELECT skill_name, success, steps_taken, deviation_notes, auto_updated "
            "FROM skill_usage_log WHERE used_at >= ? ORDER BY used_at",
            (today_start,)
        ).fetchall()]
        if not usage:
            return None
        lines = [f"SKILL USAGE TODAY ({len(usage)} uses):"]
        for u in usage:
            status = "OK" if u.get("success") else "FAIL"
            dev = f" — DEVIATED: {u['deviation_notes']}" if u.get("deviation_notes") else ""
            updated = " [auto-updated]" if u.get("auto_updated") else ""
            lines.append(f"  [{status}] {u['skill_name']}{dev}{updated}")
        return "\n".join(lines)
    except Exception:
        return None
    finally:
        conn.close()


def get_knowledge_gap_candidates():
    """Scan today's conversations for potential knowledge gaps (basic questions, confusion signals)."""
    if not DB_PATH.exists():
        return None
    conn = sqlite3.connect(str(DB_PATH))
    try:
        today_start = int(datetime.now().replace(hour=0, minute=0, second=0).timestamp() * 1000)
        rows = conn.execute(
            "SELECT content FROM conversations WHERE role = 'user' AND created_at >= ? "
            "AND (content LIKE '%what is%' OR content LIKE '%how do%' OR content LIKE '%what does%' "
            "OR content LIKE '%explain%' OR content LIKE '%i dont understand%' "
            "OR content LIKE '%confused%' OR content LIKE '%what are%')",
            (today_start,)
        ).fetchall()
        if not rows:
            return None
        return [r[0][:120] for r in rows[:10]]  # Cap at 10, truncate
    except Exception:
        return None
    finally:
        conn.close()


def get_initiative_summary():
    """Get goals, initiatives, and recent outcomes for the nightly review."""
    if not DB_PATH.exists():
        return None
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    try:
        goals = [dict(r) for r in conn.execute(
            "SELECT id, title, priority FROM goals WHERE status = 'active' ORDER BY priority"
        ).fetchall()]

        initiatives = [dict(r) for r in conn.execute(
            "SELECT i.id, i.title, i.status, g.title as goal_title "
            "FROM initiatives i LEFT JOIN goals g ON i.goal_id = g.id "
            "WHERE i.status IN ('pending', 'in_progress') ORDER BY i.priority"
        ).fetchall()]

        # Today's outcomes
        today_start = int(datetime.now().replace(hour=0, minute=0, second=0).timestamp())
        outcomes = [dict(r) for r in conn.execute(
            "SELECT action_type, agent_name, result_summary, success, "
            "i.title as initiative_title "
            "FROM initiative_outcomes o "
            "LEFT JOIN initiatives i ON o.initiative_id = i.id "
            "WHERE o.created_at >= ? ORDER BY o.created_at DESC",
            (today_start,)
        ).fetchall()]

        if not goals and not initiatives and not outcomes:
            return None

        lines = []
        if goals:
            lines.append("GOALS:")
            for g in goals:
                lines.append(f"  P{g['priority']} {g['title']}")
        if initiatives:
            lines.append("ACTIVE INITIATIVES:")
            for i in initiatives:
                goal_ref = f" → {i.get('goal_title', '?')}" if i.get('goal_title') else ""
                lines.append(f"  [{i['status']}] {i['title']}{goal_ref}")
        if outcomes:
            lines.append(f"TODAY'S INITIATIVE OUTCOMES ({len(outcomes)}):")
            for o in outcomes:
                status = "OK" if o.get("success") else "FAIL"
                agent = f" via {o['agent_name']}" if o.get("agent_name") else ""
                lines.append(f"  [{status}] {o.get('initiative_title', '?')}{agent}: {(o.get('result_summary') or '')[:80]}")

        return "\n".join(lines)
    except Exception:
        return None
    finally:
        conn.close()


def build_review_prompt(today_note, follow_ups, tasks, agents, system_status=None, convo_count=0):
    """Build the prompt for the nightly review."""
    today = datetime.now()
    tomorrow = today + timedelta(days=1)

    context_parts = []

    context_parts.append(f"HUMAN INTERACTIONS TODAY: {convo_count} messages from Gino via Telegram")

    # Add initiative/outcome data
    init_summary = get_initiative_summary()
    if init_summary:
        context_parts.append(f"INITIATIVE ENGINE ACTIVITY:\n{init_summary}")

    # Add skill usage data
    skill_summary = get_skill_usage_summary()
    if skill_summary:
        context_parts.append(skill_summary)

    # Add knowledge gap candidates
    gap_candidates = get_knowledge_gap_candidates()
    if gap_candidates:
        context_parts.append("POTENTIAL KNOWLEDGE GAP SIGNALS (questions/confusion from Gino today):\n" +
                           "\n".join(f"  - {q}" for q in gap_candidates))

    if today_note:
        context_parts.append(f"TODAY'S DAILY NOTE:\n{today_note}")

    if follow_ups:
        context_parts.append("UNRESOLVED FOLLOW-UPS FROM RECENT DAYS:\n" + "\n".join(f"  {f}" for f in follow_ups))

    if tasks:
        task_lines = []
        for t in tasks:
            last = t.get("last_result", "")
            last_preview = f" — last: {last[:80]}" if last else ""
            task_lines.append(f"  - {t['prompt'][:80]} ({t['schedule']}){last_preview}")
        context_parts.append("ACTIVE SCHEDULED TASKS:\n" + "\n".join(task_lines))

    if agents:
        agent_lines = [f"  - {a['name']}: {a.get('description', 'no description')}" for a in agents]
        context_parts.append("NAMED AGENTS:\n" + "\n".join(agent_lines))

    if system_status:
        context_parts.append(f"LIVE SYSTEM STATUS (checked right now):\n{system_status}")

    context = "\n\n".join(context_parts)

    return f"""You are Mammals's nightly review system. Today is {today.strftime('%A, %B %d, %Y')}.
Tomorrow is {tomorrow.strftime('%A, %B %d')}.

Review the day and generate a brief nightly report.

{context}

Respond in EXACTLY this JSON format (no markdown, no code blocks):
{{
  "eod_summary": "3-5 sentence end-of-day summary. What got done, what's in progress, overall vibe.",
  "tomorrow_priorities": [
    "Priority task or follow-up for tomorrow"
  ],
  "agent_notes": "Any observations about agent performance or suggestions (or null if nothing notable)",
  "system_health": "Brief note on system health based on task results (or 'All good' if nothing notable)",
  "skill_notes": "Any skill files that need updating based on today's usage, or new skills worth documenting (or null)",
  "knowledge_gaps_detected": ["Short description of any new knowledge gaps noticed in Gino's questions today (or empty array)"]
}}

Keep it casual and useful — this is for Gino, not a corporate report.
"""


def run_claude_review(prompt):
    """Run Claude CLI for the review."""
    try:
        result = subprocess.run(
            ["claude", "-p", prompt, "--output-format", "json"],
            capture_output=True,
            text=True,
            timeout=90,
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
        print("Review timed out")
        return None
    except json.JSONDecodeError as e:
        print(f"Failed to parse review JSON: {e}")
        return None
    except Exception as e:
        print(f"Error running review: {e}")
        return None


def update_daily_note_summary(review):
    """Write the end-of-day summary into today's note."""
    today = datetime.now()
    note_path = NOTES_DIR / str(today.year) / f"{today.month:02d}" / f"{today.strftime('%Y-%m-%d')}.md"

    if not note_path.exists():
        return

    content = note_path.read_text()

    summary = review.get("eod_summary", "Review completed but no summary generated.")
    priorities = review.get("tomorrow_priorities", [])

    eod_section = f"## End of Day Summary\n\n{summary}"
    if priorities:
        eod_section += "\n\n**Tomorrow's Priorities:**\n"
        eod_section += "\n".join(f"- {p}" for p in priorities)

    agent_notes = review.get("agent_notes")
    if agent_notes:
        eod_section += f"\n\n**Agent Notes:** {agent_notes}"

    health = review.get("system_health", "All good")
    eod_section += f"\n\n**System Health:** {health}"

    skill_notes = review.get("skill_notes")
    if skill_notes:
        eod_section += f"\n\n**Skill Notes:** {skill_notes}"

    gaps = review.get("knowledge_gaps_detected", [])
    if gaps:
        eod_section += "\n\n**Knowledge Gaps Detected:**\n"
        eod_section += "\n".join(f"- {g}" for g in gaps)

    content = content.replace(
        "## End of Day Summary\n\n_Filled in by nightly review agent._",
        eod_section,
    )

    note_path.write_text(content)
    print(f"Updated daily note with EOD summary: {note_path}")


def format_telegram_message(review):
    """Format the review as a Telegram-friendly message."""
    summary = review.get("eod_summary", "Nothing notable.")
    priorities = review.get("tomorrow_priorities", [])
    health = review.get("system_health", "All good")

    msg = f"🌙 Nightly Review\n\n{summary}\n"

    if priorities:
        msg += "\n📋 Tomorrow:\n"
        for p in priorities:
            msg += f"  • {p}\n"

    msg += f"\n🔧 System: {health}"

    return msg


def run_review():
    """Main review workflow."""
    today = datetime.now()
    print(f"\n=== Nightly Review: {today.strftime('%Y-%m-%d %H:%M')} ===\n")

    today_note = get_today_note()
    follow_ups = get_pending_follow_ups()
    tasks = get_active_tasks()
    agents = get_agent_status()
    system_status = get_live_system_status()
    convo_count = get_conversation_count()

    print(f"Today's note: {'found' if today_note else 'not found'}")
    print(f"Human messages today: {convo_count}")
    print(f"Pending follow-ups: {len(follow_ups)}")
    print(f"Active tasks: {len(tasks)}")
    print(f"Named agents: {len(agents)}")
    print(f"Live system status:\n{system_status}")

    prompt = build_review_prompt(today_note, follow_ups, tasks, agents, system_status, convo_count)

    print("\nRunning Claude review...")
    review = run_claude_review(prompt)

    if not review:
        print("Review failed")
        return None

    print(f"\nReview results:")
    print(f"  Summary: {review.get('eod_summary', 'N/A')[:100]}")
    print(f"  Priorities: {len(review.get('tomorrow_priorities', []))}")
    print(f"  System: {review.get('system_health', 'N/A')}")

    # Update daily note
    update_daily_note_summary(review)

    # Generate tomorrow's daily note
    tomorrow = today + timedelta(days=1)
    subprocess.run(
        [sys.executable, str(Path(__file__).parent / "daily-note.py")],
        cwd=str(Path.home() / "claudeclaw"),
    )

    # Return Telegram-formatted message
    telegram_msg = format_telegram_message(review)
    print(f"\nTelegram message:\n{telegram_msg}")

    return telegram_msg


if __name__ == "__main__":
    result = run_review()
    if result:
        print("\n--- Output for scheduler ---")
        print(result)
