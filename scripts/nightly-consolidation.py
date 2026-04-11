#!/usr/bin/env python3
"""
Nightly Consolidation for Mammals.
Reviews today's conversation sessions, extracts durable facts and decisions,
checks for contradictions with existing memories, and updates the daily note.

Designed to run as a scheduled task via Mammals's scheduler or cron.
"""

import json
import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

SESSIONS_DIR = Path.home() / ".claude" / "projects" / "MAMMALS_PROJECT_DIR"
DB_PATH = Path.home() / "claudeclaw" / "store" / "claudeclaw.db"
NOTES_DIR = Path.home() / "claudeclaw" / "daily-notes"


def get_todays_sessions():
    """Find all session JSONL files modified today."""
    today_start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    sessions = []

    for jsonl_file in SESSIONS_DIR.glob("*.jsonl"):
        mtime = datetime.fromtimestamp(jsonl_file.stat().st_mtime)
        if mtime >= today_start:
            sessions.append(jsonl_file)

    return sessions


def get_todays_conversations_from_db():
    """Get today's conversations from the SQLite conversations table (primary source)."""
    if not DB_PATH.exists():
        return []

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row

    today_start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    start_ms = int(today_start.timestamp() * 1000)

    try:
        rows = conn.execute(
            "SELECT role, content, source, created_at FROM conversations WHERE created_at >= ? ORDER BY created_at",
            (start_ms,),
        ).fetchall()

        conversations = []
        for r in rows:
            text = r["content"]
            if len(text) > 500:
                text = text[:500] + "..."
            conversations.append({"role": r["role"], "text": text})
        return conversations
    except Exception:
        return []
    finally:
        conn.close()


def extract_conversations(session_file):
    """Extract user/assistant message pairs from a session JSONL file."""
    conversations = []

    with open(session_file) as f:
        for line in f:
            try:
                entry = json.loads(line.strip())
            except json.JSONDecodeError:
                continue

            entry_type = entry.get("type")
            if entry_type not in ("user", "assistant"):
                continue

            msg = entry.get("message", {})
            if not isinstance(msg, dict):
                continue

            role = msg.get("role", entry_type)
            content = msg.get("content", "")

            # Extract text from content blocks
            text = ""
            if isinstance(content, str):
                text = content
            elif isinstance(content, list):
                parts = []
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        parts.append(block.get("text", ""))
                text = "\n".join(parts)

            if text.strip():
                # Truncate very long messages to keep context manageable
                if len(text) > 500:
                    text = text[:500] + "..."
                conversations.append({"role": role, "text": text})

    return conversations


def get_existing_memories():
    """Get all current semantic memories for contradiction checking."""
    if not DB_PATH.exists():
        return []
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(
            "SELECT id, content, sector, salience FROM memories WHERE sector = 'semantic' ORDER BY salience DESC LIMIT 50"
        ).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []
    finally:
        conn.close()


def build_consolidation_prompt(conversations, existing_memories):
    """Build the prompt for Claude to analyze today's conversations."""
    convo_text = ""
    for i, msg in enumerate(conversations):
        role_label = "User" if msg["role"] == "user" else "Mammals"
        convo_text += f"{role_label}: {msg['text']}\n\n"

    # Cap the conversation text
    if len(convo_text) > 15000:
        convo_text = convo_text[:15000] + "\n... (truncated)"

    memory_text = ""
    if existing_memories:
        memory_text = "EXISTING MEMORIES (check for contradictions):\n"
        for m in existing_memories:
            memory_text += f"- [id:{m['id']}] {m['content'][:200]}\n"

    prompt = f"""You are Mammals's nightly consolidation system. Analyze today's conversations and extract durable information.

TODAY'S CONVERSATIONS:
{convo_text}

{memory_text}

Respond in EXACTLY this JSON format (no markdown, no code blocks, just raw JSON):
{{
  "summary": "2-3 sentence summary of what happened today",
  "facts": [
    {{
      "content": "a durable fact worth remembering long-term",
      "topic_key": "short-topic-tag"
    }}
  ],
  "decisions": [
    "decision or action that was made"
  ],
  "contradictions": [
    {{
      "memory_id": 123,
      "old_content": "what the memory says",
      "new_info": "what today's conversation says instead"
    }}
  ],
  "follow_ups": [
    "thing to follow up on tomorrow"
  ]
}}

Rules:
- Only extract DURABLE facts — things worth remembering weeks from now
- Skip ephemeral stuff like "user said hi" or debugging back-and-forth
- For contradictions, only flag genuine conflicts with existing memories
- Keep facts concise — one clear statement each
- If nothing meaningful happened, return empty arrays
- topic_key should be short lowercase tags like "crypto", "setup", "project", "preference"
"""
    return prompt


def run_claude_analysis(prompt):
    """Run Claude CLI to analyze conversations."""
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

        # Parse the JSON output from claude CLI
        try:
            cli_output = json.loads(result.stdout)
            # claude --output-format json wraps result in a structure
            response_text = cli_output.get("result", result.stdout)
        except json.JSONDecodeError:
            response_text = result.stdout

        # Extract the JSON from the response
        # Strip any markdown code blocks if present
        text = response_text.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[1] if "\n" in text else text[3:]
            if text.endswith("```"):
                text = text[:-3]
            text = text.strip()

        return json.loads(text)
    except subprocess.TimeoutExpired:
        print("Claude analysis timed out")
        return None
    except json.JSONDecodeError as e:
        print(f"Failed to parse Claude response as JSON: {e}")
        print(f"Raw response: {response_text[:500] if 'response_text' in dir() else 'N/A'}")
        return None
    except Exception as e:
        print(f"Error running Claude analysis: {e}")
        return None


def store_facts(facts, chat_id="consolidation"):
    """Store extracted facts as semantic memories."""
    if not facts or not DB_PATH.exists():
        return 0

    conn = sqlite3.connect(str(DB_PATH))
    now = int(datetime.now().timestamp() * 1000)
    stored = 0

    for fact in facts:
        content = fact.get("content", "").strip()
        topic_key = fact.get("topic_key", "").strip() or None
        if not content:
            continue

        # Check for near-duplicates (simple substring check)
        existing = conn.execute(
            "SELECT id FROM memories WHERE content LIKE ? LIMIT 1",
            (f"%{content[:50]}%",),
        ).fetchone()

        if existing:
            # Boost salience of existing memory instead
            conn.execute(
                "UPDATE memories SET salience = MIN(salience + 0.2, 5.0), accessed_at = ? WHERE id = ?",
                (now, existing[0]),
            )
        else:
            conn.execute(
                "INSERT INTO memories (chat_id, topic_key, content, sector, salience, created_at, accessed_at) VALUES (?, ?, ?, 'semantic', 1.5, ?, ?)",
                (chat_id, topic_key, content, now, now),
            )
            stored += 1

    conn.commit()
    conn.close()
    return stored


def handle_contradictions(contradictions):
    """Handle contradictions by updating old memories."""
    if not contradictions or not DB_PATH.exists():
        return 0

    conn = sqlite3.connect(str(DB_PATH))
    handled = 0

    for c in contradictions:
        mem_id = c.get("memory_id")
        new_info = c.get("new_info", "").strip()
        if not mem_id or not new_info:
            continue

        # Lower salience of contradicted memory
        conn.execute(
            "UPDATE memories SET salience = salience * 0.5 WHERE id = ?",
            (mem_id,),
        )
        handled += 1

    conn.commit()
    conn.close()
    return handled


def update_daily_note(date, analysis):
    """Update today's daily note with consolidation results."""
    year_dir = NOTES_DIR / str(date.year) / f"{date.month:02d}"
    note_path = year_dir / f"{date.strftime('%Y-%m-%d')}.md"

    if not note_path.exists():
        # Create the note first
        subprocess.run(
            [sys.executable, str(Path(__file__).parent / "daily-note.py")],
            cwd=str(Path.home() / "claudeclaw"),
        )

    if not note_path.exists():
        print("Could not create daily note")
        return

    content = note_path.read_text()

    # Replace the Conversations section
    summary = analysis.get("summary", "No significant activity.")
    conversations_section = f"## Conversations\n\n{summary}"
    content = content.replace(
        "## Conversations\n\n_Auto-populated by nightly consolidation._",
        conversations_section,
    )

    # Replace the New Facts section
    facts = analysis.get("facts", [])
    if facts:
        facts_lines = "\n".join(f"- [{f.get('topic_key', '?')}] {f['content']}" for f in facts)
        facts_section = f"## New Facts Learned\n\n{facts_lines}"
    else:
        facts_section = "## New Facts Learned\n\n_No new durable facts extracted._"
    content = content.replace(
        "## New Facts Learned\n\n_Extracted during nightly consolidation._",
        facts_section,
    )

    # Add decisions if any
    decisions = analysis.get("decisions", [])
    if decisions:
        decisions_lines = "\n".join(f"- {d}" for d in decisions)
        content = content.replace(
            "## Decisions & Actions\n\n- ",
            f"## Decisions & Actions\n\n{decisions_lines}",
        )

    # Add follow-ups
    follow_ups = analysis.get("follow_ups", [])
    if follow_ups:
        follow_lines = "\n".join(f"- {f}" for f in follow_ups)
        content = content.replace(
            "## Open Questions / Follow-ups\n\n- ",
            f"## Open Questions / Follow-ups\n\n{follow_lines}",
        )

    note_path.write_text(content)
    print(f"Updated daily note: {note_path}")


def run_consolidation():
    """Main consolidation workflow."""
    today = datetime.now()
    print(f"\n=== Nightly Consolidation: {today.strftime('%Y-%m-%d %H:%M')} ===\n")

    # 1. Get conversations from DB (primary source — logs actual Telegram messages)
    all_conversations = get_todays_conversations_from_db()
    print(f"Found {len(all_conversations)} messages in conversations DB")

    # 2. Fallback to JSONL if DB is empty (for older sessions before logging was added)
    if not all_conversations:
        sessions = get_todays_sessions()
        print(f"DB empty, checking {len(sessions)} JSONL session files")
        for session_file in sessions:
            convos = extract_conversations(session_file)
            all_conversations.extend(convos)
            print(f"  {session_file.name}: {len(convos)} messages")

    if not all_conversations:
        print("No conversations to consolidate")
        update_daily_note(today, {
            "summary": "Quiet day — no conversations recorded.",
            "facts": [],
            "decisions": [],
            "contradictions": [],
            "follow_ups": [],
        })
        return

    print(f"Total messages to analyze: {len(all_conversations)}")

    if not all_conversations:
        print("No conversation content found")
        return

    # 3. Get existing memories for contradiction checking
    existing_memories = get_existing_memories()
    print(f"Existing semantic memories: {len(existing_memories)}")

    # 4. Run Claude analysis
    print("\nRunning Claude analysis...")
    prompt = build_consolidation_prompt(all_conversations, existing_memories)
    analysis = run_claude_analysis(prompt)

    if not analysis:
        print("Analysis failed — skipping DB updates")
        return

    print(f"\nAnalysis results:")
    print(f"  Summary: {analysis.get('summary', 'N/A')[:100]}")
    print(f"  Facts: {len(analysis.get('facts', []))}")
    print(f"  Decisions: {len(analysis.get('decisions', []))}")
    print(f"  Contradictions: {len(analysis.get('contradictions', []))}")
    print(f"  Follow-ups: {len(analysis.get('follow_ups', []))}")

    # 5. Store new facts
    stored = store_facts(analysis.get("facts", []))
    print(f"\nStored {stored} new facts in memory DB")

    # 6. Handle contradictions
    handled = handle_contradictions(analysis.get("contradictions", []))
    if handled:
        print(f"Handled {handled} contradictions (lowered salience)")

    # 7. Update daily note
    update_daily_note(today, analysis)

    print("\nConsolidation complete.")


if __name__ == "__main__":
    run_consolidation()
