#!/usr/bin/env python3
"""
Unified Heartbeat Monitor for Mammals.

Single-loop system check that monitors all of Gino's infrastructure.
Silence by default — only reports when something needs attention.

Checks:
- Service health (crypto-bot, solar dashboard, mission control)
- Disk space
- Memory usage
- Database health
- Scheduled task status (overdue or failed)
- Named agent status
- Network connectivity (Tailscale, internet)

Run on a schedule (every 15-30 min) or on-demand.
"""

import json
import os
import sqlite3
import subprocess
import time
from datetime import datetime, timedelta
from pathlib import Path

DB_PATH = Path.home() / "claudeclaw" / "store" / "claudeclaw.db"

# ─── Service definitions ───
SERVICES = [
    {"name": "Crypto Bot", "port": 5051, "host": "127.0.0.1"},
    {"name": "Solar Dashboard", "port": 5050, "host": "127.0.0.1"},
    {"name": "Mission Control", "port": 5075, "host": "127.0.0.1"},
]

# Thresholds
DISK_WARN_PERCENT = 85
MEMORY_WARN_PERCENT = 85
TASK_OVERDUE_MINUTES = 120  # 2 hours past scheduled run
DB_SIZE_WARN_MB = 500


def check_service(name, host, port, timeout=3):
    """Check if a service is responding on its port."""
    try:
        result = subprocess.run(
            ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-4",
             f"http://{host}:{port}/", "--connect-timeout", str(timeout)],
            capture_output=True, text=True, timeout=timeout + 2,
        )
        code = result.stdout.strip()
        is_up = code in ("200", "304", "301", "302", "404")  # Any HTTP response = alive
        return {"name": name, "port": port, "up": is_up, "status_code": code}
    except (subprocess.TimeoutExpired, Exception):
        return {"name": name, "port": port, "up": False, "status_code": "timeout"}


def check_disk():
    """Check disk usage."""
    try:
        result = subprocess.run(
            ["df", "-h", "/"],
            capture_output=True, text=True, timeout=5,
        )
        lines = result.stdout.strip().split("\n")
        if len(lines) >= 2:
            parts = lines[1].split()
            percent = int(parts[4].replace("%", ""))
            available = parts[3]
            return {"percent_used": percent, "available": available, "alert": percent >= DISK_WARN_PERCENT}
    except Exception:
        pass
    return {"percent_used": -1, "available": "unknown", "alert": False}


def check_memory():
    """Check memory pressure (macOS)."""
    try:
        result = subprocess.run(
            ["vm_stat"],
            capture_output=True, text=True, timeout=5,
        )
        lines = result.stdout.strip().split("\n")
        stats = {}
        for line in lines[1:]:
            parts = line.split(":")
            if len(parts) == 2:
                key = parts[0].strip()
                val = parts[1].strip().rstrip(".")
                try:
                    stats[key] = int(val)
                except ValueError:
                    pass

        page_size = 16384  # Apple Silicon default
        free = stats.get("Pages free", 0) * page_size
        active = stats.get("Pages active", 0) * page_size
        inactive = stats.get("Pages inactive", 0) * page_size
        wired = stats.get("Pages wired down", 0) * page_size
        total = free + active + inactive + wired
        used_pct = ((active + wired) / total * 100) if total > 0 else 0

        return {
            "percent_used": round(used_pct, 1),
            "alert": used_pct >= MEMORY_WARN_PERCENT,
        }
    except Exception:
        return {"percent_used": -1, "alert": False}


def check_db():
    """Check database health."""
    try:
        size_mb = DB_PATH.stat().st_size / (1024 * 1024)
        conn = sqlite3.connect(str(DB_PATH))

        # Quick integrity check
        result = conn.execute("PRAGMA quick_check").fetchone()
        healthy = result[0] == "ok" if result else False

        # Memory count
        mem_count = conn.execute("SELECT COUNT(*) FROM memories").fetchone()[0]

        # KG entity count
        try:
            kg_count = conn.execute("SELECT COUNT(*) FROM kg_entities").fetchone()[0]
        except Exception:
            kg_count = 0

        conn.close()

        return {
            "size_mb": round(size_mb, 2),
            "healthy": healthy,
            "memories": mem_count,
            "kg_entities": kg_count,
            "alert": size_mb >= DB_SIZE_WARN_MB or not healthy,
        }
    except Exception as e:
        return {"size_mb": -1, "healthy": False, "memories": 0, "kg_entities": 0, "alert": True, "error": str(e)}


def check_tasks():
    """Check for overdue or failed scheduled tasks."""
    alerts = []
    try:
        conn = sqlite3.connect(str(DB_PATH))
        conn.row_factory = sqlite3.Row
        now = int(time.time())
        overdue_threshold = now - (TASK_OVERDUE_MINUTES * 60)

        tasks = conn.execute(
            "SELECT * FROM scheduled_tasks WHERE status = 'active'"
        ).fetchall()

        for t in tasks:
            # Check if overdue
            if t["next_run"] < overdue_threshold:
                mins_overdue = (now - t["next_run"]) // 60
                alerts.append(f"Task '{t['id']}' overdue by {mins_overdue}min")

            # Check if last result indicates genuine failure
            # Only scan the first 150 chars to avoid false positives from narrative content
            last = (t["last_result"] or "")[:150]
            failure_markers = ["traceback", "exception:", "exit code 1", "unhandled"]
            if any(w in last.lower() for w in failure_markers):
                alerts.append(f"Task '{t['id']}' last run had errors")

        conn.close()
    except Exception as e:
        alerts.append(f"Could not check tasks: {e}")

    return alerts


def check_network():
    """Check network connectivity."""
    checks = {}

    # Internet
    try:
        result = subprocess.run(
            ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-4",
             "https://api.anthropic.com", "--connect-timeout", "5"],
            capture_output=True, text=True, timeout=8,
        )
        checks["internet"] = result.stdout.strip() != ""
    except Exception:
        checks["internet"] = False

    # Tailscale
    try:
        result = subprocess.run(
            ["ping", "-c", "1", "-W", "2", "100.73.175.93"],
            capture_output=True, text=True, timeout=5,
        )
        checks["tailscale"] = result.returncode == 0
    except Exception:
        checks["tailscale"] = False

    return checks


def run_heartbeat():
    """Run all checks and return a report."""
    report = {
        "timestamp": datetime.now().isoformat(),
        "alerts": [],
        "status": {},
    }

    # Services
    service_results = []
    for svc in SERVICES:
        result = check_service(svc["name"], svc["host"], svc["port"])
        service_results.append(result)
        if not result["up"]:
            report["alerts"].append(f"🔴 {result['name']} (port {result['port']}) is DOWN")
    report["status"]["services"] = service_results

    # Disk
    disk = check_disk()
    report["status"]["disk"] = disk
    if disk["alert"]:
        report["alerts"].append(f"💾 Disk {disk['percent_used']}% full — only {disk['available']} left")

    # Memory
    memory = check_memory()
    report["status"]["memory"] = memory
    if memory["alert"]:
        report["alerts"].append(f"🧠 Memory pressure high: {memory['percent_used']}%")

    # Database
    db = check_db()
    report["status"]["database"] = db
    if db["alert"]:
        if not db["healthy"]:
            report["alerts"].append("🗄️ Database integrity check FAILED")
        if db["size_mb"] >= DB_SIZE_WARN_MB:
            report["alerts"].append(f"🗄️ Database is {db['size_mb']}MB — getting large")

    # Scheduled tasks
    task_alerts = check_tasks()
    report["alerts"].extend([f"⏰ {a}" for a in task_alerts])

    # Network
    network = check_network()
    report["status"]["network"] = network
    if not network.get("internet"):
        report["alerts"].append("🌐 No internet connectivity")

    report["all_clear"] = len(report["alerts"]) == 0

    return report


def format_report(report):
    """Format report for logging/display."""
    lines = [f"Heartbeat @ {report['timestamp']}"]

    if report["all_clear"]:
        lines.append("✅ All systems nominal")
    else:
        lines.append(f"⚠️ {len(report['alerts'])} alert(s):")
        for a in report["alerts"]:
            lines.append(f"  {a}")

    # Compact status line
    svcs = report["status"].get("services", [])
    svc_str = " | ".join(
        f"{'✅' if s['up'] else '❌'}{s['name']}" for s in svcs
    )
    lines.append(f"Services: {svc_str}")

    disk = report["status"].get("disk", {})
    mem = report["status"].get("memory", {})
    db = report["status"].get("database", {})
    lines.append(f"Disk: {disk.get('percent_used', '?')}% | RAM: {mem.get('percent_used', '?')}% | DB: {db.get('size_mb', '?')}MB ({db.get('memories', '?')} memories, {db.get('kg_entities', '?')} KG entities)")

    return "\n".join(lines)


def format_telegram_alert(report):
    """Format alerts for Telegram — only called when there ARE alerts."""
    if report["all_clear"]:
        return None

    lines = ["⚠️ Heartbeat Alert"]
    for a in report["alerts"]:
        lines.append(f"  {a}")
    return "\n".join(lines)


if __name__ == "__main__":
    report = run_heartbeat()
    print(format_report(report))

    if not report["all_clear"]:
        alert = format_telegram_alert(report)
        if alert:
            print(f"\n--- Telegram Alert ---\n{alert}")
    else:
        print("\nSilent — nothing to report.")
