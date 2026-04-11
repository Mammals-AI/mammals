#!/usr/bin/env python3
"""
Conversation Logger for Mammals.
Runs periodically (e.g. every 2 hours) to append conversation summaries
to today's daily note. Keeps a checkpoint so it only processes new messages.

This gives the nightly review accurate context about what was discussed and done.
"""

import json
import os
import sqlite3
import subprocess
import sys
from datetime import datetime
from pathlib import Path

SESSIONS_DIR = Path.home() / ".claude" / "projects" / "MAMMALS_PROJECT_DIR"
DB_PATH = Path.home() / "claudeclaw" / "store" / "claudeclaw.db"
NOTES_DIR = Path.home() / "claudeclaw" / "daily-notes"
CHECKPOINT_PATH = Path.home() / "claudeclaw" / "store" / "convo-checkpoint.json"

# Minimum messages to bother summarizing
MIN_MESSAGES = 3


def load_checkpoint():
    """Load the last-processed position per session file."""
    if CHECKPOINT_PATH.exists():
        try:
            return json.loads(CHECKPOINT_PATH.read_text())
        except Exception:
            pass
    return {}


def save_checkpoint(checkpoint):
    """Save checkpoint data."""
    CHECKPOINT_PATH.write_text(json.dumps(checkpoint, indent=2))


def get_telegram_sessions():
    """Get session IDs for Telegram chats from Mammals DB."""
    if not DB_PATH.exists():
        return []
    conn = sqlite3.connect(str(DB_PATH))
    try:
        rows = conn.execute(
            "SELECT chat_id, session_id FROM sessions ORDER BY updated_at DESC"
        ).fetchall()
        return [(str(r[0]), str(r[1])) for r in rows]
    except Exception:
        return []
    finally:
        conn.close()


def extract_new_messages(session_file, last_line_count):
    """Extract messages from a JSONL file starting after last_line_count lines."""
    messages = []
    line_count = 0

    try:
        with open(session_file) as f:
            for line in f:
                line_count += 1
                if line_count <= last_line_count:
                    continue

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

                text = ""
                if isinstance(content, str):
                    text = content
                elif isinstance(content, list):
                    parts = []
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "text":
                            parts.append(block.get("text", ""))
                    text = "\n".join(parts)

                # Skip tool-heavy messages with minimal text
                text = text.strip()
                if len(text) < 10:
                    continue

                # Truncate long messages
                if len(text) > 400:
                    text = text[:400] + "..."

                messages.append({"role": role, "text": text})

    except Exception as e:
        print(f"Error reading {session_file}: {e}")

    return messages, line_count


def summarize_conversation(messages, session_label):
    """Use Claude to generate a brief summary of the conversation chunk."""
    convo_text = ""
    for msg in messages:
        label = "User" if msg["role"] == "user" else "Mammals"
        convo_text += f"{label}: {msg['text']}\n\n"

    if len(convo_text) > 12000:
        convo_text = convo_text[:12000] + "\n... (truncated)"

    now = datetime.now()
    prompt = f"""You are Mammals's conversation logger. Summarize this Telegram conversation chunk for the daily note.

Time: {now.strftime('%H:%M on %B %d, %Y')}
Session: {session_label}

CONVERSATION:
{convo_text}

Write a SHORT summary (3-6 bullet points max) of:
- What topics were discussed
- What decisions were made
- What actions were taken (code written, commands run, orders placed, etc.)
- Any key outcomes or results

Format as plain bullet points starting with "- ". No intro sentence, no headers. Just the bullets.
Focus on WHAT HAPPENED, not the back-and-forth. Skip debugging noise.
Be specific — include numbers, names, coin pairs, amounts where relevant."""

    try:
        result = subprocess.run(
            ["claude", "-p", prompt],
            capture_output=True,
            text=True,
            timeout=60,
            cwd=str(Path.home() / "claudeclaw"),
        )
        if result.returncode == 0 and result.stdout.strip():
            return result.stdout.strip()
    except Exception as e:
        print(f"Summary error: {e}")

    # Fallback: just count messages
    user_msgs = sum(1 for m in messages if m["role"] == "user")
    return f"- {user_msgs} Telegram messages exchanged (summary generation failed)"


def update_daily_note(summary_block):
    """Append a conversation log entry to today's daily note."""
    today = datetime.now()
    note_path = NOTES_DIR / str(today.year) / f"{today.month:02d}" / f"{today.strftime('%Y-%m-%d')}.md"

    if not note_path.exists():
        # Try to create it
        try:
            subprocess.run(
                [sys.executable, str(Path(__file__).parent / "daily-note.py")],
                cwd=str(Path.home() / "claudeclaw"),
                timeout=30,
            )
        except Exception:
            pass

    if not note_path.exists():
        print("Daily note not found, skipping update")
        return False

    content = note_path.read_text()
    timestamp = today.strftime("%H:%M")

    # Build the new entry
    new_entry = f"\n**{timestamp}** — Telegram session:\n{summary_block}\n"

    # Insert after the Conversations header
    conversations_marker = "## Conversations"
    if conversations_marker in content:
        # Find the end of the placeholder or existing entries
        idx = content.index(conversations_marker) + len(conversations_marker)
        # Skip the placeholder line if present
        placeholder = "\n\n_Auto-populated by nightly consolidation._"
        if content[idx:idx + len(placeholder)] == placeholder:
            content = content[:idx] + new_entry + content[idx + len(placeholder):]
        else:
            # Just append after the header
            content = content[:idx] + new_entry + content[idx:]

        note_path.write_text(content)
        print(f"Updated daily note with conversation log at {timestamp}")
        return True
    else:
        print("Conversations section not found in daily note")
        return False


def run():
    """Main logging workflow."""
    now = datetime.now()
    today_start_ts = int(now.replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)

    print(f"\n=== Conversation Logger: {now.strftime('%Y-%m-%d %H:%M')} ===\n")

    checkpoint = load_checkpoint()
    telegram_sessions = get_telegram_sessions()

    if not telegram_sessions:
        print("No Telegram sessions found")
        return

    all_new_messages = []
    new_checkpoint = dict(checkpoint)

    for chat_id, session_id in telegram_sessions:
        session_file = SESSIONS_DIR / f"{session_id}.jsonl"
        if not session_file.exists():
            continue

        # Only process files modified today
        mtime = session_file.stat().st_mtime * 1000
        if mtime < today_start_ts:
            continue

        last_line = checkpoint.get(session_id, 0)
        messages, total_lines = extract_new_messages(session_file, last_line)

        print(f"  Session {session_id[:8]}... (chat {chat_id}): {len(messages)} new messages")
        all_new_messages.extend(messages)
        new_checkpoint[session_id] = total_lines

    if len(all_new_messages) < MIN_MESSAGES:
        print(f"Not enough new messages ({len(all_new_messages)}) — skipping summary")
        save_checkpoint(new_checkpoint)
        return

    print(f"\nTotal new messages: {len(all_new_messages)}")
    print("Generating summary...")

    summary = summarize_conversation(all_new_messages, f"Telegram ({len(all_new_messages)} messages)")

    print(f"\nSummary:\n{summary}\n")

    updated = update_daily_note(summary)
    if updated:
        save_checkpoint(new_checkpoint)
        print("Checkpoint updated.")
    else:
        print("Note update failed — checkpoint NOT saved (will retry next run)")


if __name__ == "__main__":
    run()
