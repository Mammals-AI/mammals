#!/usr/bin/env python3
"""
Light Sleep — Short-term memory triage.

Runs every 4 hours. Reviews recent conversations (since last run),
identifies important memories, and boosts their salience for promotion.

Criteria for importance:
- Referenced multiple times in conversation
- Related to active goals/initiatives
- Contains decisions, commitments, or new information
- Mentioned by name (projects, people, tools)
"""

import json
import os
import re
import sqlite3
import subprocess
import sys
from datetime import datetime
from pathlib import Path

DB_PATH = Path.home() / "claudeclaw" / "store" / "claudeclaw.db"
LAST_RUN_KEY = "dream_light_last_run"


def db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def get_last_run():
    """Get timestamp of last light sleep run."""
    conn = db()
    try:
        row = conn.execute(
            "SELECT value FROM settings WHERE key = ?", (LAST_RUN_KEY,)
        ).fetchone()
        return int(row["value"]) if row else 0
    except Exception:
        # settings table might not exist
        try:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)"
            )
            conn.commit()
        except Exception:
            pass
        return 0
    finally:
        conn.close()


def set_last_run(ts):
    conn = db()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
            (LAST_RUN_KEY, str(ts)),
        )
        conn.commit()
    except Exception:
        pass
    finally:
        conn.close()


def get_recent_conversations(since_ms):
    """Get conversations since last run."""
    conn = db()
    try:
        rows = conn.execute(
            "SELECT role, content, source, created_at FROM conversations "
            "WHERE created_at > ? ORDER BY created_at",
            (since_ms,),
        ).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []
    finally:
        conn.close()


def get_active_goals():
    """Get active goals for context."""
    conn = db()
    try:
        rows = conn.execute(
            "SELECT title, description FROM goals WHERE status = 'active' ORDER BY priority LIMIT 10"
        ).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []
    finally:
        conn.close()


def get_recent_memories(limit=30):
    """Get recent semantic memories for dedup checking."""
    conn = db()
    try:
        rows = conn.execute(
            "SELECT id, content, salience FROM memories "
            "WHERE sector = 'semantic' ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []
    finally:
        conn.close()


def run_triage(conversations, goals, existing_memories):
    """Use Claude to triage recent conversations for important memories."""
    convo_text = ""
    for msg in conversations[-100:]:  # Last 100 messages max
        role = "Gino" if msg["role"] == "user" else "Mammals"
        text = msg["content"][:300]
        convo_text += f"{role}: {text}\n"

    if len(convo_text) < 50:
        return None

    goals_text = "\n".join(f"- {g['title']}" for g in goals) if goals else "None active"

    memory_text = "\n".join(f"- [id:{m['id']}] {m['content'][:150]}" for m in existing_memories)

    prompt = f"""You are Mammals's light sleep memory triage system. Review these recent conversations and identify memories worth flagging for long-term storage.

RECENT CONVERSATIONS:
{convo_text[:8000]}

ACTIVE GOALS:
{goals_text}

EXISTING MEMORIES (don't duplicate these):
{memory_text}

Flag memories that are:
1. Decisions or commitments Gino made
2. New facts about projects, tools, or preferences
3. Information referenced multiple times (important by repetition)
4. Things related to active goals
5. Changes in plans or priorities

Do NOT flag:
- Casual conversation, greetings
- Things already captured in existing memories
- Temporary states ("I'm tired", "working on X right now")

Respond in raw JSON only (no markdown):
{{
  "flagged": [
    {{
      "content": "durable fact or decision to remember",
      "topic_key": "short-tag",
      "importance": "high|medium",
      "reason": "why this matters"
    }}
  ],
  "boost_memory_ids": [123, 456],
  "session_notes": "1-2 sentence summary of this period"
}}

If nothing worth flagging, return {{"flagged": [], "boost_memory_ids": [], "session_notes": "quiet period"}}"""

    try:
        result = subprocess.run(
            ["claude", "-p", prompt, "--output-format", "json", "--model", "haiku"],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode != 0:
            return None

        text = result.stdout.strip()
        # Parse the JSON result from Claude's response
        parsed = json.loads(text)
        # Claude wraps in {"result": ...} with --output-format json
        if "result" in parsed:
            inner = parsed["result"]
            # Find JSON in the result text
            if isinstance(inner, str):
                start = inner.find("{")
                end = inner.rfind("}") + 1
                if start >= 0:
                    raw = inner[start:end]
                    # Fix invalid JSON escape sequences (e.g. \s, \d from regex)
                    raw = re.sub(r'\\(?!["\\/bfnrtu])', r'\\\\', raw)
                    return json.loads(raw)
            elif isinstance(inner, dict):
                return inner
        return parsed
    except Exception as e:
        print(f"  Triage error: {e}")
        return None


def apply_triage(triage_result):
    """Apply triage results: store flagged memories, boost existing ones."""
    if not triage_result:
        return

    conn = db()
    now_ms = int(datetime.now().timestamp() * 1000)
    flagged = triage_result.get("flagged", [])
    boosts = triage_result.get("boost_memory_ids", [])
    notes = triage_result.get("session_notes", "")

    try:
        # Store flagged items as new semantic memories with boosted salience
        for item in flagged:
            content = item.get("content", "")
            if not content:
                continue
            topic = item.get("topic_key", "general")
            importance = item.get("importance", "medium")
            salience = 2.0 if importance == "high" else 1.5

            # Check for near-duplicate
            existing = conn.execute(
                "SELECT id, salience FROM memories WHERE sector='semantic' AND content LIKE ?",
                (f"%{content[:50]}%",),
            ).fetchone()

            if existing:
                # Boost existing instead of duplicating
                conn.execute(
                    "UPDATE memories SET salience = MIN(salience + 0.3, 5.0), accessed_at = ? WHERE id = ?",
                    (now_ms, existing["id"]),
                )
                print(f"  Boosted existing memory {existing['id']}: +0.3")
            else:
                conn.execute(
                    "INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at) "
                    "VALUES (?, ?, ?, 'semantic', ?, ?, ?)",
                    ("dream-light", topic, content, salience, now_ms, now_ms),
                )
                print(f"  New memory: {content[:60]}...")

        # Boost referenced existing memories
        for mem_id in boosts:
            if isinstance(mem_id, int):
                conn.execute(
                    "UPDATE memories SET salience = MIN(salience + 0.2, 5.0), accessed_at = ? WHERE id = ?",
                    (now_ms, mem_id),
                )

        # Log to dream journal
        conn.execute(
            "INSERT INTO dream_journal (phase, content, source_memories, confidence, tags, created_at) "
            "VALUES ('light', ?, ?, 0.7, ?, ?)",
            (
                notes or f"Triaged {len(flagged)} items",
                json.dumps([f.get("content", "")[:80] for f in flagged]),
                json.dumps([f.get("topic_key", "") for f in flagged]),
                now_ms,
            ),
        )

        conn.commit()
        print(f"  Light sleep complete: {len(flagged)} flagged, {len(boosts)} boosted")
    except Exception as e:
        print(f"  Error applying triage: {e}")
    finally:
        conn.close()


def main():
    print("=== LIGHT SLEEP — Memory Triage ===")

    last_run = get_last_run()
    now_ms = int(datetime.now().timestamp() * 1000)

    # If never run, look at last 4 hours
    if last_run == 0:
        last_run = now_ms - (4 * 3600 * 1000)

    conversations = get_recent_conversations(last_run)
    if len(conversations) < 3:
        print("  Not enough recent conversations to triage. Skipping.")
        set_last_run(now_ms)
        return

    print(f"  Reviewing {len(conversations)} messages since last run")

    goals = get_active_goals()
    existing = get_recent_memories()

    triage = run_triage(conversations, goals, existing)
    apply_triage(triage)

    set_last_run(now_ms)


if __name__ == "__main__":
    main()
