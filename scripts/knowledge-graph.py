#!/usr/bin/env python3
"""
Knowledge Graph Engine — PARA Method for Mammals.

PARA = Projects, Areas, Resources, Archive
- Projects: Active work with a deadline or goal (service-b, notion templates, etc.)
- Areas: Ongoing responsibilities with no end date (solar setup, trading, home lab)
- Resources: Reference material and tools (MCP servers, APIs, scripts)
- Archive: Completed or inactive items

The graph connects entities with typed relations and attaches facts.
Can be queried by the bot, updated by consolidation, and browsed in Mission Control.
"""

import json
import sqlite3
import subprocess
import sys
from datetime import datetime
from pathlib import Path

DB_PATH = Path.home() / "claudeclaw" / "store" / "claudeclaw.db"


def get_conn():
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


# ─── Entity CRUD ───

def add_entity(name, category, description=None, metadata=None):
    """Add a node to the knowledge graph."""
    conn = get_conn()
    now = int(datetime.now().timestamp())
    meta_json = json.dumps(metadata) if metadata else None
    try:
        conn.execute(
            "INSERT INTO kg_entities (name, category, description, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (name, category, description, meta_json, now, now),
        )
        conn.commit()
        print(f"  + Entity: {name} [{category}]")
        return True
    except sqlite3.IntegrityError:
        print(f"  ~ Entity already exists: {name}")
        return False
    finally:
        conn.close()


def update_entity(name, description=None, category=None, metadata=None):
    """Update an existing entity."""
    conn = get_conn()
    now = int(datetime.now().timestamp())
    updates = ["updated_at = ?"]
    params = [now]

    if description is not None:
        updates.append("description = ?")
        params.append(description)
    if category is not None:
        updates.append("category = ?")
        params.append(category)
    if metadata is not None:
        updates.append("metadata = ?")
        params.append(json.dumps(metadata))

    params.append(name)
    conn.execute(f"UPDATE kg_entities SET {', '.join(updates)} WHERE name = ?", params)
    conn.commit()
    conn.close()


def archive_entity(name):
    """Move an entity to archive."""
    update_entity(name, category="archive")
    print(f"  → Archived: {name}")


def get_entity(name):
    """Get a single entity by name."""
    conn = get_conn()
    row = conn.execute("SELECT * FROM kg_entities WHERE name = ?", (name,)).fetchone()
    conn.close()
    return dict(row) if row else None


def list_entities(category=None):
    """List entities, optionally filtered by PARA category."""
    conn = get_conn()
    if category:
        rows = conn.execute(
            "SELECT * FROM kg_entities WHERE category = ? ORDER BY name", (category,)
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM kg_entities ORDER BY category, name"
        ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ─── Relation CRUD ───

def add_relation(source_name, target_name, relation_type, strength=1.0):
    """Add a typed edge between two entities."""
    conn = get_conn()
    now = int(datetime.now().timestamp())

    source = conn.execute("SELECT id FROM kg_entities WHERE name = ?", (source_name,)).fetchone()
    target = conn.execute("SELECT id FROM kg_entities WHERE name = ?", (target_name,)).fetchone()

    if not source or not target:
        print(f"  ! Missing entity: {source_name if not source else target_name}")
        conn.close()
        return False

    try:
        conn.execute(
            "INSERT INTO kg_relations (source_id, target_id, relation_type, strength, created_at) VALUES (?, ?, ?, ?, ?)",
            (source["id"], target["id"], relation_type, strength, now),
        )
        conn.commit()
        print(f"  + Relation: {source_name} --[{relation_type}]--> {target_name}")
        return True
    except sqlite3.IntegrityError:
        # Update strength if relation exists
        conn.execute(
            "UPDATE kg_relations SET strength = MIN(strength + 0.2, 5.0) WHERE source_id = ? AND target_id = ? AND relation_type = ?",
            (source["id"], target["id"], relation_type),
        )
        conn.commit()
        print(f"  ~ Strengthened: {source_name} --[{relation_type}]--> {target_name}")
        return True
    finally:
        conn.close()


def get_connections(name, depth=1):
    """Get all entities connected to the named entity (up to N hops)."""
    conn = get_conn()
    entity = conn.execute("SELECT id FROM kg_entities WHERE name = ?", (name,)).fetchone()
    if not entity:
        conn.close()
        return []

    visited = set()
    result = []
    frontier = [entity["id"]]

    for d in range(depth):
        next_frontier = []
        for eid in frontier:
            if eid in visited:
                continue
            visited.add(eid)

            # Outgoing relations
            rows = conn.execute("""
                SELECT e.name, e.category, r.relation_type, r.strength, 'outgoing' as direction
                FROM kg_relations r JOIN kg_entities e ON e.id = r.target_id
                WHERE r.source_id = ?
            """, (eid,)).fetchall()

            # Incoming relations
            rows += conn.execute("""
                SELECT e.name, e.category, r.relation_type, r.strength, 'incoming' as direction
                FROM kg_relations r JOIN kg_entities e ON e.id = r.source_id
                WHERE r.target_id = ?
            """, (eid,)).fetchall()

            for r in rows:
                result.append({**dict(r), "depth": d + 1})
                target_id = conn.execute("SELECT id FROM kg_entities WHERE name = ?", (r["name"],)).fetchone()
                if target_id:
                    next_frontier.append(target_id["id"])

        frontier = next_frontier

    conn.close()
    return result


# ─── Fact CRUD ───

def add_fact(entity_name, fact, source=None, confidence=1.0):
    """Attach a fact to an entity."""
    conn = get_conn()
    now = int(datetime.now().timestamp())

    entity = conn.execute("SELECT id FROM kg_entities WHERE name = ?", (entity_name,)).fetchone()
    if not entity:
        print(f"  ! Entity not found: {entity_name}")
        conn.close()
        return False

    conn.execute(
        "INSERT INTO kg_facts (entity_id, fact, confidence, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        (entity["id"], fact, confidence, source, now, now),
    )
    conn.commit()
    conn.close()
    print(f"  + Fact on {entity_name}: {fact[:60]}")
    return True


def get_facts(entity_name):
    """Get all facts for an entity."""
    conn = get_conn()
    entity = conn.execute("SELECT id FROM kg_entities WHERE name = ?", (entity_name,)).fetchone()
    if not entity:
        conn.close()
        return []

    rows = conn.execute(
        "SELECT * FROM kg_facts WHERE entity_id = ? ORDER BY confidence DESC", (entity["id"],)
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ─── Graph Summary ───

def graph_summary():
    """Get a full summary of the knowledge graph."""
    conn = get_conn()

    categories = {}
    for cat in ["project", "area", "resource", "archive"]:
        rows = conn.execute(
            "SELECT name, description FROM kg_entities WHERE category = ? ORDER BY name", (cat,)
        ).fetchall()
        categories[cat] = [dict(r) for r in rows]

    relation_count = conn.execute("SELECT COUNT(*) as c FROM kg_relations").fetchone()["c"]
    fact_count = conn.execute("SELECT COUNT(*) as c FROM kg_facts").fetchone()["c"]
    entity_count = conn.execute("SELECT COUNT(*) as c FROM kg_entities").fetchone()["c"]

    conn.close()
    return {
        "entities": entity_count,
        "relations": relation_count,
        "facts": fact_count,
        "categories": categories,
    }


# ─── Seed with User's existing knowledge ───

def seed_initial_graph():
    """Populate the knowledge graph with known entities from User's setup."""
    print("\n=== Seeding Knowledge Graph ===\n")

    # PROJECTS (active work with goals)
    projects = [
        ("claudeclaw", "Telegram AI assistant — the bot itself", {"port": 5075, "path": "~/claudeclaw/"}),
        ("service-b", "Automated crypto trading bot on Exchange", {"port": 5051, "path": "~/service-b/"}),
        ("notion-templates", "Notion template marketplace business", {"status": "submitted to marketplace"}),
    ]

    # AREAS (ongoing, no end date)
    areas = [
        ("trading", "Crypto trading and portfolio management", None),
        ("ai-tools", "AI tools, MCPs, and automation", None),
        ("home-infrastructure", "Mac Mini, Tailscale, network setup", None),
        ("content-creation", "Media creation with AI tools", None),
    ]

    # RESOURCES (reference material and tools)
    resources = [
        ("exchange", "Crypto exchange — API via ccxt", {"type": "exchange"}),
        ("coingecko-mcp", "CoinGecko MCP for crypto data", {"type": "mcp"}),
        ("duckdb-mcp", "DuckDB MCP for SQL queries on local data", {"type": "mcp"}),
        ("notion-mcp", "Notion MCP for workspace access", {"type": "mcp"}),
        ("canva-mcp", "Canva MCP for design creation", {"type": "mcp"}),
        ("puppeteer-mcp", "Headless browser automation", {"type": "mcp"}),
        ("gemini-api", "Google AI Studio — image generation", {"type": "api"}),
        ("elevenlabs", "ElevenLabs TTS for voice messages", {"type": "api"}),
        ("solar-assistant", "Solar monitoring at 192.168.1.252", {"type": "device"}),
        ("mac-mini", "Apple Silicon Mac Mini — primary server", {"type": "hardware"}),
    ]

    print("Projects:")
    for name, desc, meta in projects:
        add_entity(name, "project", desc, meta)

    print("\nAreas:")
    for name, desc, meta in areas:
        add_entity(name, "area", desc, meta)

    print("\nResources:")
    for name, desc, meta in resources:
        add_entity(name, "resource", desc, meta)

    # Relations
    print("\nRelations:")
    add_relation("service-b", "exchange", "uses")
    add_relation("service-b", "trading", "part_of")
    add_relation("claudeclaw", "notion-mcp", "uses")
    add_relation("claudeclaw", "canva-mcp", "uses")
    add_relation("claudeclaw", "puppeteer-mcp", "uses")
    add_relation("claudeclaw", "coingecko-mcp", "uses")
    add_relation("claudeclaw", "duckdb-mcp", "uses")
    add_relation("claudeclaw", "elevenlabs", "uses")
    add_relation("claudeclaw", "gemini-api", "uses")
    add_relation("claudeclaw", "mac-mini", "runs_on")
    add_relation("notion-templates", "notion-mcp", "uses")
    add_relation("notion-templates", "canva-mcp", "uses")
    add_relation("content-creation", "gemini-api", "uses")
    add_relation("content-creation", "canva-mcp", "uses")
    add_relation("trading", "coingecko-mcp", "uses")
    add_relation("trading", "exchange", "uses")
    add_relation("ai-tools", "claudeclaw", "includes")
    add_relation("home-infrastructure", "mac-mini", "includes")
    add_relation("home-infrastructure", "solar-assistant", "includes")

    # Key facts
    print("\nFacts:")
    add_fact("claudeclaw", "Runs as persistent Claude Code session via launchd", "system")
    add_fact("claudeclaw", "Has 15 named agents: wolf, fox, bull, coyote, ferret, hound, jaguar, lynx, mink, mole, otter, panther, rabbit, badger, bison", "system")
    add_fact("claudeclaw", "Memory system: SQLite with semantic/episodic sectors, FTS5, salience decay", "system")
    add_fact("claudeclaw", "Brain V2: knowledge graph, tacit knowledge, proactive intelligence, nightly consolidation", "system")
    add_fact("service-b", "Uses ccxt library, must force IPv4 for Exchange", "system")
    add_fact("service-b", "Has swing bot, dip bot, and grid bot strategies", "system")
    add_fact("notion-templates", "8 templates total, all submitted to Notion Marketplace", "project")
    add_fact("notion-templates", "Marketplace profile: notion.so/@gvarisano", "project")
    add_fact("trading", "User trades crypto", "observation")
    add_fact("mac-mini", "Apple Silicon, runs all services, Tailscale IP: 127.0.0.1", "system")

    summary = graph_summary()
    print(f"\n=== Graph seeded: {summary['entities']} entities, {summary['relations']} relations, {summary['facts']} facts ===")


if __name__ == "__main__":
    if "--seed" in sys.argv:
        seed_initial_graph()
    else:
        s = graph_summary()
        print(f"Knowledge Graph: {s['entities']} entities, {s['relations']} relations, {s['facts']} facts")
        for cat, items in s["categories"].items():
            print(f"\n  {cat.upper()} ({len(items)}):")
            for item in items:
                desc = f" — {item['description']}" if item["description"] else ""
                print(f"    • {item['name']}{desc}")
