"""
Shared Context Module — Mammals's unified situational awareness.

All autonomous scripts can import this to see the same picture:
  from shared_context import get_situation

This prevents systems from operating in isolation. Each script gets:
- Active goals and their progress
- Active initiatives and what's being worked on
- Recent agent activity
- Service health
- Recent outcomes (what worked, what didn't)
- Today's priorities from the daily note

Usage:
    from importlib.util import spec_from_file_location, module_from_spec
    # Or just: import sys; sys.path.insert(0, '~/claudeclaw/scripts'); from shared_context import get_situation
"""

import json
import sqlite3
import subprocess
from datetime import datetime
from pathlib import Path

DB_PATH = Path.home() / "claudeclaw" / "store" / "claudeclaw.db"
DAILY_NOTES_DIR = Path.home() / "claudeclaw" / "daily-notes"


def _get_conn():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def get_active_goals():
    """Active goals ordered by priority."""
    conn = _get_conn()
    goals = conn.execute(
        "SELECT id, title, description, priority, source FROM goals "
        "WHERE status = 'active' ORDER BY priority ASC"
    ).fetchall()
    conn.close()
    return [dict(g) for g in goals]


def get_active_initiatives():
    """Pending/in-progress initiatives with their goal context."""
    conn = _get_conn()
    initiatives = conn.execute(
        "SELECT i.id, i.title, i.status, i.priority, i.goal_id, g.title as goal_title "
        "FROM initiatives i LEFT JOIN goals g ON i.goal_id = g.id "
        "WHERE i.status IN ('pending', 'in_progress') "
        "ORDER BY i.priority ASC"
    ).fetchall()
    conn.close()
    return [dict(i) for i in initiatives]


def get_recent_agent_activity(hours=24):
    """What agents have been doing recently."""
    conn = _get_conn()
    cutoff = int(datetime.now().timestamp()) - (hours * 3600)
    try:
        activity = conn.execute(
            "SELECT from_agent, to_agent, substr(message, 1, 100) as message, "
            "substr(response, 1, 100) as response, created_at "
            "FROM agent_messages WHERE created_at >= ? "
            "ORDER BY created_at DESC LIMIT 10",
            (cutoff,)
        ).fetchall()
    except Exception:
        activity = []
    conn.close()
    return [dict(a) for a in activity]


def get_recent_outcomes(limit=5):
    """Recent initiative outcomes — what worked and what didn't."""
    conn = _get_conn()
    try:
        outcomes = conn.execute(
            "SELECT o.action_type, o.agent_name, o.result_summary, o.success, "
            "o.created_at, i.title as initiative_title "
            "FROM initiative_outcomes o "
            "LEFT JOIN initiatives i ON o.initiative_id = i.id "
            "ORDER BY o.created_at DESC LIMIT ?",
            (limit,)
        ).fetchall()
    except Exception:
        outcomes = []
    conn.close()
    return [dict(o) for o in outcomes]


def get_service_health():
    """Quick check of key services."""
    services = {
        "crypto-bot": 5051,
        "solar-dashboard": 5050,
        "command-center": 5075,
        "x402-service": 4021,
    }
    health = {}
    for name, port in services.items():
        try:
            result = subprocess.run(
                ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-4",
                 f"http://127.0.0.1:{port}/", "--connect-timeout", "2"],
                capture_output=True, text=True, timeout=5,
            )
            health[name] = "up" if result.stdout.strip() not in ("000", "") else "down"
        except Exception:
            health[name] = "unknown"
    return health


def get_today_note_summary(max_chars=1000):
    """Today's daily note content (truncated)."""
    today = datetime.now()
    note_path = DAILY_NOTES_DIR / str(today.year) / f"{today.month:02d}" / f"{today.strftime('%Y-%m-%d')}.md"
    if note_path.exists():
        return note_path.read_text()[:max_chars]
    return None


def get_available_agents():
    """All registered named agents."""
    conn = _get_conn()
    try:
        agents = conn.execute("SELECT name, description FROM agents ORDER BY name").fetchall()
    except Exception:
        agents = []
    conn.close()
    return [dict(a) for a in agents]


def get_shared_findings(topic=None, limit=5):
    """Get recent cross-agent shared findings, optionally filtered by topic."""
    conn = _get_conn()
    now = int(time.time())
    try:
        # Clean expired
        conn.execute(
            "DELETE FROM agent_shared_memory WHERE created_at + (ttl_hours * 3600) < ?",
            (now,)
        )
        conn.commit()

        if topic:
            rows = conn.execute(
                "SELECT from_agent, topic, substr(content, 1, 150) as content, created_at "
                "FROM agent_shared_memory WHERE topic = ? "
                "ORDER BY created_at DESC LIMIT ?",
                (topic, limit)
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT from_agent, topic, substr(content, 1, 150) as content, created_at "
                "FROM agent_shared_memory ORDER BY created_at DESC LIMIT ?",
                (limit,)
            ).fetchall()
    except Exception:
        rows = []
    conn.close()
    return [dict(r) for r in rows]


def get_scheduled_task_status():
    """Active scheduled tasks and their last results."""
    conn = _get_conn()
    try:
        tasks = conn.execute(
            "SELECT id, substr(prompt, 1, 80) as prompt, schedule, status, "
            "last_run, substr(last_result, 1, 100) as last_result "
            "FROM scheduled_tasks WHERE status = 'active' "
            "ORDER BY next_run ASC"
        ).fetchall()
    except Exception:
        tasks = []
    conn.close()
    return [dict(t) for t in tasks]


def get_situation():
    """Build the complete situational awareness picture.

    Returns a dict that any autonomous script can use to understand
    the full system state before making decisions.
    """
    now = datetime.now()

    return {
        "timestamp": now.strftime("%Y-%m-%d %H:%M"),
        "day_of_week": now.strftime("%A"),
        "hour": now.hour,
        "goals": get_active_goals(),
        "initiatives": get_active_initiatives(),
        "recent_outcomes": get_recent_outcomes(5),
        "recent_agent_activity": get_recent_agent_activity(24),
        "service_health": get_service_health(),
        "available_agents": get_available_agents(),
        "scheduled_tasks": get_scheduled_task_status(),
        "shared_findings": get_shared_findings(limit=5),
        "today_note": get_today_note_summary(),
    }


def format_situation_brief(situation=None):
    """Format the situation as a human-readable brief for injection into prompts.

    This is what you'd inject into an agent or script prompt to give it
    full situational awareness in a compact format.
    """
    if situation is None:
        situation = get_situation()

    lines = []
    lines.append(f"=== Situation Brief ({situation['timestamp']} {situation['day_of_week']}) ===\n")

    # Goals
    lines.append("GOALS:")
    for g in situation["goals"]:
        lines.append(f"  [{g['id']}] P{g['priority']} {g['title']}")

    # Initiatives
    lines.append("\nACTIVE INITIATIVES:")
    for i in situation["initiatives"]:
        goal_ref = f" (goal: {i.get('goal_title', '?')})" if i.get('goal_id') else ""
        lines.append(f"  [{i['id']}] {i['status']} — {i['title']}{goal_ref}")

    # Recent outcomes
    if situation["recent_outcomes"]:
        lines.append("\nRECENT OUTCOMES:")
        for o in situation["recent_outcomes"]:
            status = "OK" if o.get("success") else "FAIL"
            agent = f" via {o['agent_name']}" if o.get("agent_name") else ""
            lines.append(f"  [{status}] {o.get('initiative_title', '?')}{agent}: {(o.get('result_summary') or 'no details')[:80]}")

    # Service health
    lines.append("\nSERVICES:")
    for name, status in situation["service_health"].items():
        lines.append(f"  {name}: {status}")

    # Agents
    lines.append(f"\nAGENTS ({len(situation['available_agents'])}):")
    for a in situation["available_agents"]:
        lines.append(f"  - {a['name']}: {a['description'][:60]}")

    return "\n".join(lines)


if __name__ == "__main__":
    import sys
    if "--json" in sys.argv:
        sit = get_situation()
        # Convert for JSON serialization
        print(json.dumps(sit, indent=2, default=str))
    else:
        print(format_situation_brief())
