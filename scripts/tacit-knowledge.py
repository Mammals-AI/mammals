#!/usr/bin/env python3
"""
Tacit Knowledge Tracker for Mammals.

Analyzes conversation patterns to learn Gino's implicit preferences
and habits without being explicitly told. Runs as part of nightly
consolidation or on-demand.

What it tracks:
- Time-of-day patterns (when does Gino usually ask about crypto? projects?)
- Topic sequences (does he always check X before Y?)
- Communication preferences (how long are his messages? voice vs text?)
- Tool/approach preferences (which tools does he prefer?)
- Recurring requests (things he asks for repeatedly)
"""

import json
import os
import re
import sqlite3
import subprocess
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path

DB_PATH = Path.home() / "claudeclaw" / "store" / "claudeclaw.db"
SESSIONS_DIR = Path.home() / ".claude" / "projects" / "-Users-ginovarisano-claudeclaw"


def get_conn():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def get_recent_sessions(days=7):
    """Get session files from the last N days."""
    cutoff = datetime.now() - timedelta(days=days)
    sessions = []
    for f in SESSIONS_DIR.glob("*.jsonl"):
        mtime = datetime.fromtimestamp(f.stat().st_mtime)
        if mtime >= cutoff:
            sessions.append(f)
    return sessions


def extract_user_messages(session_file):
    """Extract user messages with timestamps from a session."""
    messages = []
    with open(session_file) as f:
        for line in f:
            try:
                entry = json.loads(line.strip())
            except json.JSONDecodeError:
                continue

            if entry.get("type") != "user":
                continue

            timestamp = entry.get("timestamp")
            msg = entry.get("message", {})
            if not isinstance(msg, dict):
                continue

            content = msg.get("content", "")
            text = ""
            if isinstance(content, str):
                text = content
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        text += block.get("text", "") + " "

            if text.strip():
                messages.append({
                    "text": text.strip(),
                    "timestamp": timestamp,
                    "is_voice": "[Voice transcribed]" in text,
                    "length": len(text.strip()),
                })

    return messages


def analyze_patterns(all_messages):
    """Analyze messages for behavioral patterns."""
    patterns = []

    if not all_messages:
        return patterns

    # ─── Time-of-day patterns ───
    hour_topics = defaultdict(list)
    for msg in all_messages:
        if not msg.get("timestamp"):
            continue
        try:
            dt = datetime.fromisoformat(msg["timestamp"].replace("Z", "+00:00"))
            hour = dt.hour
        except (ValueError, AttributeError):
            continue

        text_lower = msg["text"].lower()
        # Detect topic keywords
        topics = []
        if any(w in text_lower for w in ["crypto", "bitcoin", "btc", "eth", "trade", "price", "coin", "token"]):
            topics.append("crypto")
        if any(w in text_lower for w in ["code", "build", "fix", "bug", "function", "script"]):
            topics.append("coding")
        if any(w in text_lower for w in ["notion", "template", "marketplace"]):
            topics.append("notion")
        if any(w in text_lower for w in ["solar", "battery", "inverter", "panel"]):
            topics.append("solar")
        if any(w in text_lower for w in ["ai", "model", "mcp", "agent", "claude", "gpt"]):
            topics.append("ai-tools")
        if any(w in text_lower for w in ["design", "image", "video", "photoshop", "premiere"]):
            topics.append("media")

        for topic in topics:
            hour_topics[topic].append(hour)

    for topic, hours in hour_topics.items():
        if len(hours) >= 3:
            avg_hour = sum(hours) / len(hours)
            peak = max(set(hours), key=hours.count)
            period = "morning" if peak < 12 else "afternoon" if peak < 17 else "evening" if peak < 21 else "late night"
            patterns.append({
                "type": "time_preference",
                "description": f"Gino tends to work on {topic} in the {period} (peak hour: {peak}:00)",
                "evidence": f"Seen {len(hours)} times, avg hour {avg_hour:.1f}, peak at {peak}:00",
                "confidence": min(0.3 + len(hours) * 0.1, 0.95),
            })

    # ─── Message length patterns ───
    lengths = [m["length"] for m in all_messages]
    avg_len = sum(lengths) / len(lengths) if lengths else 0
    short_msgs = sum(1 for l in lengths if l < 50)
    long_msgs = sum(1 for l in lengths if l > 200)

    if len(lengths) >= 5:
        if short_msgs / len(lengths) > 0.7:
            patterns.append({
                "type": "communication_style",
                "description": "Gino strongly prefers short, direct messages (avg {:.0f} chars)".format(avg_len),
                "evidence": f"{short_msgs}/{len(lengths)} messages under 50 chars",
                "confidence": 0.8,
            })
        elif long_msgs / len(lengths) > 0.3:
            patterns.append({
                "type": "communication_style",
                "description": "Gino often sends detailed messages (avg {:.0f} chars)".format(avg_len),
                "evidence": f"{long_msgs}/{len(lengths)} messages over 200 chars",
                "confidence": 0.7,
            })

    # ─── Voice vs text preference ───
    voice_count = sum(1 for m in all_messages if m["is_voice"])
    text_count = len(all_messages) - voice_count
    if len(all_messages) >= 5:
        if voice_count > text_count:
            patterns.append({
                "type": "input_preference",
                "description": "Gino prefers voice messages over typing",
                "evidence": f"{voice_count} voice vs {text_count} text messages",
                "confidence": min(0.5 + (voice_count / len(all_messages)) * 0.5, 0.95),
            })
        elif voice_count == 0:
            patterns.append({
                "type": "input_preference",
                "description": "Gino exclusively uses text — never voice",
                "evidence": f"{text_count} text, 0 voice messages",
                "confidence": 0.7,
            })

    # ─── Recurring requests ───
    # Simple keyword frequency to detect repeated asks
    action_words = Counter()
    for msg in all_messages:
        text = msg["text"].lower()
        # Look for command-like phrases
        for pattern in [
            r"check (\w+)",
            r"look at (\w+)",
            r"show me (\w+)",
            r"what.s (\w+)",
            r"search (?:for )?(\w+)",
            r"research (\w+)",
            r"browse (\w+)",
        ]:
            matches = re.findall(pattern, text)
            for m in matches:
                if len(m) > 2 and m not in ("the", "this", "that", "what", "how", "for", "and"):
                    action_words[m] += 1

    for word, count in action_words.most_common(5):
        if count >= 3:
            patterns.append({
                "type": "recurring_interest",
                "description": f"Gino frequently asks about '{word}' ({count} times recently)",
                "evidence": f"Keyword '{word}' appeared in {count} separate requests",
                "confidence": min(0.4 + count * 0.1, 0.9),
            })

    return patterns


def store_patterns(patterns):
    """Store or update tacit patterns in the DB."""
    conn = get_conn()
    now = int(datetime.now().timestamp())
    new_count = 0
    updated_count = 0

    for p in patterns:
        # Check for existing similar pattern
        existing = conn.execute(
            "SELECT id, times_observed, confidence FROM tacit_patterns WHERE pattern_type = ? AND description LIKE ?",
            (p["type"], f"%{p['description'][:40]}%"),
        ).fetchone()

        if existing:
            # Strengthen existing pattern
            new_confidence = min(existing["confidence"] + 0.05, 0.99)
            conn.execute(
                "UPDATE tacit_patterns SET confidence = ?, times_observed = times_observed + 1, last_seen = ?, evidence = ? WHERE id = ?",
                (new_confidence, now, p["evidence"], existing["id"]),
            )
            updated_count += 1
        else:
            conn.execute(
                "INSERT INTO tacit_patterns (pattern_type, description, evidence, confidence, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)",
                (p["type"], p["description"], p["evidence"], p["confidence"], now, now),
            )
            new_count += 1

    conn.commit()
    conn.close()
    return new_count, updated_count


def get_all_patterns():
    """Get all stored tacit patterns."""
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM tacit_patterns ORDER BY confidence DESC"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_relevant_patterns(context_keywords):
    """Get patterns relevant to given context."""
    conn = get_conn()
    patterns = []
    for kw in context_keywords:
        rows = conn.execute(
            "SELECT * FROM tacit_patterns WHERE description LIKE ? AND confidence >= 0.5 ORDER BY confidence DESC",
            (f"%{kw}%",),
        ).fetchall()
        patterns.extend(dict(r) for r in rows)

    conn.close()
    # Deduplicate by id
    seen = set()
    unique = []
    for p in patterns:
        if p["id"] not in seen:
            seen.add(p["id"])
            unique.append(p)
    return unique


def run_analysis():
    """Main analysis workflow."""
    print("\n=== Tacit Knowledge Analysis ===\n")

    sessions = get_recent_sessions(days=7)
    print(f"Analyzing {len(sessions)} sessions from the last 7 days")

    all_messages = []
    for s in sessions:
        msgs = extract_user_messages(s)
        all_messages.extend(msgs)

    print(f"Total user messages: {len(all_messages)}")

    if not all_messages:
        print("No messages to analyze")
        return

    patterns = analyze_patterns(all_messages)
    print(f"\nDetected {len(patterns)} patterns:")
    for p in patterns:
        print(f"  [{p['type']}] {p['description']} (confidence: {p['confidence']:.0%})")

    new, updated = store_patterns(patterns)
    print(f"\nStored: {new} new, {updated} updated")

    # Show all stored patterns
    all_stored = get_all_patterns()
    if all_stored:
        print(f"\n=== All Tacit Knowledge ({len(all_stored)} patterns) ===")
        for p in all_stored:
            print(f"  [{p['pattern_type']}] {p['description']} — {p['confidence']:.0%} ({p['times_observed']}x)")


if __name__ == "__main__":
    run_analysis()
