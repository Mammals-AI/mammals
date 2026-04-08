#!/usr/bin/env python3
"""
Escalation Tiers — Updates all named agent system prompts with
a standardized escalation protocol (Felix-inspired).

Tier 1: Agent handles silently (routine tasks, monitoring)
Tier 2: Agent handles + notifies Gino (notable findings, completed tasks)
Tier 3: Agent escalates to main Mammals (needs tools/context it doesn't have)
Tier 4: Escalate to Gino directly (decisions, money, destructive actions)
"""

import sqlite3
from pathlib import Path

DB_PATH = Path.home() / "claudeclaw" / "store" / "claudeclaw.db"

ESCALATION_PROTOCOL = """

---
ESCALATION PROTOCOL (follow this for every task):

TIER 1 — Handle silently:
- Routine monitoring, data gathering, analysis
- Looking things up, summarizing information
- Preparing drafts or options
→ Just do it. No need to report unless asked.

TIER 2 — Handle + notify:
- Found something notable or time-sensitive
- Completed a significant task
- Discovered something Gino should know about
→ Do the work, then include a brief heads-up in your response.

TIER 3 — Escalate to main agent:
- You need tools or access you don't have
- Task requires coordination with other agents
- You're uncertain about the right approach
→ Say: "I need to escalate this because [reason]"

TIER 4 — Escalate to Gino:
- Anything involving spending money
- Destructive actions (deleting, overwriting)
- Security-sensitive decisions
- You're genuinely stuck and need human judgment
→ Say: "This needs Gino's call because [reason]"

Default to the LOWEST tier that fits. When in doubt between tiers, go one tier up.
---"""


def update_agents():
    """Add escalation protocol to all agent system prompts."""
    if not DB_PATH.exists():
        print("Database not found")
        return

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row

    agents = conn.execute("SELECT name, system_prompt FROM agents").fetchall()

    updated = 0
    skipped = 0

    for agent in agents:
        name = agent["name"]
        prompt = agent["system_prompt"]

        # Skip if already has escalation protocol
        if "ESCALATION PROTOCOL" in prompt:
            print(f"  {name}: already has escalation protocol, skipping")
            skipped += 1
            continue

        new_prompt = prompt + ESCALATION_PROTOCOL

        conn.execute(
            "UPDATE agents SET system_prompt = ? WHERE name = ?",
            (new_prompt, name),
        )
        updated += 1
        print(f"  {name}: updated with escalation protocol")

    conn.commit()
    conn.close()

    print(f"\nDone: {updated} updated, {skipped} skipped")


if __name__ == "__main__":
    print("=== Updating Agent Escalation Tiers ===\n")
    update_agents()
