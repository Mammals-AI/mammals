#!/usr/bin/env python3
"""
REM Sleep — Pattern synthesis and lasting truths.

Runs nightly after deep sleep. Looks across the last 7 days of memories,
knowledge graph, tacit patterns, and dream journal entries to synthesize
cross-cutting insights — things that aren't in any single memory but
emerge from the patterns across many.

Writes insights to:
1. dream_journal table (searchable)
2. ~/claudeclaw/dreams/YYYY-MM-DD.md (human-readable)
"""

import json
import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

DB_PATH = Path.home() / "claudeclaw" / "store" / "claudeclaw.db"
DREAMS_DIR = Path.home() / "claudeclaw" / "dreams"


def db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def get_recent_memories(days=7):
    """Get semantic memories from the last N days."""
    conn = db()
    since = int((datetime.now() - timedelta(days=days)).timestamp() * 1000)
    try:
        rows = conn.execute(
            "SELECT id, content, topic_key, salience, created_at FROM memories "
            "WHERE sector = 'semantic' AND created_at > ? ORDER BY salience DESC LIMIT 60",
            (since,),
        ).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []
    finally:
        conn.close()


def get_top_memories():
    """Get the highest-salience memories overall (the core identity)."""
    conn = db()
    try:
        rows = conn.execute(
            "SELECT content, salience, topic_key FROM memories "
            "WHERE sector = 'semantic' AND salience >= 2.0 ORDER BY salience DESC LIMIT 20"
        ).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []
    finally:
        conn.close()


def get_tacit_patterns():
    """Get behavioral patterns."""
    conn = db()
    try:
        rows = conn.execute(
            "SELECT pattern_type, description, confidence, times_observed FROM tacit_patterns "
            "WHERE confidence > 0.5 ORDER BY confidence DESC LIMIT 15"
        ).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []
    finally:
        conn.close()


def get_recent_promotions():
    """Get memory promotion actions from deep sleep."""
    conn = db()
    since = int((datetime.now() - timedelta(days=3)).timestamp() * 1000)
    try:
        rows = conn.execute(
            "SELECT action, old_content, new_content, reason FROM memory_promotions "
            "WHERE created_at > ? ORDER BY created_at DESC LIMIT 20",
            (since,),
        ).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []
    finally:
        conn.close()


def get_recent_dreams():
    """Get recent dream journal entries to build on."""
    conn = db()
    since = int((datetime.now() - timedelta(days=7)).timestamp() * 1000)
    try:
        rows = conn.execute(
            "SELECT phase, content, created_at FROM dream_journal "
            "WHERE created_at > ? ORDER BY created_at DESC LIMIT 10",
            (since,),
        ).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []
    finally:
        conn.close()


def get_conversation_topics(days=7):
    """Get a summary of conversation topics from recent days."""
    conn = db()
    since = int((datetime.now() - timedelta(days=days)).timestamp() * 1000)
    try:
        rows = conn.execute(
            "SELECT content, source FROM conversations "
            "WHERE role = 'user' AND created_at > ? ORDER BY created_at DESC LIMIT 80",
            (since,),
        ).fetchall()
        # Just grab the first 100 chars of each for topic analysis
        return [{"text": r["content"][:100], "source": r["source"]} for r in rows]
    except Exception:
        return []
    finally:
        conn.close()


def get_active_goals():
    """Get active goals."""
    conn = db()
    try:
        rows = conn.execute(
            "SELECT title, description, priority FROM goals "
            "WHERE status = 'active' ORDER BY priority LIMIT 8"
        ).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []
    finally:
        conn.close()


def synthesize_dreams(recent_mems, top_mems, patterns, promotions, prev_dreams, topics, goals):
    """Use Claude to synthesize cross-cutting insights from all inputs."""

    recent_text = "\n".join(
        f"  - (sal:{m['salience']:.1f}, {m.get('topic_key','')}) {m['content'][:150]}"
        for m in recent_mems
    )

    top_text = "\n".join(
        f"  - (sal:{m['salience']:.1f}) {m['content'][:150]}" for m in top_mems
    )

    pattern_text = "\n".join(
        f"  - ({p['pattern_type']}, conf:{p['confidence']:.1f}, seen:{p['times_observed']}x) {p['description']}"
        for p in patterns
    ) if patterns else "  None detected"

    promo_text = "\n".join(
        f"  - [{p['action']}] {p['reason'][:100]}" for p in promotions
    ) if promotions else "  None recent"

    prev_text = "\n".join(
        f"  - [{d['phase']}] {d['content'][:120]}" for d in prev_dreams
    ) if prev_dreams else "  First dreaming session"

    topic_text = "\n".join(f"  - {t['text'][:80]}" for t in topics[:30])

    goals_text = "\n".join(f"  - [{g['priority']}] {g['title']}" for g in goals)

    prompt = f"""You are Mammals's REM dreaming system. Your job is to look across ALL the data below and synthesize insights that aren't captured in any single memory — patterns, trajectories, correlations, and lasting truths that emerge from the whole picture.

Think like a human brain during REM sleep: make connections, surface intuitions, identify what really matters.

RECENT MEMORIES (last 7 days):
{recent_text}

CORE MEMORIES (highest importance):
{top_text}

BEHAVIORAL PATTERNS:
{pattern_text}

RECENT MEMORY ACTIONS (deep sleep):
{promo_text}

PREVIOUS DREAMS:
{prev_text}

RECENT CONVERSATION TOPICS:
{topic_text}

ACTIVE GOALS:
{goals_text}

Synthesize 3-7 dream insights. Each should be something NOT already captured in a single memory — it should emerge from connecting dots across multiple sources. Types of insights:

- **trajectory**: "the user has been shifting focus from X to Y" (observed over time)
- **correlation**: "When X happens, Y tends to follow" (pattern across events)
- **principle**: "the user values X over Y in decisions" (inferred from behavior)
- **risk**: "X might become a problem because..." (early warning)
- **opportunity**: "Given X and Y, there's an opening for Z"
- **identity**: "the user is becoming someone who..." (growth/change observation)

Respond in raw JSON only (no markdown):
{{
  "dreams": [
    {{
      "insight": "the lasting truth or pattern",
      "type": "trajectory|correlation|principle|risk|opportunity|identity",
      "confidence": 0.5-0.95,
      "evidence": "brief note on what data points support this",
      "actionable": true/false
    }}
  ],
  "meta": "1-2 sentence reflection on the overall state of things"
}}"""

    try:
        result = subprocess.run(
            ["claude", "-p", prompt, "--output-format", "json", "--model", "sonnet"],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode != 0:
            return None

        text = result.stdout.strip()
        parsed = json.loads(text)
        if "result" in parsed:
            inner = parsed["result"]
            if isinstance(inner, str):
                start = inner.find("{")
                end = inner.rfind("}") + 1
                if start >= 0:
                    return json.loads(inner[start:end])
            elif isinstance(inner, dict):
                return inner
        return parsed
    except Exception as e:
        print(f"  Synthesis error: {e}")
        return None


def save_dreams(result):
    """Save dream insights to database and markdown file."""
    if not result:
        return

    conn = db()
    now_ms = int(datetime.now().timestamp() * 1000)
    dreams = result.get("dreams", [])
    meta = result.get("meta", "")

    # Save to database
    try:
        for dream in dreams:
            conn.execute(
                "INSERT INTO dream_journal (phase, content, confidence, tags, created_at) "
                "VALUES ('rem', ?, ?, ?, ?)",
                (
                    dream.get("insight", ""),
                    dream.get("confidence", 0.7),
                    json.dumps([dream.get("type", ""), "actionable" if dream.get("actionable") else "passive"]),
                    now_ms,
                ),
            )
        conn.commit()
    except Exception as e:
        print(f"  DB error: {e}")
    finally:
        conn.close()

    # Write markdown dream file
    today = datetime.now().strftime("%Y-%m-%d")
    year_month = datetime.now().strftime("%Y/%m")
    dream_dir = DREAMS_DIR / year_month
    dream_dir.mkdir(parents=True, exist_ok=True)
    dream_file = dream_dir / f"{today}.md"

    lines = [f"# Dreams — {today}\n"]
    if meta:
        lines.append(f"_{meta}_\n")
    lines.append("")

    for i, dream in enumerate(dreams, 1):
        dtype = dream.get("type", "insight")
        conf = dream.get("confidence", 0.7)
        insight = dream.get("insight", "")
        evidence = dream.get("evidence", "")
        actionable = dream.get("actionable", False)

        lines.append(f"## {i}. [{dtype}] {insight}")
        lines.append(f"- Confidence: {conf:.0%}")
        lines.append(f"- Evidence: {evidence}")
        if actionable:
            lines.append(f"- Actionable: yes")
        lines.append("")

    with open(dream_file, "w") as f:
        f.write("\n".join(lines))

    print(f"  REM complete: {len(dreams)} dreams written to {dream_file}")


def main():
    print("=== REM SLEEP — Pattern Synthesis ===")

    recent_mems = get_recent_memories()
    top_mems = get_top_memories()
    patterns = get_tacit_patterns()
    promotions = get_recent_promotions()
    prev_dreams = get_recent_dreams()
    topics = get_conversation_topics()
    goals = get_active_goals()

    total_inputs = len(recent_mems) + len(top_mems) + len(patterns) + len(topics)
    if total_inputs < 5:
        print("  Not enough data to dream. Skipping.")
        return

    print(f"  Inputs: {len(recent_mems)} recent + {len(top_mems)} core memories, "
          f"{len(patterns)} patterns, {len(topics)} conversation topics")

    result = synthesize_dreams(recent_mems, top_mems, patterns, promotions, prev_dreams, topics, goals)
    save_dreams(result)


if __name__ == "__main__":
    main()
