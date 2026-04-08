#!/usr/bin/env python3
"""
Deep Sleep — Memory promotion and reconciliation.

Runs nightly (after light sleep). Takes high-salience recent memories and:
1. Promotes important episodic memories to semantic (durable facts)
2. Merges near-duplicate semantic memories
3. Resolves contradictions (update old, log the change)
4. Archives evolved facts ("X was true, now Y is true")
5. Logs all actions to memory_promotions table
"""

import json
import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

DB_PATH = Path.home() / "claudeclaw" / "store" / "claudeclaw.db"


def db():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def get_candidate_memories():
    """Get memories that are candidates for promotion/reconciliation.
    High-salience recent memories + all semantic memories for comparison."""
    conn = db()
    week_ago = int((datetime.now() - timedelta(days=7)).timestamp() * 1000)

    try:
        # Recent high-salience memories (episodic or new semantic from light sleep)
        candidates = conn.execute(
            "SELECT id, content, sector, salience, topic_key, created_at FROM memories "
            "WHERE created_at > ? AND salience >= 1.2 "
            "ORDER BY salience DESC LIMIT 40",
            (week_ago,),
        ).fetchall()

        # All semantic memories for comparison
        semantic = conn.execute(
            "SELECT id, content, salience, topic_key, created_at FROM memories "
            "WHERE sector = 'semantic' ORDER BY salience DESC LIMIT 80"
        ).fetchall()

        return [dict(r) for r in candidates], [dict(r) for r in semantic]
    except Exception:
        return [], []
    finally:
        conn.close()


def get_kg_facts():
    """Get knowledge graph facts for cross-referencing."""
    conn = db()
    try:
        rows = conn.execute(
            "SELECT f.id, f.fact, f.confidence, e.name as entity "
            "FROM kg_facts f JOIN kg_entities e ON f.entity_id = e.id "
            "WHERE f.confidence > 0.3 ORDER BY f.confidence DESC LIMIT 40"
        ).fetchall()
        return [dict(r) for r in rows]
    except Exception:
        return []
    finally:
        conn.close()


def run_reconciliation(candidates, semantic, kg_facts):
    """Use Claude to reconcile memories: merge, contradict, archive, evolve."""
    if not candidates:
        return None

    cand_text = "\n".join(
        f"  [{m['id']}] (sal:{m['salience']:.1f}, {m['sector']}) {m['content'][:200]}"
        for m in candidates
    )

    sem_text = "\n".join(
        f"  [{m['id']}] (sal:{m['salience']:.1f}) {m['content'][:200]}"
        for m in semantic
    )

    kg_text = "\n".join(
        f"  [{f['id']}] ({f['entity']}, conf:{f['confidence']:.1f}) {f['fact'][:150]}"
        for f in kg_facts
    ) if kg_facts else "  No KG facts available"

    prompt = f"""You are Mammals's deep sleep reconciliation system. Compare recent high-salience memories against the long-term memory store and knowledge graph. Identify what should be promoted, merged, contradicted, or archived.

RECENT HIGH-SALIENCE MEMORIES (candidates for action):
{cand_text}

EXISTING LONG-TERM SEMANTIC MEMORIES:
{sem_text}

KNOWLEDGE GRAPH FACTS:
{kg_text}

For each candidate, determine the right action:

1. **promote** — episodic memory worth making permanent semantic memory (new durable fact)
2. **merge** — candidate says roughly the same thing as an existing memory (consolidate, boost salience)
3. **contradict** — candidate conflicts with an existing memory or KG fact (note which one, explain)
4. **archive** — existing memory is outdated, candidate is the updated version (evolve)
5. **skip** — not worth any action (too vague, temporary, already covered)

Respond in raw JSON only (no markdown):
{{
  "actions": [
    {{
      "candidate_id": 123,
      "action": "promote|merge|contradict|archive|skip",
      "target_id": null,
      "new_content": "refined/merged content if applicable",
      "reason": "brief explanation"
    }}
  ],
  "reconciliation_notes": "1-2 sentence overview of what changed"
}}"""

    try:
        result = subprocess.run(
            ["claude", "-p", prompt, "--output-format", "json", "--model", "haiku"],
            capture_output=True,
            text=True,
            timeout=90,
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
        print(f"  Reconciliation error: {e}")
        return None


def apply_reconciliation(result):
    """Apply reconciliation actions to the database."""
    if not result:
        return

    conn = db()
    now_ms = int(datetime.now().timestamp() * 1000)
    actions = result.get("actions", [])
    notes = result.get("reconciliation_notes", "")

    stats = {"promote": 0, "merge": 0, "contradict": 0, "archive": 0, "skip": 0}

    try:
        for action in actions:
            cid = action.get("candidate_id")
            act = action.get("action", "skip")
            target_id = action.get("target_id")
            new_content = action.get("new_content")
            reason = action.get("reason", "")
            stats[act] = stats.get(act, 0) + 1

            if act == "skip":
                continue

            # Get the candidate's current content for logging
            candidate = conn.execute(
                "SELECT content FROM memories WHERE id = ?", (cid,)
            ).fetchone()
            old_content = candidate["content"] if candidate else ""

            if act == "promote":
                # Upgrade episodic to semantic, boost salience
                content = new_content or old_content
                conn.execute(
                    "UPDATE memories SET sector = 'semantic', salience = MIN(salience + 0.5, 5.0), "
                    "accessed_at = ? WHERE id = ?",
                    (now_ms, cid),
                )
                if new_content and new_content != old_content:
                    conn.execute(
                        "UPDATE memories SET content = ? WHERE id = ?",
                        (new_content, cid),
                    )
                print(f"  PROMOTE [{cid}]: {(new_content or old_content)[:60]}...")

            elif act == "merge":
                # Boost target, optionally update its content, lower candidate
                if target_id:
                    if new_content:
                        conn.execute(
                            "UPDATE memories SET content = ?, salience = MIN(salience + 0.3, 5.0), "
                            "accessed_at = ? WHERE id = ?",
                            (new_content, now_ms, target_id),
                        )
                    else:
                        conn.execute(
                            "UPDATE memories SET salience = MIN(salience + 0.3, 5.0), "
                            "accessed_at = ? WHERE id = ?",
                            (now_ms, target_id),
                        )
                    # Lower the duplicate's salience
                    conn.execute(
                        "UPDATE memories SET salience = salience * 0.3 WHERE id = ?",
                        (cid,),
                    )
                print(f"  MERGE [{cid}] → [{target_id}]: {reason[:60]}")

            elif act == "contradict":
                # Lower salience of the contradicted memory
                if target_id:
                    conn.execute(
                        "UPDATE memories SET salience = salience * 0.5 WHERE id = ?",
                        (target_id,),
                    )
                # Boost the candidate (newer info wins)
                conn.execute(
                    "UPDATE memories SET salience = MIN(salience + 0.3, 5.0), sector = 'semantic' WHERE id = ?",
                    (cid,),
                )
                if new_content:
                    conn.execute(
                        "UPDATE memories SET content = ? WHERE id = ?",
                        (new_content, cid),
                    )
                print(f"  CONTRADICT [{target_id}] ← [{cid}]: {reason[:60]}")

            elif act == "archive":
                # Mark old memory as very low salience, promote new
                if target_id:
                    conn.execute(
                        "UPDATE memories SET salience = 0.15 WHERE id = ?",
                        (target_id,),
                    )
                conn.execute(
                    "UPDATE memories SET sector = 'semantic', salience = MIN(salience + 0.5, 5.0) WHERE id = ?",
                    (cid,),
                )
                if new_content:
                    conn.execute(
                        "UPDATE memories SET content = ? WHERE id = ?",
                        (new_content, cid),
                    )
                print(f"  ARCHIVE [{target_id}] → [{cid}]: {reason[:60]}")

            # Log the promotion/action
            conn.execute(
                "INSERT INTO memory_promotions (memory_id, action, old_content, new_content, reason, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (cid, act, old_content[:500], (new_content or "")[:500], reason, now_ms),
            )

        # Log to dream journal
        conn.execute(
            "INSERT INTO dream_journal (phase, content, confidence, tags, created_at) "
            "VALUES ('deep', ?, 0.8, ?, ?)",
            (
                notes or f"Reconciled: {json.dumps(stats)}",
                json.dumps(list(stats.keys())),
                now_ms,
            ),
        )

        conn.commit()
        print(f"  Deep sleep complete: {json.dumps(stats)}")
    except Exception as e:
        print(f"  Error applying reconciliation: {e}")
    finally:
        conn.close()


def main():
    print("=== DEEP SLEEP — Memory Reconciliation ===")

    candidates, semantic = get_candidate_memories()
    if not candidates:
        print("  No high-salience candidates to reconcile. Skipping.")
        return

    print(f"  {len(candidates)} candidates, {len(semantic)} semantic memories to compare")

    kg_facts = get_kg_facts()
    result = run_reconciliation(candidates, semantic, kg_facts)
    apply_reconciliation(result)


if __name__ == "__main__":
    main()
