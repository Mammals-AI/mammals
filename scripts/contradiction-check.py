#!/usr/bin/env python3
"""
Real-Time Contradiction Detection for Mammals.

Checks a new statement against existing memories and knowledge graph facts
to detect conflicts. Can be called mid-conversation or during consolidation.

Usage:
  python3 contradiction-check.py "the user uses Coinbase for trading"
  → Would flag: conflicts with existing fact "the user trades on Exchange"

  python3 contradiction-check.py --batch  (reads stdin, one statement per line)
"""

import json
import sqlite3
import subprocess
import sys
from pathlib import Path

DB_PATH = Path.home() / "claudeclaw" / "store" / "claudeclaw.db"


def get_conn():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def get_relevant_context(statement):
    """Pull potentially related memories and facts for comparison."""
    conn = get_conn()
    context = {"memories": [], "facts": []}

    # FTS search on memories
    words = statement.replace(",", " ").replace(".", " ").split()
    keywords = [w for w in words if len(w) > 3 and w.lower() not in (
        "this", "that", "with", "from", "have", "been", "does", "what",
        "when", "where", "which", "their", "about", "would", "should",
        "could", "there", "these", "those", "then", "than", "into",
    )]

    if keywords:
        fts_query = " OR ".join(f"{kw}*" for kw in keywords[:5])
        try:
            rows = conn.execute("""
                SELECT m.id, m.content, m.sector, m.salience
                FROM memories m
                JOIN memories_fts f ON f.rowid = m.id
                WHERE f.content MATCH ?
                ORDER BY m.salience DESC
                LIMIT 10
            """, (fts_query,)).fetchall()
            context["memories"] = [dict(r) for r in rows]
        except Exception:
            pass

    # KG facts — search by keyword overlap
    for kw in keywords[:5]:
        try:
            rows = conn.execute("""
                SELECT f.id, f.fact, f.confidence, e.name as entity_name
                FROM kg_facts f
                JOIN kg_entities e ON e.id = f.entity_id
                WHERE f.fact LIKE ? OR e.name LIKE ?
                ORDER BY f.confidence DESC
                LIMIT 5
            """, (f"%{kw}%", f"%{kw}%")).fetchall()
            for r in rows:
                d = dict(r)
                if d not in context["facts"]:
                    context["facts"].append(d)
        except Exception:
            pass

    conn.close()
    return context


def check_contradiction(statement, context):
    """Use Claude to check if the statement contradicts existing knowledge."""
    if not context["memories"] and not context["facts"]:
        return {"has_contradiction": False, "reason": "No relevant context found to compare against"}

    # Build context string
    existing = []
    for m in context["memories"]:
        existing.append(f"[Memory #{m['id']}, {m['sector']}, salience={m['salience']:.1f}] {m['content'][:200]}")
    for f in context["facts"]:
        existing.append(f"[KG Fact #{f['id']} on {f['entity_name']}, confidence={f['confidence']:.1f}] {f['fact']}")

    existing_text = "\n".join(existing)

    prompt = f"""Check if this NEW statement contradicts any EXISTING knowledge.

NEW STATEMENT: "{statement}"

EXISTING KNOWLEDGE:
{existing_text}

Respond in EXACTLY this JSON format (no markdown):
{{
  "has_contradiction": true/false,
  "contradicted_items": [
    {{
      "type": "memory" or "fact",
      "id": 123,
      "existing": "what the existing item says",
      "conflict": "how the new statement conflicts"
    }}
  ],
  "assessment": "brief explanation"
}}

Rules:
- Only flag GENUINE contradictions, not just related info
- "the user uses Binance" and "the user uses Coinbase" IS a contradiction if they claim different primary exchanges
- "the user likes crypto" and "the user trades BTC" is NOT a contradiction — just related info
- If no contradiction, return has_contradiction: false with empty contradicted_items
"""

    try:
        result = subprocess.run(
            ["claude", "-p", prompt, "--output-format", "json"],
            capture_output=True, text=True, timeout=60,
            cwd=str(Path.home() / "claudeclaw"),
        )

        try:
            cli_output = json.loads(result.stdout)
            text = cli_output.get("result", result.stdout)
        except json.JSONDecodeError:
            text = result.stdout

        text = text.strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[1] if "\n" in text else text[3:]
            if text.endswith("```"):
                text = text[:-3]
            text = text.strip()

        return json.loads(text)
    except Exception as e:
        return {"has_contradiction": False, "reason": f"Analysis error: {e}", "contradicted_items": []}


def handle_contradictions(result):
    """Take action on detected contradictions."""
    if not result.get("has_contradiction"):
        return

    conn = get_conn()
    for item in result.get("contradicted_items", []):
        item_type = item.get("type")
        item_id = item.get("id")

        if item_type == "memory" and item_id:
            # Lower salience of contradicted memory
            conn.execute(
                "UPDATE memories SET salience = salience * 0.5 WHERE id = ?",
                (item_id,),
            )
        elif item_type == "fact" and item_id:
            # Lower confidence of contradicted fact
            conn.execute(
                "UPDATE kg_facts SET confidence = confidence * 0.5 WHERE id = ?",
                (item_id,),
            )

    conn.commit()
    conn.close()


def check_statement(statement, auto_handle=False):
    """Full pipeline: get context, check contradiction, optionally handle."""
    print(f"\nChecking: \"{statement}\"")

    context = get_relevant_context(statement)
    print(f"  Found {len(context['memories'])} related memories, {len(context['facts'])} related facts")

    if not context["memories"] and not context["facts"]:
        print("  ✅ No relevant context — no contradiction possible")
        return None

    result = check_contradiction(statement, context)

    if result.get("has_contradiction"):
        print(f"  ⚠️ CONTRADICTION DETECTED:")
        print(f"  {result.get('assessment', '')}")
        for item in result.get("contradicted_items", []):
            print(f"    - [{item['type']} #{item['id']}] {item.get('existing', '')}")
            print(f"      → Conflicts: {item.get('conflict', '')}")

        if auto_handle:
            handle_contradictions(result)
            print("  → Auto-handled: lowered salience/confidence of contradicted items")
    else:
        print(f"  ✅ No contradiction. {result.get('assessment', result.get('reason', ''))}")

    return result


if __name__ == "__main__":
    if "--batch" in sys.argv:
        print("Batch mode — enter statements (one per line, Ctrl+D to finish):")
        for line in sys.stdin:
            line = line.strip()
            if line:
                check_statement(line)
    elif len(sys.argv) > 1 and sys.argv[1] != "--batch":
        statement = " ".join(sys.argv[1:])
        check_statement(statement, auto_handle="--auto" in sys.argv)
    else:
        print("Usage: python3 contradiction-check.py \"statement to check\"")
        print("       python3 contradiction-check.py --batch  (read from stdin)")
        print("       python3 contradiction-check.py \"statement\" --auto  (auto-handle contradictions)")
