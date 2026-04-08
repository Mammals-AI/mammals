#!/usr/bin/env python3
"""
Proactive Intelligence Engine for Mammals.

Evaluates triggers and surfaces relevant info before Gino asks.
Integrates with: CoinGecko (crypto prices), heartbeat (system health),
knowledge graph (project status), tacit knowledge (timing preferences).

Trigger types:
- price: Crypto price thresholds (above/below target)
- time: Time-based triggers (e.g., morning briefing context)
- condition: System conditions (disk full, task failed, etc.)
- pattern: Behavioral pattern triggers (suggest based on time of day + habits)

Runs on a schedule (every 15 min) and outputs actionable notifications.
"""

import json
import os
import sqlite3
import subprocess
import time
from datetime import datetime, timedelta
from pathlib import Path

DB_PATH = Path.home() / "claudeclaw" / "store" / "claudeclaw.db"


def get_conn():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


# ─── Trigger Management ───

def create_trigger(name, trigger_type, config, action, cooldown_minutes=60):
    """Create a new proactive trigger."""
    conn = get_conn()
    now = int(time.time())
    try:
        conn.execute(
            "INSERT INTO proactive_triggers (name, trigger_type, config, action, cooldown_minutes, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (name, trigger_type, json.dumps(config), action, cooldown_minutes, now),
        )
        conn.commit()
        print(f"  + Trigger: {name} [{trigger_type}]")
        return True
    except sqlite3.IntegrityError:
        print(f"  ~ Trigger exists: {name}")
        return False
    finally:
        conn.close()


def list_triggers():
    """List all triggers."""
    conn = get_conn()
    rows = conn.execute("SELECT * FROM proactive_triggers ORDER BY name").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def delete_trigger(name):
    """Delete a trigger."""
    conn = get_conn()
    conn.execute("DELETE FROM proactive_triggers WHERE name = ?", (name,))
    conn.commit()
    conn.close()


# ─── Trigger Evaluators ───

def eval_price_trigger(config):
    """Evaluate a crypto price trigger using CoinGecko MCP or API."""
    coin = config.get("coin", "bitcoin")
    target = config.get("target")
    direction = config.get("direction", "above")  # "above" or "below"

    if not target:
        return None

    # Try to get price via simple curl to CoinGecko API
    try:
        result = subprocess.run(
            ["curl", "-s", "-4", f"https://api.coingecko.com/api/v3/simple/price?ids={coin}&vs_currencies=usd"],
            capture_output=True, text=True, timeout=10,
        )
        data = json.loads(result.stdout)
        price = data.get(coin, {}).get("usd")
        if price is None:
            return None

        if direction == "above" and price >= target:
            return f"💰 {coin.title()} is ${price:,.2f} — hit your ${target:,.2f} target!"
        elif direction == "below" and price <= target:
            return f"📉 {coin.title()} dropped to ${price:,.2f} — below your ${target:,.2f} alert"
    except Exception:
        pass

    return None


def eval_time_trigger(config):
    """Evaluate a time-based trigger."""
    now = datetime.now()
    target_hour = config.get("hour")
    target_minute = config.get("minute", 0)
    window_minutes = config.get("window", 15)  # +/- window

    if target_hour is None:
        return None

    target = now.replace(hour=target_hour, minute=target_minute, second=0, microsecond=0)
    diff_minutes = abs((now - target).total_seconds()) / 60

    if diff_minutes <= window_minutes:
        return config.get("message", "Time trigger fired")

    return None


def eval_condition_trigger(config):
    """Evaluate a system condition trigger."""
    check_type = config.get("check")

    if check_type == "disk_usage":
        try:
            result = subprocess.run(["df", "-h", "/"], capture_output=True, text=True, timeout=5)
            lines = result.stdout.strip().split("\n")
            if len(lines) >= 2:
                percent = int(lines[1].split()[4].replace("%", ""))
                threshold = config.get("threshold", 85)
                if percent >= threshold:
                    return f"💾 Disk is {percent}% full"
        except Exception:
            pass

    elif check_type == "service_down":
        port = config.get("port")
        name = config.get("service_name", f"port {port}")
        try:
            result = subprocess.run(
                ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-4",
                 f"http://127.0.0.1:{port}/", "--connect-timeout", "3"],
                capture_output=True, text=True, timeout=6,
            )
            if result.stdout.strip() in ("000", ""):
                return f"🔴 {name} appears to be down"
        except Exception:
            return f"🔴 {name} appears to be down"

    elif check_type == "host_ping":
        host = config.get("host")
        name = config.get("service_name", host)
        try:
            result = subprocess.run(
                ["ping", "-c", "1", "-W", "3", host],
                capture_output=True, text=True, timeout=6,
            )
            if result.returncode != 0:
                return f"🔴 {name} ({host}) is unreachable"
        except Exception:
            return f"🔴 {name} ({host}) is unreachable"

    elif check_type == "web_health":
        url = config.get("url")
        name = config.get("service_name", url)
        try:
            result = subprocess.run(
                ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-4",
                 "-L", url, "--connect-timeout", "10"],
                capture_output=True, text=True, timeout=15,
            )
            code = result.stdout.strip()
            if code in ("000", "") or (code.isdigit() and int(code) >= 500):
                return f"🔴 {name} returned HTTP {code}"
        except Exception:
            return f"🔴 {name} is unreachable"

    elif check_type == "timemachine":
        try:
            result = subprocess.run(
                ["tmutil", "latestbackup"],
                capture_output=True, text=True, timeout=10,
            )
            if result.returncode != 0:
                return "⚠️ Time Machine: no backups found"
            latest = result.stdout.strip()
            # Parse date from backup path (format: .../YYYY-MM-DD-HHMMSS.backup)
            backup_name = latest.split("/")[-1].replace(".backup", "")
            parts = backup_name.split("-")
            if len(parts) >= 4:
                backup_time = datetime(int(parts[0]), int(parts[1]), int(parts[2]),
                                       int(parts[3][:2]), int(parts[3][2:4]))
                hours_ago = (datetime.now() - backup_time).total_seconds() / 3600
                threshold = config.get("max_hours", 48)
                if hours_ago > threshold:
                    return f"⚠️ Time Machine: last backup was {int(hours_ago)} hours ago"
        except Exception:
            pass

    elif check_type == "chrome_cdp":
        port = config.get("port", 9222)
        try:
            result = subprocess.run(
                ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-4",
                 f"http://localhost:{port}/json/version", "--connect-timeout", "3"],
                capture_output=True, text=True, timeout=6,
            )
            if result.stdout.strip() != "200":
                # Try to fix it automatically
                fix_script = Path.home() / "claudeclaw" / "scripts" / "ensure-chrome.sh"
                if fix_script.exists():
                    subprocess.run(["bash", str(fix_script)], capture_output=True, timeout=30)
                    # Re-check
                    result2 = subprocess.run(
                        ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "-4",
                         f"http://localhost:{port}/json/version", "--connect-timeout", "3"],
                        capture_output=True, text=True, timeout=6,
                    )
                    if result2.stdout.strip() == "200":
                        return None  # Fixed it, no need to alert
                return "🔴 Chrome CDP is down — browser tools unavailable"
        except Exception:
            return "🔴 Chrome CDP is down — browser tools unavailable"

    elif check_type == "git_stale":
        scan_dir = config.get("scan_dir", str(Path.home()))
        max_hours = config.get("max_hours", 48)
        stale = []
        try:
            home = Path(scan_dir)
            for d in home.iterdir():
                git_dir = d / ".git"
                if not git_dir.exists() or not d.is_dir():
                    continue
                # Check for uncommitted changes
                result = subprocess.run(
                    ["git", "-C", str(d), "status", "--porcelain"],
                    capture_output=True, text=True, timeout=5,
                )
                changes = result.stdout.strip()
                if not changes:
                    continue
                # Check how old the changes are (most recent modified file)
                result2 = subprocess.run(
                    ["git", "-C", str(d), "diff", "--stat"],
                    capture_output=True, text=True, timeout=5,
                )
                # Use the directory's mtime as a rough proxy
                try:
                    mtime = max(
                        (d / f).stat().st_mtime
                        for f in changes.split("\n")
                        if f.strip() and (d / f.strip().split()[-1]).exists()
                    )
                    hours = (time.time() - mtime) / 3600
                    if hours > max_hours:
                        stale.append(f"{d.name} ({int(hours)}h)")
                except Exception:
                    # If we can't stat, just flag it has uncommitted work
                    stale.append(d.name)
            if stale:
                return f"📂 Uncommitted work sitting in: {', '.join(stale[:5])}"
        except Exception:
            pass

    return None


def eval_pattern_trigger(config):
    """Evaluate a behavioral pattern trigger — suggest based on habits."""
    now = datetime.now()
    hour = now.hour

    # Check tacit patterns for current time context
    conn = get_conn()
    try:
        patterns = conn.execute(
            "SELECT * FROM tacit_patterns WHERE pattern_type = 'time_preference' AND confidence >= 0.6"
        ).fetchall()
    except Exception:
        patterns = []
    conn.close()

    topic = config.get("topic")
    if not topic:
        return None

    for p in patterns:
        desc = p["description"].lower()
        if topic.lower() in desc:
            # Check if current time matches the pattern's peak
            if "morning" in desc and 6 <= hour <= 10:
                return config.get("morning_message")
            elif "afternoon" in desc and 12 <= hour <= 16:
                return config.get("afternoon_message")
            elif "evening" in desc and 17 <= hour <= 21:
                return config.get("evening_message")

    return None


def eval_opportunity_trigger(config):
    """Evaluate an opportunity trigger — detect positive signals worth acting on."""
    opp_type = config.get("type")

    if opp_type == "price_move":
        # Detect significant price movements (volatility = trading opportunity)
        coin = config.get("coin", "bitcoin")
        move_pct = config.get("move_percent", 5)  # minimum % move to trigger
        try:
            result = subprocess.run(
                ["curl", "-s", "-4",
                 f"https://api.coingecko.com/api/v3/simple/price?ids={coin}&vs_currencies=usd&include_24hr_change=true"],
                capture_output=True, text=True, timeout=10,
            )
            data = json.loads(result.stdout)
            change = data.get(coin, {}).get("usd_24h_change")
            price = data.get(coin, {}).get("usd")
            if change is not None and abs(change) >= move_pct:
                direction = "up" if change > 0 else "down"
                return f"{coin.title()} moved {direction} {abs(change):.1f}% in 24h (${price:,.2f}) — potential trading opportunity"
        except Exception:
            pass

    elif opp_type == "gumroad_sale":
        # Check for new Gumroad sales via API
        try:
            from dotenv import load_dotenv
            load_dotenv(Path.home() / "claudeclaw" / ".env")
            token = os.environ.get("GUMROAD_ACCESS_TOKEN")
            if not token:
                return None
            result = subprocess.run(
                ["curl", "-s", "-4",
                 f"https://api.gumroad.com/v2/sales?access_token={token}"],
                capture_output=True, text=True, timeout=10,
            )
            data = json.loads(result.stdout)
            sales = data.get("sales", [])
            if sales:
                # Check for sales in the last 4 hours
                cutoff = time.time() - (4 * 3600)
                recent = [s for s in sales
                          if datetime.fromisoformat(s.get("created_at", "2000-01-01T00:00:00").replace("Z", "+00:00")).timestamp() > cutoff]
                if recent:
                    total = sum(float(s.get("price", 0)) / 100 for s in recent)
                    return f"New Gumroad sale(s): {len(recent)} sale(s) for ${total:.2f} in the last 4 hours"
        except Exception:
            pass

    elif opp_type == "trending_topic":
        # Check if any of Gino's content topics are trending
        keywords = config.get("keywords", [])
        if not keywords:
            return None
        # Use a simple Google Trends proxy — check if search volume spiked
        # For now, just check CoinGecko trending for crypto topics
        try:
            result = subprocess.run(
                ["curl", "-s", "-4",
                 "https://api.coingecko.com/api/v3/search/trending"],
                capture_output=True, text=True, timeout=10,
            )
            data = json.loads(result.stdout)
            trending_coins = [c["item"]["id"] for c in data.get("coins", [])]
            matches = [kw for kw in keywords if kw.lower() in trending_coins]
            if matches:
                return f"Trending now: {', '.join(matches)} — content/trading opportunity"
        except Exception:
            pass

    elif opp_type == "site_ranking":
        # Pull real GSC data for ranking opportunities
        try:
            import sys
            scripts_dir = str(Path.home() / "claudeclaw" / "scripts")
            if scripts_dir not in sys.path:
                sys.path.insert(0, scripts_dir)

            import importlib.util
            spec = importlib.util.spec_from_file_location(
                "gsc_report", str(Path.home() / "claudeclaw" / "scripts" / "gsc-report.py"))
            gsc = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(gsc)

            service = gsc.get_service()
            end = datetime.now().strftime('%Y-%m-%d')
            start = (datetime.now() - timedelta(days=30)).strftime('%Y-%m-%d')

            queries = service.searchanalytics().query(siteUrl=gsc.SITE, body={
                'startDate': start, 'endDate': end,
                'dimensions': ['query'], 'rowLimit': 10,
                'orderBy': [{'fieldName': 'impressions', 'sortOrder': 'DESCENDING'}]
            }).execute().get('rows', [])

            # Find page 2 opportunities (position 11-20 with decent impressions)
            opportunities = [q for q in queries if 10 < q['position'] <= 20 and q['impressions'] >= 50]
            if opportunities:
                top = opportunities[0]
                return (f"SEO opportunity: '{top['keys'][0]}' ranks at position {top['position']:.1f} "
                       f"with {top['impressions']} impressions — push to page 1 for traffic")

            # Also check for new page 1 rankings (celebrate wins)
            new_p1 = [q for q in queries if q['position'] <= 5 and q['clicks'] >= 10]
            if new_p1:
                top = new_p1[0]
                return (f"SEO win: '{top['keys'][0]}' is position {top['position']:.1f} "
                       f"with {top['clicks']} clicks — capitalize on this ranking")
        except Exception:
            pass

    elif opp_type == "traffic_spike":
        # Check GSC for unusual traffic increases
        try:
            import sys
            scripts_dir = str(Path.home() / "claudeclaw" / "scripts")
            if scripts_dir not in sys.path:
                sys.path.insert(0, scripts_dir)

            import importlib.util
            spec = importlib.util.spec_from_file_location(
                "gsc_report", str(Path.home() / "claudeclaw" / "scripts" / "gsc-report.py"))
            gsc = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(gsc)

            service = gsc.get_service()

            # Compare last 7 days vs previous 7 days
            end = datetime.now().strftime('%Y-%m-%d')
            mid = (datetime.now() - timedelta(days=7)).strftime('%Y-%m-%d')
            start = (datetime.now() - timedelta(days=14)).strftime('%Y-%m-%d')

            recent = service.searchanalytics().query(siteUrl=gsc.SITE, body={
                'startDate': mid, 'endDate': end, 'dimensions': ['date']
            }).execute().get('rows', [])
            prev = service.searchanalytics().query(siteUrl=gsc.SITE, body={
                'startDate': start, 'endDate': mid, 'dimensions': ['date']
            }).execute().get('rows', [])

            recent_clicks = sum(r['clicks'] for r in recent)
            prev_clicks = sum(r['clicks'] for r in prev) or 1
            change_pct = ((recent_clicks - prev_clicks) / prev_clicks) * 100

            threshold = config.get("threshold_pct", 30)
            if change_pct >= threshold:
                return f"Traffic spike: SHU clicks up {change_pct:.0f}% week-over-week ({recent_clicks} vs {prev_clicks})"
        except Exception:
            pass

    return None


EVALUATORS = {
    "price": eval_price_trigger,
    "time": eval_time_trigger,
    "condition": eval_condition_trigger,
    "pattern": eval_pattern_trigger,
    "opportunity": eval_opportunity_trigger,
}


# ─── Main Engine ───

def evaluate_triggers():
    """Evaluate all enabled triggers and return notifications."""
    conn = get_conn()
    now = int(time.time())

    triggers = conn.execute(
        "SELECT * FROM proactive_triggers WHERE enabled = 1"
    ).fetchall()

    notifications = []

    for t in triggers:
        # Check cooldown
        last_fired = t["last_fired"] or 0
        cooldown_secs = (t["cooldown_minutes"] or 60) * 60
        if now - last_fired < cooldown_secs:
            continue

        config = json.loads(t["config"])
        evaluator = EVALUATORS.get(t["trigger_type"])

        if not evaluator:
            continue

        result = evaluator(config)
        if result:
            notifications.append({
                "trigger_name": t["name"],
                "message": result,
                "action": t["action"],
            })
            # Update last checked/fired
            conn.execute(
                "UPDATE proactive_triggers SET last_checked = ?, last_fired = ? WHERE id = ?",
                (now, now, t["id"]),
            )
        else:
            # Just update last checked
            conn.execute(
                "UPDATE proactive_triggers SET last_checked = ? WHERE id = ?",
                (now, t["id"]),
            )

    conn.commit()
    conn.close()
    return notifications


def seed_default_triggers():
    """Create sensible default triggers for service/system monitoring."""
    print("\n=== Seeding Default Proactive Triggers ===\n")

    # --- Service Health ---
    create_trigger(
        "disk-watch", "condition",
        {"check": "disk_usage", "threshold": 85},
        "notify", cooldown_minutes=120,
    )
    create_trigger(
        "crypto-bot-down", "condition",
        {"check": "service_down", "port": 5051, "service_name": "Crypto Bot"},
        "notify", cooldown_minutes=30,
    )
    create_trigger(
        "solar-dashboard-down", "condition",
        {"check": "service_down", "port": 5050, "service_name": "Solar Dashboard"},
        "notify", cooldown_minutes=30,
    )
    create_trigger(
        "monitor-down", "condition",
        {"check": "service_down", "port": 5065, "service_name": "Monitor Dashboard"},
        "notify", cooldown_minutes=60,
    )

    # --- Network / External ---
    create_trigger(
        "solar-assistant-down", "condition",
        {"check": "host_ping", "host": "192.168.1.252", "service_name": "Solar Assistant"},
        "notify", cooldown_minutes=60,
    )
    create_trigger(
        "shu-site-down", "condition",
        {"check": "web_health", "url": "https://smarthomeunlocked.com", "service_name": "Smart Home Unlocked"},
        "notify", cooldown_minutes=60,
    )

    # --- Backup ---
    create_trigger(
        "timemachine-stale", "condition",
        {"check": "timemachine", "max_hours": 48},
        "notify", cooldown_minutes=720,
    )

    # --- Git Staleness ---
    create_trigger(
        "git-stale-work", "condition",
        {"check": "git_stale", "scan_dir": str(Path.home()), "max_hours": 48},
        "notify", cooldown_minutes=720,
    )

    # --- Chrome CDP (auto-heals via ensure-chrome.sh) ---
    create_trigger(
        "chrome-cdp-down", "condition",
        {"check": "chrome_cdp", "port": 9222},
        "notify", cooldown_minutes=30,
    )

    # --- Opportunity Triggers ---
    create_trigger(
        "btc-big-move", "opportunity",
        {"type": "price_move", "coin": "bitcoin", "move_percent": 5},
        "initiative", cooldown_minutes=360,
    )
    create_trigger(
        "bnb-big-move", "opportunity",
        {"type": "price_move", "coin": "binancecoin", "move_percent": 5},
        "initiative", cooldown_minutes=360,
    )
    create_trigger(
        "eth-big-move", "opportunity",
        {"type": "price_move", "coin": "ethereum", "move_percent": 5},
        "initiative", cooldown_minutes=360,
    )
    create_trigger(
        "gumroad-sale", "opportunity",
        {"type": "gumroad_sale"},
        "notify", cooldown_minutes=240,
    )
    create_trigger(
        "crypto-trending", "opportunity",
        {"type": "trending_topic", "keywords": ["bitcoin", "ethereum", "solana", "binancecoin"]},
        "initiative", cooldown_minutes=720,
    )
    create_trigger(
        "shu-seo-opportunity", "opportunity",
        {"type": "site_ranking"},
        "initiative", cooldown_minutes=1440,
    )
    create_trigger(
        "shu-traffic-spike", "opportunity",
        {"type": "traffic_spike", "threshold_pct": 30},
        "notify", cooldown_minutes=1440,
    )

    print(f"\nSeeded {len(list_triggers())} triggers")


def create_initiative_from_trigger(trigger_name, message, config=None):
    """Create an initiative in the initiative engine based on a proactive detection.

    Maps trigger types to goals and creates actionable initiatives.
    """
    try:
        # Import initiative engine functions
        import sys
        scripts_dir = str(Path.home() / "claudeclaw" / "scripts")
        if scripts_dir not in sys.path:
            sys.path.insert(0, scripts_dir)

        import importlib.util
        spec = importlib.util.spec_from_file_location(
            "initiative_engine",
            str(Path.home() / "claudeclaw" / "scripts" / "initiative-engine.py")
        )
        ie = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(ie)

        # Map trigger names to goals
        TRIGGER_GOAL_MAP = {
            "crypto-bot-down": "dc8f0148",      # Maintain system health
            "solar-dashboard-down": "dc8f0148",  # Maintain system health
            "chrome-cdp-down": "dc8f0148",       # Maintain system health
            "monitor-down": "dc8f0148",          # Maintain system health
            "solar-assistant-down": "dc8f0148",  # Maintain system health
            "shu-site-down": "34efb41c",         # Make $100 in revenue
            "disk-watch": "dc8f0148",            # Maintain system health
            # Opportunity triggers
            "btc-big-move": "760ff422",          # Support crypto trading
            "bnb-big-move": "760ff422",          # Support crypto trading
            "eth-big-move": "760ff422",          # Support crypto trading
            "gumroad-sale": "34efb41c",          # Make $100 in revenue
            "crypto-trending": "760ff422",       # Support crypto trading
            "shu-seo-opportunity": "34efb41c",   # Make $100 in revenue
            "shu-traffic-spike": "34efb41c",     # Make $100 in revenue
        }

        goal_id = TRIGGER_GOAL_MAP.get(trigger_name)
        title = f"Auto: {message.replace('🔴 ', '').replace('⚠️ ', '').replace('💾 ', '')}"

        init_id = ie.create_initiative(
            title=title[:100],
            goal_id=goal_id,
            description=f"Auto-created from proactive trigger '{trigger_name}': {message}",
            source="proactive",
        )
        print(f"  Initiative created [{init_id}] from trigger: {trigger_name}")
        return init_id
    except Exception as e:
        print(f"  Failed to create initiative from trigger: {e}")
        return None


def run_proactive():
    """Run the proactive engine and return any notifications."""
    notifications = evaluate_triggers()

    if not notifications:
        return None

    lines = []
    for n in notifications:
        lines.append(n["message"])

        trigger_name = n.get("trigger_name", "")

        # Auto-create initiatives for service/system issues
        if n.get("action") == "notify" and any(kw in trigger_name for kw in ["down", "stale", "watch"]):
            create_initiative_from_trigger(trigger_name, n["message"])

        # Auto-create initiatives for opportunities
        if n.get("action") == "initiative":
            create_initiative_from_trigger(trigger_name, n["message"])

    return "\n".join(lines)


if __name__ == "__main__":
    import sys

    if "--seed" in sys.argv:
        seed_default_triggers()
    elif "--list" in sys.argv:
        triggers = list_triggers()
        print(f"\n=== Proactive Triggers ({len(triggers)}) ===\n")
        for t in triggers:
            config = json.loads(t["config"])
            enabled = "✅" if t["enabled"] else "❌"
            last = datetime.fromtimestamp(t["last_fired"]).strftime("%m/%d %H:%M") if t["last_fired"] else "never"
            print(f"  {enabled} {t['name']} [{t['trigger_type']}] — cooldown: {t['cooldown_minutes']}min, last fired: {last}")
            print(f"      config: {json.dumps(config)}")
    else:
        print("\n=== Proactive Intelligence Check ===\n")
        result = run_proactive()
        if result:
            print(f"Notifications:\n{result}")
        else:
            print("Nothing to report — all quiet.")
