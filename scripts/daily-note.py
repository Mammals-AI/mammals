#!/usr/bin/env python3
"""
Daily Note Generator for Mammals.
Creates a structured daily markdown note for tracking conversations,
decisions, and tasks. Run at start of day or on-demand.
"""

import os
import sqlite3
from datetime import datetime
from pathlib import Path

NOTES_DIR = Path.home() / "claudeclaw" / "daily-notes"
DB_PATH = Path.home() / "claudeclaw" / "store" / "claudeclaw.db"


def get_active_tasks():
    """Pull active scheduled tasks from the DB."""
    if not DB_PATH.exists():
        return []
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT id, prompt, schedule FROM scheduled_tasks WHERE status = 'active'"
        ).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []
    finally:
        conn.close()


def get_recent_memories(limit=5):
    """Pull most recent memories for context."""
    if not DB_PATH.exists():
        return []
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT content, sector, salience FROM memories ORDER BY accessed_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []
    finally:
        conn.close()


def get_agents():
    """Pull named agents from the DB."""
    if not DB_PATH.exists():
        return []
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT name, description FROM agents ORDER BY created_at"
        ).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []
    finally:
        conn.close()


def create_daily_note(date=None):
    """Create a daily note for the given date (defaults to today)."""
    if date is None:
        date = datetime.now()

    # Build path: daily-notes/2026/03/2026-03-11.md
    year_dir = NOTES_DIR / str(date.year) / f"{date.month:02d}"
    year_dir.mkdir(parents=True, exist_ok=True)

    note_path = year_dir / f"{date.strftime('%Y-%m-%d')}.md"

    if note_path.exists():
        print(f"Daily note already exists: {note_path}")
        return str(note_path)

    # Gather context
    tasks = get_active_tasks()
    memories = get_recent_memories()
    agents = get_agents()

    day_name = date.strftime("%A")
    date_str = date.strftime("%B %d, %Y")

    # Build the note
    lines = [
        f"# {day_name}, {date_str}",
        "",
        "---",
        "",
        "## Morning Context",
        "",
    ]

    # Active tasks
    if tasks:
        lines.append("**Active Scheduled Tasks:**")
        for t in tasks:
            lines.append(f"- `{t['id']}`: {t['prompt'][:80]} ({t['schedule']})")
        lines.append("")

    # Named agents
    if agents:
        lines.append("**Active Agents:**")
        for a in agents:
            desc = f" — {a['description']}" if a["description"] else ""
            lines.append(f"- `{a['name']}`{desc}")
        lines.append("")

    # Recent memory context
    if memories:
        lines.append("**Recent Memory (top 5):**")
        for m in memories:
            sector_tag = f"[{m['sector']}]"
            content_preview = m["content"][:100].replace("\n", " ")
            lines.append(f"- {sector_tag} {content_preview}")
        lines.append("")

    lines.extend([
        "---",
        "",
        "## Conversations",
        "",
        "_Auto-populated by nightly consolidation._",
        "",
        "---",
        "",
        "## Decisions & Actions",
        "",
        "- ",
        "",
        "---",
        "",
        "## New Facts Learned",
        "",
        "_Extracted during nightly consolidation._",
        "",
        "---",
        "",
        "## Tasks Completed",
        "",
        "- ",
        "",
        "---",
        "",
        "## Open Questions / Follow-ups",
        "",
        "- ",
        "",
        "---",
        "",
        "## End of Day Summary",
        "",
        "_Filled in by nightly review agent._",
        "",
    ])

    note_path.write_text("\n".join(lines))
    print(f"Created daily note: {note_path}")
    return str(note_path)


if __name__ == "__main__":
    path = create_daily_note()
    print(f"Done: {path}")
