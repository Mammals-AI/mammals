#!/usr/bin/env python3
"""Mammals HQ — The pack's dashboard, project tracker, chat, and activity feed."""

from flask import Flask, jsonify, send_file, request, Response, stream_with_context, session
import sqlite3
import os
import json
import time
import threading
import urllib.request
import urllib.error
import urllib.parse
from pathlib import Path
from werkzeug.utils import secure_filename

app = Flask(__name__)
app.secret_key = os.urandom(32)
BOT_API = 'http://localhost:5075'
API_BASE = 'http://127.0.0.1:5062'
DB = os.path.expanduser('~/claudeclaw/store/claudeclaw.db')
UPLOADS_DIR = Path.home() / 'claudeclaw' / 'workspace' / 'uploads'

# ── Load env ────────────────────────────────────────────
env_path = Path.home() / 'claudeclaw' / '.env'
_env = {}
if env_path.exists():
    for _line in env_path.read_text().splitlines():
        if '=' in _line and not _line.startswith('#'):
            _k, _v = _line.split('=', 1)
            _env[_k.strip()] = _v.strip()

PIN = _env.get('PWA_PIN', '')
API_TOKEN = _env.get('CLAUDECLAW_API_TOKEN', '')

# ── Brute-force protection ──────────────────────────────
_fail_lock = threading.Lock()
_fail_counts = {}
MAX_ATTEMPTS = 5
LOCKOUT_SECONDS = 300

def authed():
    if not PIN:
        return True
    return session.get('authenticated') is True

def require_auth(f):
    from functools import wraps
    @wraps(f)
    def wrapped(*args, **kwargs):
        if not authed():
            return jsonify({'error': 'Not authenticated'}), 401
        return f(*args, **kwargs)
    return wrapped

def db():
    c = sqlite3.connect(DB)
    c.row_factory = sqlite3.Row
    return c

def run_migrations():
    """Run schema migrations on startup."""
    c = sqlite3.connect(DB)
    # Add voice_id column to agents if missing
    cols = [r[1] for r in c.execute("PRAGMA table_info(agents)").fetchall()]
    if 'voice_id' not in cols:
        c.execute("ALTER TABLE agents ADD COLUMN voice_id TEXT DEFAULT ''")
        c.commit()
    c.close()

run_migrations()

# ── Auth ────────────────────────────────────────────────

@app.route('/auth', methods=['POST'])
def auth():
    if not PIN:
        session['authenticated'] = True
        session.permanent = True
        return jsonify({'ok': True})
    ip = request.remote_addr or '0.0.0.0'
    with _fail_lock:
        rec = _fail_counts.get(ip, {'count': 0, 'locked_until': 0})
        if rec['locked_until'] > time.time():
            remaining = int(rec['locked_until'] - time.time())
            return jsonify({'error': f'Locked out. Try again in {remaining}s'}), 429
    data = request.get_json(silent=True) or {}
    if data.get('pin') == PIN:
        with _fail_lock:
            _fail_counts.pop(ip, None)
        session['authenticated'] = True
        session.permanent = True
        return jsonify({'ok': True})
    with _fail_lock:
        rec = _fail_counts.get(ip, {'count': 0, 'locked_until': 0})
        rec['count'] += 1
        if rec['count'] >= MAX_ATTEMPTS:
            rec['locked_until'] = time.time() + LOCKOUT_SECONDS
            rec['count'] = 0
        _fail_counts[ip] = rec
    return jsonify({'error': 'Wrong PIN'}), 401

@app.route('/auth/check')
def auth_check():
    return jsonify({'ok': authed(), 'pin_enabled': bool(PIN)})

# ── Static ──────────────────────────────────────────────

@app.route('/')
def index():
    resp = send_file(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'index.html'))
    resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    return resp

@app.route('/tools/pulley')
def pulley_calc():
    return send_file(os.path.expanduser('~/claudeclaw/workspace/pulley-calc.html'))

@app.route('/mammals')
def mammals_landing():
    return send_file(os.path.expanduser('~/claudeclaw/workspace/mammals-landing.html'))

@app.route('/grok-daemon-cropped.mp4')
def mammals_video():
    return send_file(os.path.expanduser('~/claudeclaw/workspace/grok-daemon-cropped.mp4'), mimetype='video/mp4')

@app.route('/manifest.json')
def manifest():
    return send_file(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'manifest.json'),
                     mimetype='application/json')

@app.route('/sw.js')
def service_worker():
    return send_file(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'sw.js'),
                     mimetype='application/javascript')

@app.route('/icon.png')
def icon():
    resp = send_file(os.path.join(AVATAR_DIR, 'daemon.png'), mimetype='image/png')
    resp.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    return resp

# ── Static: Avatars ─────────────────────────────────────

AVATAR_DIR = os.path.join(os.path.expanduser('~/claudeclaw/workspace/pack-hq'), 'avatars')

@app.route('/uploads/<path:filename>')
def serve_upload(filename):
    path = os.path.join(str(UPLOADS_DIR), filename)
    if os.path.exists(path):
        import mimetypes
        mime = mimetypes.guess_type(path)[0] or 'application/octet-stream'
        return send_file(path, mimetype=mime)
    return '', 404

@app.route('/avatars/<name>.png')
def avatar(name):
    path = os.path.join(AVATAR_DIR, f'{name}.png')
    if os.path.exists(path):
        return send_file(path, mimetype='image/png')
    return '', 404

# ── API: Overview stats ─────────────────────────────────

@app.route('/api/overview')
def overview():
    c = db()
    stats = {
        'agents': c.execute('SELECT COUNT(*) FROM agents').fetchone()[0],
        'posts': c.execute('SELECT COUNT(*) FROM packlog_posts').fetchone()[0],
        'goals_active': c.execute("SELECT COUNT(*) FROM goals WHERE status='active'").fetchone()[0],
        'initiatives_total': c.execute('SELECT COUNT(*) FROM initiatives').fetchone()[0],
        'initiatives_done': c.execute("SELECT COUNT(*) FROM initiatives WHERE status='completed'").fetchone()[0],
        'tiktoks': c.execute('SELECT COUNT(*) FROM tiktok_posts').fetchone()[0],
        'work_logs': c.execute('SELECT COUNT(*) FROM agent_work_log').fetchone()[0],
        'kg_entities': c.execute('SELECT COUNT(*) FROM kg_entities').fetchone()[0],
    }
    c.close()
    return jsonify(stats)

# ── API: All agents ─────────────────────────────────────

@app.route('/api/agents')
def agents():
    c = db()
    rows = c.execute('''
        SELECT a.name, a.description, a.bio, a.total_runs, a.last_active,
               a.total_tokens_in, a.total_tokens_out, a.skills_summary,
               COUNT(p.id) as post_count,
               MAX(p.created_at) as last_post
        FROM agents a
        LEFT JOIN packlog_posts p ON p.agent_name = a.name
        GROUP BY a.name
        ORDER BY a.last_active DESC NULLS LAST
    ''').fetchall()
    c.close()
    return jsonify([dict(r) for r in rows])

# ── API: Single agent detail (profile page) ───────────

@app.route('/api/agent/<name>')
def agent_detail(name):
    c = db()
    if name == 'daemon':
        owner = _env.get('BOT_OWNER', 'User')
        agent = {'name': 'daemon', 'description': f"{owner}'s personal AI assistant",
                 'system_prompt': '', 'bio': 'Main bot process running via Claude Code CLI.',
                 'total_runs': 0, 'total_tokens_in': 0, 'total_tokens_out': 0, 'created_at': 0,
                 'voice_id': _env.get('ELEVENLABS_VOICE_ID', '')}
    else:
        row = c.execute('SELECT * FROM agents WHERE name = ?', (name,)).fetchone()
        if not row:
            c.close()
            return jsonify({'error': 'not found'}), 404
        agent = dict(row)
    # Session history
    sessions = c.execute('''
        SELECT id, summary, problems, solutions, task, status, tokens_in, tokens_out, duration_ms, created_at
        FROM agent_sessions WHERE agent_name = ?
        ORDER BY created_at DESC LIMIT 50
    ''', (name,)).fetchall()
    # Recommendations by this agent
    recs = c.execute('''
        SELECT id, title, description, category, severity, status, upvotes, daemon_notes, created_at, resolved_at
        FROM agent_recommendations WHERE agent_name = ?
        ORDER BY created_at DESC LIMIT 30
    ''', (name,)).fetchall()
    # Legacy journal posts
    posts = c.execute('''
        SELECT id, title, body, created_at, entry_type
        FROM packlog_posts WHERE agent_name = ?
        ORDER BY created_at DESC LIMIT 20
    ''', (name,)).fetchall()
    # Recent work log
    work = c.execute('''
        SELECT task, status, result, duration_ms, tokens_in, tokens_out, created_at, completed_at
        FROM agent_work_log WHERE agent_name = ?
        ORDER BY created_at DESC LIMIT 20
    ''', (name,)).fetchall()
    c.close()
    return jsonify({
        'agent': agent if isinstance(agent, dict) else dict(agent),
        'sessions': [dict(r) for r in sessions],
        'recommendations': [dict(r) for r in recs],
        'posts': [dict(r) for r in posts],
        'work_log': [dict(r) for r in work]
    })

# ── API: Agent sessions ───────────────────────────────

@app.route('/api/agent/<name>/sessions', methods=['POST'])
def agent_session_create(name):
    body = request.get_json()
    c = db()
    c.execute('''
        INSERT INTO agent_sessions (agent_name, summary, problems, solutions, task, status, tokens_in, tokens_out, duration_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (
        name, body.get('summary', ''), json.dumps(body.get('problems', [])),
        json.dumps(body.get('solutions', [])), body.get('task', ''),
        body.get('status', 'completed'), body.get('tokens_in', 0), body.get('tokens_out', 0),
        body.get('duration_ms', 0), int(time.time() * 1000)
    ))
    c.commit()
    sid = c.execute('SELECT last_insert_rowid()').fetchone()[0]
    c.close()
    return jsonify({'id': sid}), 201

# ── API: Recommendations ──────────────────────────────

@app.route('/api/recommendations')
def recommendations_list():
    c = db()
    status_filter = request.args.get('status', '')
    where = 'WHERE r.status = ?' if status_filter else ''
    params = [status_filter] if status_filter else []
    rows = c.execute(f'''
        SELECT r.*, a.description as agent_desc
        FROM agent_recommendations r
        LEFT JOIN agents a ON a.name = r.agent_name
        {where}
        ORDER BY
            CASE r.status WHEN 'pending' THEN 0 WHEN 'reviewed' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END,
            r.upvotes DESC, r.created_at DESC
        LIMIT 100
    ''', params).fetchall()
    c.close()
    return jsonify([dict(r) for r in rows])

@app.route('/api/recommendations', methods=['POST'])
def recommendation_create():
    body = request.get_json()
    c = db()
    # Check for duplicate — same agent, same title, still pending
    existing = c.execute(
        "SELECT id, upvotes, upvoted_by FROM agent_recommendations WHERE title = ? AND status = 'pending'",
        (body['title'],)
    ).fetchone()
    if existing:
        # Upvote instead of duplicate
        upvoted = json.loads(existing['upvoted_by'] or '[]')
        agent = body.get('agent_name', 'daemon')
        if agent not in upvoted:
            upvoted.append(agent)
            c.execute('UPDATE agent_recommendations SET upvotes = ?, upvoted_by = ? WHERE id = ?',
                      (existing['upvotes'] + 1, json.dumps(upvoted), existing['id']))
            c.commit()
        c.close()
        return jsonify({'id': existing['id'], 'upvoted': True})
    c.execute('''
        INSERT INTO agent_recommendations (agent_name, session_id, title, description, category, severity, status, upvoted_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    ''', (
        body.get('agent_name', 'daemon'), body.get('session_id'),
        body['title'], body.get('description', ''),
        body.get('category', 'workflow'), body.get('severity', 'minor'),
        json.dumps([body.get('agent_name', 'daemon')]),
        int(time.time() * 1000)
    ))
    c.commit()
    rid = c.execute('SELECT last_insert_rowid()').fetchone()[0]
    c.close()
    return jsonify({'id': rid}), 201

@app.route('/api/recommendations/<int:rec_id>', methods=['PATCH'])
def recommendation_update(rec_id):
    body = request.get_json()
    c = db()
    fields, vals = [], []
    for key in ('status', 'daemon_notes', 'severity', 'category'):
        if key in body:
            fields.append(f'{key} = ?')
            vals.append(body[key])
    if body.get('status') in ('implemented', 'dismissed'):
        fields.append('resolved_at = ?')
        vals.append(int(time.time() * 1000))
    if fields:
        vals.append(rec_id)
        c.execute(f'UPDATE agent_recommendations SET {", ".join(fields)} WHERE id = ?', vals)
        c.commit()
    c.close()
    return jsonify({'ok': True})

# ── API: Recommendation stats ─────────────────────────

@app.route('/api/recommendations/stats')
def recommendation_stats():
    c = db()
    stats = {}
    for status in ('pending', 'reviewed', 'approved', 'implemented', 'dismissed'):
        stats[status] = c.execute('SELECT COUNT(*) FROM agent_recommendations WHERE status = ?', (status,)).fetchone()[0]
    # Top categories
    cats = c.execute('''
        SELECT category, COUNT(*) as cnt FROM agent_recommendations
        WHERE status IN ('pending', 'reviewed', 'approved')
        GROUP BY category ORDER BY cnt DESC
    ''').fetchall()
    c.close()
    return jsonify({'counts': stats, 'categories': [dict(r) for r in cats]})

# ── API: Unified activity feed ──────────────────────────

@app.route('/api/feed')
def feed():
    c = db()
    limit = min(int(request.args.get('limit', 100)), 500)
    offset = int(request.args.get('offset', 0))
    entry_type = request.args.get('type', 'journal')  # default to journal-only
    agent = request.args.get('agent', '')
    conditions = []
    params = []
    if entry_type:
        conditions.append("p.entry_type = ?")
        params.append(entry_type)
    if agent:
        conditions.append("p.agent_name = ?")
        params.append(agent)
    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    rows = c.execute(f'''
        SELECT p.id, p.agent_name, p.title, p.body, p.artifacts, p.created_at,
               p.entry_type, p.tags, a.description as agent_desc
        FROM packlog_posts p
        LEFT JOIN agents a ON a.name = p.agent_name
        {where}
        ORDER BY p.created_at DESC
        LIMIT ? OFFSET ?
    ''', params + [limit, offset]).fetchall()
    count_params = list(params)
    total = c.execute(f'SELECT COUNT(*) FROM packlog_posts p {where}', count_params).fetchone()[0]
    c.close()
    return jsonify({'posts': [dict(r) for r in rows], 'total': total})

@app.route('/api/journal', methods=['POST'])
def journal_post():
    """Post a journal entry. Deduplicates same title+agent within 5 minutes."""
    body = request.get_json()
    agent = body.get('agent_name', 'daemon').strip()
    title = body.get('title', '').strip()
    content = body.get('body', '').strip()
    tags = json.dumps(body.get('tags', []))
    if not title:
        return jsonify({'error': 'title required'}), 400
    c = db()
    import time
    now = int(time.time() * 1000)
    # Deduplicate: skip if same agent+title posted within last 5 minutes
    recent = c.execute(
        'SELECT id FROM packlog_posts WHERE agent_name = ? AND title = ? AND created_at > ?',
        (agent, title, now - 300000)
    ).fetchone()
    if recent:
        c.close()
        return jsonify({'ok': True, 'id': recent[0], 'deduplicated': True})
    c.execute(
        'INSERT INTO packlog_posts (agent_name, title, body, entry_type, tags, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        (agent, title, content, 'journal', tags, now)
    )
    c.commit()
    post_id = c.execute('SELECT last_insert_rowid()').fetchone()[0]
    c.close()
    return jsonify({'ok': True, 'id': post_id})

# ── API: Goals with initiatives ─────────────────────────

@app.route('/api/goals')
def goals():
    c = db()
    rows = c.execute('SELECT * FROM goals ORDER BY priority ASC').fetchall()
    result = []
    for g in rows:
        inits = c.execute('''
            SELECT id, title, status, priority, result, source,
                   created_at, started_at, completed_at, waiting_reason
            FROM initiatives WHERE goal_id = ?
            ORDER BY completed_at DESC NULLS LAST, created_at DESC
        ''', (g['id'],)).fetchall()
        gd = dict(g)
        gd['initiatives'] = [dict(i) for i in inits]
        total = len(inits)
        done = sum(1 for i in inits if i['status'] == 'completed')
        gd['progress'] = round(done / total * 100) if total > 0 else 0
        result.append(gd)
    c.close()
    return jsonify(result)

# ── API: Knowledge graph ────────────────────────────────

@app.route('/api/projects')
def projects():
    c = db()
    entities = c.execute('''
        SELECT * FROM kg_entities ORDER BY category, name
    ''').fetchall()
    relations = c.execute('''
        SELECT r.*, s.name as source_name, s.category as source_cat,
               t.name as target_name, t.category as target_cat
        FROM kg_relations r
        JOIN kg_entities s ON s.id = r.source_id
        JOIN kg_entities t ON t.id = r.target_id
    ''').fetchall()
    c.close()
    return jsonify({
        'entities': [dict(e) for e in entities],
        'relations': [dict(r) for r in relations]
    })

# ── API: TikTok content ────────────────────────────────

@app.route('/api/tiktok')
def tiktok():
    c = db()
    rows = c.execute('''
        SELECT id, concept_hook, caption, video_path, posted_at, status,
               views, likes, comments, shares, tiktok_url
        FROM tiktok_posts
        ORDER BY posted_at DESC
    ''').fetchall()
    c.close()
    return jsonify([dict(r) for r in rows])

# ── API: Initiative outcomes ────────────────────────────

@app.route('/api/outcomes')
def outcomes():
    c = db()
    rows = c.execute('''
        SELECT o.*, i.title as initiative_title, g.title as goal_title
        FROM initiative_outcomes o
        LEFT JOIN initiatives i ON i.id = o.initiative_id
        LEFT JOIN goals g ON g.id = (SELECT goal_id FROM initiatives WHERE id = o.initiative_id)
        ORDER BY o.created_at DESC
    ''').fetchall()
    c.close()
    return jsonify([dict(r) for r in rows])

# ── API: Issues CRUD ────────────────────────────────────

@app.route('/api/issues')
def issues_list():
    c = db()
    rows = c.execute('''
        SELECT * FROM issues ORDER BY
        CASE status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,
        priority ASC, created_at DESC
    ''').fetchall()
    c.close()
    return jsonify([dict(r) for r in rows])

@app.route('/api/issues', methods=['POST'])
def issues_create():
    c = db()
    body = request.get_json()
    c.execute('''
        INSERT INTO issues (title, description, agent_name, priority, created_at)
        VALUES (?, ?, ?, ?, strftime('%s','now') * 1000)
    ''', (body['title'], body.get('description', ''), body.get('agent_name'), body.get('priority', 3)))
    c.commit()
    issue_id = c.execute('SELECT last_insert_rowid()').fetchone()[0]
    c.close()
    return jsonify({'id': issue_id}), 201

@app.route('/api/issues/<int:issue_id>', methods=['PATCH'])
def issues_update(issue_id):
    c = db()
    body = request.get_json()
    fields, vals = [], []
    for key in ('title', 'description', 'agent_name', 'status', 'priority'):
        if key in body:
            fields.append(f'{key} = ?')
            vals.append(body[key])
    if 'status' in body and body['status'] == 'resolved':
        fields.append('resolved_at = strftime(\'%s\',\'now\') * 1000')
    fields.append('updated_at = strftime(\'%s\',\'now\') * 1000')
    vals.append(issue_id)
    c.execute(f'UPDATE issues SET {", ".join(fields)} WHERE id = ?', vals)
    c.commit()
    c.close()
    return jsonify({'ok': True})

@app.route('/api/issues/<int:issue_id>', methods=['DELETE'])
def issues_delete(issue_id):
    c = db()
    c.execute('DELETE FROM issues WHERE id = ?', (issue_id,))
    c.commit()
    c.close()
    return jsonify({'ok': True})

# ── API: Goals CRUD ─────────────────────────────────────

@app.route('/api/goals/<goal_id>', methods=['PATCH'])
def goals_update(goal_id):
    c = db()
    body = request.get_json()
    fields, vals = [], []
    for key in ('title', 'description', 'status', 'priority'):
        if key in body:
            fields.append(f'{key} = ?')
            vals.append(body[key])
    fields.append('updated_at = strftime(\'%s\',\'now\') * 1000')
    vals.append(goal_id)
    c.execute(f'UPDATE goals SET {", ".join(fields)} WHERE id = ?', vals)
    c.commit()
    c.close()
    return jsonify({'ok': True})

@app.route('/api/goals/<goal_id>', methods=['DELETE'])
def goals_delete(goal_id):
    c = db()
    c.execute('DELETE FROM initiatives WHERE goal_id = ?', (goal_id,))
    c.execute('DELETE FROM goals WHERE id = ?', (goal_id,))
    c.commit()
    c.close()
    return jsonify({'ok': True})

@app.route('/api/goals', methods=['POST'])
def goals_create():
    c = db()
    body = request.get_json()
    import uuid
    gid = uuid.uuid4().hex[:8]
    now = int(__import__('time').time() * 1000)
    c.execute('''
        INSERT INTO goals (id, title, description, status, priority, source, created_at, updated_at)
        VALUES (?, ?, ?, 'active', ?, ?, ?, ?)
    ''', (gid, body['title'], body.get('description', ''), body.get('priority', 3), body.get('source', _env.get('BOT_OWNER', 'user')), now, now))
    c.commit()
    c.close()
    return jsonify({'id': gid}), 201

# ── API: Conversation history ──────────────────────────

@app.route('/api/history/<agent>')
def chat_history(agent):
    limit = int(request.args.get('limit', 80))
    since = request.args.get('since')
    try:
        conn = sqlite3.connect(DB)
        conn.row_factory = sqlite3.Row
        if agent == 'daemon':
            base = "SELECT role, content, source, created_at FROM conversations WHERE source IN ('telegram','dashboard','voice')"
            if since:
                rows = conn.execute(base + " AND created_at > ? ORDER BY created_at DESC LIMIT ?", (int(since), limit)).fetchall()
            else:
                rows = conn.execute(base + " ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
        elif agent == 'claude':
            base = "SELECT role, content, source, created_at FROM conversations WHERE source = 'claude-raw'"
            if since:
                rows = conn.execute(base + " AND created_at > ? ORDER BY created_at DESC LIMIT ?", (int(since), limit)).fetchall()
            else:
                rows = conn.execute(base + " ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
        else:
            base = "SELECT role, content, source, created_at FROM conversations WHERE source = ?"
            if since:
                rows = conn.execute(base + " AND created_at > ? ORDER BY created_at DESC LIMIT ?", (f'agent:{agent}', int(since), limit)).fetchall()
            else:
                rows = conn.execute(base + " ORDER BY created_at DESC LIMIT ?", (f'agent:{agent}', limit)).fetchall()
        conn.close()
        msgs = [{'role': r['role'], 'content': r['content'],
                 'source': r['source'], 'ts': r['created_at']}
                for r in reversed(rows)]
        return jsonify(msgs)
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ── API: Commands ──────────────────────────────────────

@app.route('/api/command/restart', methods=['POST'])
def command_restart():
    """Restart the ClaudeClaw bot via launchd. Safe — Mammals HQ is a separate process."""
    import subprocess
    try:
        subprocess.Popen(['launchctl', 'kickstart', '-k', 'gui/' + str(os.getuid()) + '/com.claudeclaw.bot'])
        return jsonify({'ok': True, 'message': 'Restart triggered'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ── API: Daemon config ─────────────────────────────────

CLAUDE_MD = os.path.expanduser('~/claudeclaw/CLAUDE.md')

@app.route('/api/daemon/config', methods=['GET'])
def daemon_config_get():
    """Read the daemon's CLAUDE.md as its system prompt."""
    try:
        with open(CLAUDE_MD, 'r') as f:
            content = f.read()
        return jsonify({
            'description': 'Main assistant',
            'system_prompt': content,
            'bio': f"{_env.get('BOT_OWNER', 'Your')} personal AI assistant.",
            'voice_id': _env.get('ELEVENLABS_VOICE_ID', '')
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/daemon/config', methods=['POST'])
def daemon_config_save():
    """Save updates to the daemon's CLAUDE.md and voice."""
    body = request.get_json()
    # Handle voice_id update (writes to .env)
    if 'voice_id' in body:
        new_vid = body['voice_id'].strip()
        try:
            lines = env_path.read_text().splitlines() if env_path.exists() else []
            found = False
            for i, line in enumerate(lines):
                if line.startswith('ELEVENLABS_VOICE_ID='):
                    lines[i] = f'ELEVENLABS_VOICE_ID={new_vid}'
                    found = True
                    break
            if not found:
                lines.append(f'ELEVENLABS_VOICE_ID={new_vid}')
            env_path.write_text('\n'.join(lines) + '\n')
            _env['ELEVENLABS_VOICE_ID'] = new_vid
        except Exception as e:
            return jsonify({'error': f'Failed to save voice: {e}'}), 500
        if len(body) == 1:
            return jsonify({'ok': True, 'message': 'Voice updated'})
    prompt = body.get('system_prompt', '').strip()
    if not prompt:
        return jsonify({'ok': True, 'message': 'No changes'})
    try:
        with open(CLAUDE_MD, 'w') as f:
            f.write(prompt)
        return jsonify({'ok': True, 'message': 'CLAUDE.md updated'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ── API: Chat send ─────────────────────────────────────

@app.route('/api/chat/send', methods=['POST'])
def chat_send():
    body = request.get_json()
    message = body.get('message', '').strip()
    target = body.get('target', 'daemon')
    if not message:
        return jsonify({'error': 'empty message'}), 400
    try:
        headers = {'Content-Type': 'application/json'}
        if API_TOKEN:
            headers['Authorization'] = f'Bearer {API_TOKEN}'
        payload = json.dumps({'message': message}).encode()
        if target == 'daemon':
            url = f'{API_BASE}/api/daemon/send'
        elif target == 'claude':
            url = f'{API_BASE}/api/claude/send'
        else:
            url = f'{API_BASE}/api/agents/{urllib.parse.quote(target)}/send'
        req_obj = urllib.request.Request(url, data=payload, headers=headers)
        with urllib.request.urlopen(req_obj, timeout=8) as r:
            return jsonify(json.loads(r.read()))
    except Exception as e:
        return jsonify({'error': str(e)}), 502

# ── API: File upload ───────────────────────────────────

@app.route('/api/upload', methods=['POST'])
def upload_file():
    if 'file' not in request.files:
        return jsonify({'error': 'No file'}), 400
    f = request.files['file']
    target = request.form.get('target', '')
    caption = request.form.get('caption', '')
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    safe_name = secure_filename(f.filename or 'upload')
    local_path = UPLOADS_DIR / f'{int(time.time() * 1000)}_{safe_name}'
    f.save(str(local_path))
    mime = f.content_type or ''
    if mime.startswith('image/'):
        msg = f'[Photo attached: {local_path}]\nPlease analyze this image.'
    elif mime.startswith('video/'):
        msg = f'[Video attached: {local_path}]\nPlease analyze this video.'
    else:
        msg = f'[Document attached: {local_path} ({safe_name})]\nPlease read and analyze this document.'
    if caption:
        msg += f'\n{caption}'
    headers_out = {'Content-Type': 'application/json'}
    if API_TOKEN:
        headers_out['Authorization'] = f'Bearer {API_TOKEN}'
    url = f'{API_BASE}/api/agents/{target}/send' if target else f'{API_BASE}/api/daemon/send'
    try:
        req_obj = urllib.request.Request(url, data=json.dumps({'message': msg}).encode(), headers=headers_out)
        with urllib.request.urlopen(req_obj, timeout=10) as r:
            return jsonify(json.loads(r.read()))
    except Exception as e:
        return jsonify({'error': str(e)}), 502

# ── API: Agent update (proxy to dashboard 5075) ─────────

@app.route('/api/agent/<name>/update', methods=['PUT'])
def agent_update(name):
    body = request.get_json()
    # Handle voice_id locally (direct DB update)
    if 'voice_id' in body:
        c = db()
        c.execute("UPDATE agents SET voice_id = ? WHERE name = ?", (body['voice_id'], name))
        c.commit()
        c.close()
        if len(body) == 1:
            return jsonify({'ok': True})
        body = {k: v for k, v in body.items() if k != 'voice_id'}
    # Handle description, system_prompt, bio locally too
    if body:
        c = db()
        for field in ('description', 'system_prompt', 'bio'):
            if field in body:
                c.execute(f"UPDATE agents SET {field} = ? WHERE name = ?", (body[field], name))
        c.commit()
        c.close()
    return jsonify({'ok': True})

# ── Voice settings ─────────────────────────────────────

@app.route('/api/voice/config')
def voice_config_get():
    """Get current voice/TTS configuration."""
    return jsonify({
        'tts_engine': _env.get('TTS_ENGINE', 'voxtral'),
        'voxtral_voice': _env.get('VOXTRAL_VOICE', 'casual_male'),
        'voxtral_temperature': _env.get('VOXTRAL_TEMPERATURE', '0.8'),
        'voxtral_top_k': _env.get('VOXTRAL_TOP_K', '50'),
        'voxtral_top_p': _env.get('VOXTRAL_TOP_P', '0.95'),
        'elevenlabs_voice_id': _env.get('ELEVENLABS_VOICE_ID', ''),
    })

@app.route('/api/voice/config', methods=['POST'])
def voice_config_save():
    """Update voice/TTS configuration in .env."""
    body = request.get_json()
    key_map = {
        'tts_engine': 'TTS_ENGINE',
        'voxtral_voice': 'VOXTRAL_VOICE',
        'voxtral_temperature': 'VOXTRAL_TEMPERATURE',
        'voxtral_top_k': 'VOXTRAL_TOP_K',
        'voxtral_top_p': 'VOXTRAL_TOP_P',
        'elevenlabs_voice_id': 'ELEVENLABS_VOICE_ID',
    }
    try:
        lines = env_path.read_text().splitlines() if env_path.exists() else []
        for field, env_key in key_map.items():
            if field not in body:
                continue
            val = str(body[field]).strip()
            found = False
            for i, line in enumerate(lines):
                if line.startswith(env_key + '='):
                    lines[i] = f'{env_key}={val}'
                    found = True
                    break
            if not found:
                lines.append(f'{env_key}={val}')
            _env[env_key] = val
        env_path.write_text('\n'.join(lines) + '\n')
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/voice/voices')
def voice_list():
    """List available ElevenLabs voices."""
    api_key = _env.get('ELEVENLABS_API_KEY', '')
    if not api_key:
        return jsonify({'voices': [], 'error': 'ELEVENLABS_API_KEY not configured'})
    try:
        req_obj = urllib.request.Request(
            'https://api.elevenlabs.io/v1/voices',
            headers={'xi-api-key': api_key}
        )
        with urllib.request.urlopen(req_obj, timeout=10) as r:
            data = json.loads(r.read())
        voices = [{'voice_id': v['voice_id'], 'name': v['name'],
                    'category': v.get('category', ''),
                    'labels': v.get('labels', {})}
                   for v in data.get('voices', [])]
        voices.sort(key=lambda v: v['name'])
        return jsonify({'voices': voices})
    except Exception as e:
        return jsonify({'voices': [], 'error': str(e)})

@app.route('/api/voice/preview', methods=['POST'])
def voice_preview():
    """Preview a voice with sample text."""
    body = request.get_json()
    voice_id = body.get('voice_id', '')
    agent_name = body.get('agent', '')
    text = body.get('text', 'Hey, this is what I sound like.')[:5000]
    api_key = _env.get('ELEVENLABS_API_KEY', '')
    # Look up agent's voice if no explicit voice_id
    if not voice_id and agent_name:
        try:
            c = db()
            row = c.execute('SELECT voice_id FROM agents WHERE name = ?', (agent_name,)).fetchone()
            if row and row['voice_id']:
                voice_id = row['voice_id']
            c.close()
        except:
            pass
    # Fall back to default voice
    if not voice_id:
        voice_id = _env.get('ELEVENLABS_VOICE_ID', '')
    if not api_key or not voice_id:
        return jsonify({'error': 'Missing API key or voice_id'}), 400
    try:
        payload = json.dumps({
            'text': text,
            'model_id': 'eleven_turbo_v2_5',
            'voice_settings': {'stability': 0.5, 'similarity_boost': 0.75}
        }).encode()
        req_obj = urllib.request.Request(
            f'https://api.elevenlabs.io/v1/text-to-speech/{voice_id}',
            data=payload, method='POST',
            headers={'xi-api-key': api_key, 'Content-Type': 'application/json'}
        )
        with urllib.request.urlopen(req_obj, timeout=15) as r:
            audio = r.read()
        return Response(audio, mimetype='audio/mpeg',
                        headers={'Content-Length': str(len(audio))})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/generation/config')
def generation_config_get():
    """Get image/video generation preferences."""
    return jsonify({
        'image_engine': _env.get('IMAGE_ENGINE', 'gemini'),
        'video_engine': _env.get('VIDEO_ENGINE', 'veo3'),
    })

@app.route('/api/generation/config', methods=['POST'])
def generation_config_save():
    """Save image/video generation preferences."""
    body = request.get_json()
    key_map = {
        'image_engine': 'IMAGE_ENGINE',
        'video_engine': 'VIDEO_ENGINE',
    }
    try:
        lines = env_path.read_text().splitlines() if env_path.exists() else []
        for field, env_key in key_map.items():
            if field not in body:
                continue
            val = str(body[field]).strip()
            found = False
            for i, line in enumerate(lines):
                if line.startswith(env_key + '='):
                    lines[i] = f'{env_key}={val}'
                    found = True
                    break
            if not found:
                lines.append(f'{env_key}={val}')
            _env[env_key] = val
        env_path.write_text('\n'.join(lines) + '\n')
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/voice/voxtral-voices')
def voxtral_voices():
    """List available Voxtral voices from local server."""
    try:
        with urllib.request.urlopen('http://localhost:5090/voices', timeout=5) as r:
            return jsonify(json.loads(r.read()))
    except Exception as e:
        return jsonify({'voices': [], 'error': str(e)})

@app.route('/api/voice/voxtral-preview', methods=['POST'])
def voxtral_preview():
    """Preview a Voxtral voice with sample text."""
    body = request.get_json()
    voice = body.get('voice', 'casual_male')
    text = body.get('text', 'Hey, this is what I sound like.')[:500]
    temperature = body.get('temperature', 0.8)
    top_k = body.get('top_k', 50)
    top_p = body.get('top_p', 0.95)
    try:
        params = urllib.parse.urlencode({
            'text': text, 'voice': voice,
            'temperature': temperature, 'top_k': top_k, 'top_p': top_p
        })
        with urllib.request.urlopen(f'http://localhost:5090/tts?{params}', timeout=30) as r:
            audio = r.read()
        return Response(audio, mimetype='audio/wav',
                        headers={'Content-Length': str(len(audio))})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── Bot API Proxies (from 5075) ─────────────────────────

def bot_get(path):
    try:
        with urllib.request.urlopen(f'{BOT_API}/{path}', timeout=5) as r:
            return json.loads(r.read())
    except Exception as e:
        return {'error': str(e)}

@app.route('/api/bot/system')
def bot_system():
    return jsonify(bot_get('api/system'))

@app.route('/api/bot/tasks')
def bot_tasks():
    return jsonify(bot_get('api/tasks'))

@app.route('/api/bot/memories')
def bot_memories():
    limit = request.args.get('limit', '20')
    return jsonify(bot_get(f'api/memories?limit={limit}'))

@app.route('/api/bot/stream')
def bot_stream():
    """Proxy the SSE stream from the bot dashboard."""
    def generate():
        while True:
            try:
                req = urllib.request.Request(f'{BOT_API}/api/stream')
                resp = urllib.request.urlopen(req, timeout=600)
                while True:
                    line = resp.readline()
                    if not line:
                        break
                    yield line
                resp.close()
            except Exception:
                yield b': reconnecting\n\n'
                time.sleep(1)
    return Response(stream_with_context(generate()),
                    mimetype='text/event-stream',
                    headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no',
                             'Connection': 'keep-alive'})

# ── API: Settings ──────────────────────────────────────

MODEL_CONFIG = os.path.expanduser('~/claudeclaw/store/model-config.json')
PERF_CONFIG = os.path.expanduser('~/claudeclaw/store/performance-config.json')

@app.route('/api/settings')
def settings_get():
    """Get all settings: model config, ports, skills."""
    # Model config
    model = {'model': 'opus', 'effort': 'high'}
    try:
        with open(MODEL_CONFIG, 'r') as f:
            model = json.load(f)
    except Exception:
        pass
    # Skill stats
    skills = []
    try:
        conn = sqlite3.connect(DB)
        conn.row_factory = sqlite3.Row
        skills = [dict(r) for r in conn.execute(
            'SELECT name, category, times_used, last_used FROM skills ORDER BY category, name'
        ).fetchall()]
        conn.close()
    except Exception:
        pass
    # Scheduled tasks
    tasks = []
    try:
        conn = sqlite3.connect(DB)
        conn.row_factory = sqlite3.Row
        tasks = [dict(r) for r in conn.execute(
            "SELECT id, prompt, schedule, status, last_result FROM scheduled_tasks ORDER BY status, id"
        ).fetchall()]
        conn.close()
    except Exception:
        pass
    # Performance config
    performance = {}
    try:
        with open(PERF_CONFIG, 'r') as f:
            performance = json.load(f)
    except Exception:
        pass

    return jsonify({
        'model': model,
        'performance': performance,
        'skills': skills,
        'tasks': tasks,
        'ports': {
            5062: 'HTTP API',
            5067: 'Mammals HQ',
            5075: 'Command Center',
            5090: 'Voxtral TTS',
        }
    })

# ── API: Usage stats (scraped from claude.ai/settings/usage via CDP) ──

import datetime
import subprocess

CLAUDE_USAGE_FILE = os.path.expanduser('~/claudeclaw/store/claude_usage.json')
SCRAPER_SCRIPT = os.path.expanduser('~/claudeclaw/scripts/scrape_claude_usage.py')
_usage_cache = {'data': None, 'ts': 0}
USAGE_CACHE_TTL = 300  # 5 minutes

def _get_claude_usage():
    """Read scraped Claude usage data. Re-scrape if stale (>5 min)."""
    now = time.time()
    # Check if cached data is fresh enough
    if _usage_cache['data'] and (now - _usage_cache['ts']) < USAGE_CACHE_TTL:
        return _usage_cache['data']

    # Check if file exists and is fresh
    try:
        mtime = os.path.getmtime(CLAUDE_USAGE_FILE)
        if now - mtime > USAGE_CACHE_TTL:
            # Stale — kick off a background re-scrape
            subprocess.Popen(
                ['/usr/bin/python3', SCRAPER_SCRIPT],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            )
        with open(CLAUDE_USAGE_FILE) as f:
            data = json.load(f)
        _usage_cache['data'] = data
        _usage_cache['ts'] = now
        return data
    except (FileNotFoundError, json.JSONDecodeError):
        # No file yet — run scraper synchronously (first time only)
        try:
            subprocess.run(
                ['/usr/bin/python3', SCRAPER_SCRIPT],
                timeout=15, capture_output=True
            )
            with open(CLAUDE_USAGE_FILE) as f:
                data = json.load(f)
            _usage_cache['data'] = data
            _usage_cache['ts'] = now
            return data
        except Exception:
            return None

@app.route('/api/usage')
def usage_stats():
    """Usage stats from Claude website + agent stats from DB."""
    c = db()
    today_start = int(datetime.datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)
    week_start = int((time.time() - 7 * 86400) * 1000)

    agent_today = c.execute('''
        SELECT COALESCE(SUM(tokens_in),0) as t_in, COALESCE(SUM(tokens_out),0) as t_out, COUNT(*) as runs
        FROM agent_work_log WHERE created_at >= ?
    ''', (today_start,)).fetchone()

    agent_week = c.execute('''
        SELECT COALESCE(SUM(tokens_in),0) as t_in, COALESCE(SUM(tokens_out),0) as t_out, COUNT(*) as runs
        FROM agent_work_log WHERE created_at >= ?
    ''', (week_start,)).fetchone()

    daemon_msgs = c.execute('SELECT COUNT(*) FROM conversations WHERE created_at >= ?', (today_start,)).fetchone()[0]
    c.close()

    claude = _get_claude_usage()

    return jsonify({
        'session': {
            'pct': claude['session']['pct'] if claude else None,
            'resets_in': claude['session']['resets_in'] if claude else None,
        },
        'weekly_all': {
            'pct': claude['weekly_all']['pct'] if claude else None,
            'resets': claude['weekly_all']['resets'] if claude else None,
        },
        'weekly_sonnet': {
            'pct': claude['weekly_sonnet']['pct'] if claude else None,
            'resets': claude['weekly_sonnet']['resets'] if claude else None,
        },
        'extra_usage': {
            'spent': claude['extra_usage']['spent'] if claude else None,
        },
        'agents': {
            'today_in': agent_today['t_in'], 'today_out': agent_today['t_out'], 'today_runs': agent_today['runs'],
            'week_in': agent_week['t_in'], 'week_out': agent_week['t_out'], 'week_runs': agent_week['runs'],
        },
        'daemon_messages_today': daemon_msgs,
        'scraped_at': claude.get('updated_at') if claude else None,
    })

# ── API: Active ports ─────────────────────────────────

import socket

KNOWN_PORTS = [
    {'port': 5062, 'name': 'HTTP API', 'path': ''},
    {'port': 5067, 'name': 'Mammals HQ', 'path': ''},
    {'port': 5075, 'name': 'Command Center', 'path': ''},
    {'port': 5090, 'name': 'Voxtral TTS', 'path': ''},
]

def _get_tailscale_ip():
    """Detect Tailscale IP dynamically."""
    try:
        out = subprocess.check_output(['tailscale', 'ip', '-4'], timeout=3, text=True).strip()
        return out.split('\n')[0] if out else '127.0.0.1'
    except Exception:
        return '127.0.0.1'

TAILSCALE_IP = _env.get('TAILSCALE_IP', _get_tailscale_ip())
_ports_cache = {'data': None, 'ts': 0}

@app.route('/api/ports')
def active_ports():
    """Check which known ports are listening and return with Tailscale links."""
    now = time.time()
    if _ports_cache['data'] and (now - _ports_cache['ts']) < 30:
        return jsonify(_ports_cache['data'])

    results = []
    for svc in KNOWN_PORTS:
        up = False
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(0.3)
            s.connect(('127.0.0.1', svc['port']))
            s.close()
            up = True
        except Exception:
            pass
        results.append({
            'port': svc['port'],
            'name': svc['name'],
            'url': f'http://{TAILSCALE_IP}:{svc["port"]}{svc["path"]}',
            'up': up,
        })

    # Also check for any project dev servers (common Astro/Vite ports)
    dev_ports = [
        {'port': 4321, 'name': 'Astro Dev'},
        {'port': 3000, 'name': 'Dev Server'},
    ]
    for svc in dev_ports:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(0.3)
            s.connect(('127.0.0.1', svc['port']))
            s.close()
            results.append({
                'port': svc['port'],
                'name': svc['name'],
                'url': f'http://{TAILSCALE_IP}:{svc["port"]}',
                'up': True,
            })
        except Exception:
            pass

    _ports_cache['data'] = results
    _ports_cache['ts'] = now
    return jsonify(results)

# ── API: Recent links from conversations ──────────────

@app.route('/api/links')
def recent_links():
    """Extract URLs and file paths from recent daemon conversations."""
    c = db()
    limit = int(request.args.get('limit', 200))
    rows = c.execute('''
        SELECT content, created_at, source FROM conversations
        WHERE role = 'assistant'
        ORDER BY created_at DESC LIMIT ?
    ''', (limit,)).fetchall()
    # Also grab links from agent work results
    agent_rows = c.execute('''
        SELECT result as content, created_at, agent_name as source FROM agent_work_log
        WHERE result IS NOT NULL
        ORDER BY created_at DESC LIMIT 100
    ''').fetchall()
    c.close()
    rows = list(rows) + list(agent_rows)

    import re
    url_re = re.compile(r'https?://[^\s<>\"\')]+')
    file_re = re.compile(r'(?:~/|/Users/)[^\s<>\"\')]+\.\w+')
    seen = set()
    links = []
    files = []

    for row in rows:
        text = row['content'] or ''
        ts = row['created_at']
        for url in url_re.findall(text):
            url = url.rstrip('.,;:*)')
            if url not in seen and 'localhost' not in url and '127.0.0.1' not in url and TAILSCALE_IP not in url:
                seen.add(url)
                links.append({'url': url, 'ts': ts})
        for fp in file_re.findall(text):
            fp = fp.rstrip('.,;:')
            if fp not in seen:
                seen.add(fp)
                files.append({'path': fp, 'ts': ts})

    return jsonify({'links': links[:20], 'files': files[:10]})

@app.route('/api/settings/model', methods=['POST'])
def settings_model():
    """Update model config (legacy — also updates performance chat config)."""
    body = request.get_json()
    model = body.get('model', '').strip()
    effort = body.get('effort', '').strip()
    if model not in ('opus', 'sonnet', 'haiku'):
        return jsonify({'error': 'Invalid model'}), 400
    if effort not in ('low', 'medium', 'high'):
        return jsonify({'error': 'Invalid effort'}), 400
    config = {'model': model, 'effort': effort}
    try:
        with open(MODEL_CONFIG, 'w') as f:
            json.dump(config, f, indent=2)
        return jsonify({'ok': True, **config})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/settings/performance', methods=['POST'])
@require_auth
def settings_performance():
    """Update performance / model routing config."""
    body = request.get_json(silent=True) or {}
    valid_models = ('opus', 'sonnet', 'haiku')
    valid_efforts = ('low', 'medium', 'high')

    config = {}
    for category in ('chat', 'agents', 'background'):
        cat = body.get(category, {})
        config[category] = {
            'model': cat.get('model', 'sonnet') if cat.get('model') in valid_models else 'sonnet',
            'effort': cat.get('effort', 'medium') if cat.get('effort') in valid_efforts else 'medium'
        }

    offpeak = body.get('offpeak', {})
    config['offpeak'] = {
        'enabled': bool(offpeak.get('enabled')),
        'peak_start': max(0, min(23, int(offpeak.get('peak_start', 9)))),
        'peak_end': max(0, min(23, int(offpeak.get('peak_end', 21)))),
        'peak_model': offpeak.get('peak_model', 'sonnet') if offpeak.get('peak_model') in valid_models else 'sonnet'
    }

    # Per-agent model overrides
    overrides = body.get('agent_overrides', {})
    config['agent_overrides'] = {
        name: model for name, model in overrides.items()
        if isinstance(model, str) and model in valid_models
    }

    try:
        with open(PERF_CONFIG, 'w') as f:
            json.dump(config, f, indent=2)
        # Also update legacy model-config.json with chat settings
        with open(MODEL_CONFIG, 'w') as f:
            json.dump(config['chat'], f, indent=2)
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/settings/task', methods=['POST'])
@require_auth
def settings_task():
    """Update a scheduled task's schedule or status."""
    body = request.get_json(silent=True) or {}
    task_id = body.get('id')
    if not task_id:
        return jsonify({'ok': False, 'error': 'Missing task ID'}), 400

    try:
        conn = sqlite3.connect(DB)
        if 'schedule' in body:
            conn.execute('UPDATE scheduled_tasks SET schedule = ? WHERE id = ?', (body['schedule'], task_id))
        if 'status' in body:
            if body['status'] not in ('active', 'paused'):
                return jsonify({'ok': False, 'error': 'Invalid status'}), 400
            conn.execute('UPDATE scheduled_tasks SET status = ? WHERE id = ?', (body['status'], task_id))
        conn.commit()
        conn.close()
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500

@app.route('/api/settings/pin', methods=['POST'])
@require_auth
def settings_pin():
    """Update or disable HQ PIN."""
    global PIN
    body = request.get_json(silent=True) or {}
    new_pin = (body.get('pin') or '').strip()

    # Update .env file
    env_file = os.path.join(os.path.expanduser('~/claudeclaw'), '.env')
    lines = []
    if os.path.exists(env_file):
        with open(env_file) as f:
            lines = [l for l in f.read().splitlines() if not l.startswith('PWA_PIN=')]

    if new_pin:
        lines.append(f'PWA_PIN={new_pin}')

    with open(env_file, 'w') as f:
        f.write('\n'.join(lines) + '\n')

    PIN = new_pin
    return jsonify({'ok': True, 'pin_enabled': bool(new_pin)})

# ── Setup Wizard ───────────────────────────────────────

PROJECT_ROOT = os.path.expanduser('~/claudeclaw')

@app.route('/setup')
def setup_page():
    return send_file(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'setup.html'))

@app.route('/setup/open-terminal', methods=['POST'])
def setup_open_terminal():
    """Open Terminal.app on the user's Mac."""
    import subprocess
    try:
        subprocess.Popen(['open', '-a', 'Terminal'])
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)})

@app.route('/setup/add-to-dock', methods=['POST'])
def setup_add_to_dock():
    """Add Mammals HQ to the macOS Dock as a URL tile."""
    import subprocess
    try:
        # Determine the best URL (Tailscale if available, otherwise localhost)
        url = 'http://localhost:5067'
        try:
            ts = subprocess.check_output(['tailscale', 'status', '--json'], stderr=subprocess.DEVNULL, text=True, timeout=5)
            data = json.loads(ts)
            ip = data.get('Self', {}).get('TailscaleIPs', [None])[0]
            if ip:
                url = f'http://{ip}:5067'
        except Exception:
            pass

        # Add URL tile to the right side of the Dock
        tile = (
            '<dict>'
            '<key>tile-data</key><dict>'
            '<key>label</key><string>Mammals HQ</string>'
            f'<key>url</key><dict><key>_CFURLString</key><string>{url}</string>'
            '<key>_CFURLStringType</key><integer>15</integer></dict>'
            '</dict>'
            '<key>tile-type</key><string>url-tile</string>'
            '</dict>'
        )
        subprocess.run(
            ['defaults', 'write', 'com.apple.dock', 'persistent-others', '-array-add', tile],
            check=True
        )
        subprocess.run(['killall', 'Dock'], check=True)
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)})

@app.route('/setup/config')
def setup_config():
    """Return current .env config (values masked)."""
    env_file = os.path.join(PROJECT_ROOT, '.env')
    cfg = {}
    if os.path.exists(env_file):
        for line in open(env_file).read().splitlines():
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            if '=' in line:
                k, v = line.split('=', 1)
                cfg[k.strip()] = v.strip()
    return jsonify({'config': cfg})

@app.route('/setup/check')
def setup_check():
    """Check system requirements."""
    import subprocess
    checks = []

    # Node
    try:
        nv = subprocess.check_output(['node', '-v'], stderr=subprocess.DEVNULL, text=True).strip()
        major = int(nv.lstrip('v').split('.')[0])
        checks.append({'label': f'Node.js {nv}', 'ok': major >= 20, 'warn': major < 20})
    except Exception:
        checks.append({'label': 'Node.js — not found', 'ok': False})

    # Python
    try:
        pv = subprocess.check_output(['python3', '--version'], stderr=subprocess.DEVNULL, text=True).strip()
        checks.append({'label': pv, 'ok': True})
    except Exception:
        checks.append({'label': 'Python 3 — not found', 'ok': False})

    # Flask
    try:
        import flask
        checks.append({'label': f'Flask {flask.__version__}', 'ok': True})
    except Exception:
        checks.append({'label': 'Flask — not installed', 'ok': False, 'warn': True})

    # SQLite
    try:
        subprocess.check_output(['sqlite3', '--version'], stderr=subprocess.DEVNULL, text=True)
        checks.append({'label': 'SQLite3', 'ok': True})
    except Exception:
        checks.append({'label': 'SQLite3 — not found', 'ok': False, 'warn': True})

    # Claude CLI
    try:
        cv = subprocess.check_output(['claude', '--version'], stderr=subprocess.DEVNULL, text=True, timeout=10).strip()
        checks.append({'label': f'Claude Code CLI ({cv})', 'ok': True})
    except Exception:
        checks.append({'label': 'Claude Code CLI — not found', 'ok': False})

    # Git
    try:
        subprocess.check_output(['git', '--version'], stderr=subprocess.DEVNULL, text=True)
        checks.append({'label': 'Git', 'ok': True})
    except Exception:
        checks.append({'label': 'Git — not found', 'ok': False, 'warn': True})

    return jsonify({'checks': checks})

@app.route('/setup/check-claude')
def setup_check_claude():
    import subprocess
    result = {'installed': False, 'authed': False, 'version': ''}
    try:
        cv = subprocess.check_output(['claude', '--version'], stderr=subprocess.DEVNULL, text=True, timeout=10).strip()
        result['installed'] = True
        result['version'] = cv
        try:
            auth_out = subprocess.check_output(['claude', 'auth', 'status'], stderr=subprocess.DEVNULL, text=True, timeout=10)
            auth_data = json.loads(auth_out)
            if auth_data.get('loggedIn'):
                result['authed'] = True
        except Exception:
            pass
    except Exception:
        pass
    return jsonify(result)

@app.route('/setup/check-tailscale')
def setup_check_tailscale():
    import subprocess
    try:
        ts = subprocess.check_output(['tailscale', 'status', '--json'], stderr=subprocess.DEVNULL, text=True, timeout=5)
        data = json.loads(ts)
        ip = data.get('Self', {}).get('TailscaleIPs', [None])[0]
        if ip:
            return jsonify({'connected': True, 'ip': ip})
    except Exception:
        pass
    return jsonify({'connected': False})

@app.route('/setup/save', methods=['POST'])
def setup_save():
    """Save configuration to .env and generate CLAUDE.md."""
    data = request.get_json(silent=True) or {}
    cfg = data.get('config', {})
    if not cfg.get('BOT_OWNER'):
        return jsonify({'ok': False, 'error': 'Name is required'})

    # Write .env
    env_file = os.path.join(PROJECT_ROOT, '.env')
    lines = []
    for k, v in cfg.items():
        if v:
            lines.append(f'{k}={v}')
    try:
        with open(env_file, 'w') as f:
            f.write('\n'.join(lines) + '\n')
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)})

    # Generate CLAUDE.md from template
    dist = os.path.join(PROJECT_ROOT, 'CLAUDE.md.dist')
    claude_md = os.path.join(PROJECT_ROOT, 'CLAUDE.md')
    if os.path.exists(dist) and not os.path.exists(claude_md):
        try:
            template = open(dist).read()
            personalized = template.replace('{{BOT_OWNER}}', cfg.get('BOT_OWNER', 'User'))
            with open(claude_md, 'w') as f:
                f.write(personalized)
        except Exception:
            pass

    # Reload env for this process
    global PIN
    PIN = cfg.get('PWA_PIN', '') or ''

    return jsonify({'ok': True})

@app.route('/setup/build', methods=['POST'])
def setup_build():
    """Build TypeScript."""
    import subprocess
    try:
        subprocess.check_output(['npm', 'run', 'build'], cwd=PROJECT_ROOT, stderr=subprocess.STDOUT, text=True, timeout=60)
        return jsonify({'ok': True})
    except subprocess.CalledProcessError as e:
        return jsonify({'ok': False, 'error': e.output[:500]})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)})

@app.route('/setup/install-service', methods=['POST'])
def setup_install_service():
    """Install launchd service."""
    import subprocess
    try:
        node_path = subprocess.check_output(['which', 'node'], text=True).strip()
        plist_name = 'com.mammals.bot'
        plist_path = os.path.expanduser(f'~/Library/LaunchAgents/{plist_name}.plist')
        dist_js = os.path.join(PROJECT_ROOT, 'dist', 'index.js')
        node_dir = os.path.dirname(node_path)

        plist = f'''<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{plist_name}</string>
  <key>ProgramArguments</key><array><string>{node_path}</string><string>{dist_js}</string></array>
  <key>WorkingDirectory</key><string>{PROJECT_ROOT}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>/tmp/mammals.log</string>
  <key>StandardErrorPath</key><string>/tmp/mammals.log</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:{node_dir}</string>
  </dict>
</dict>
</plist>'''

        with open(plist_path, 'w') as f:
            f.write(plist)

        subprocess.run(['launchctl', 'unload', plist_path], stderr=subprocess.DEVNULL, check=False)
        subprocess.check_call(['launchctl', 'load', plist_path])
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)})

@app.route('/setup/ask', methods=['POST'])
def setup_ask():
    """Help chat agent — answers questions about Mammals using Claude CLI."""
    import subprocess
    data = request.get_json() or {}
    question = (data.get('question') or '').strip()
    if not question:
        return jsonify({'answer': 'Please ask a question.'})

    system_prompt = """You are a setup help agent for Mammals, a personal AI agent system that runs on macOS.
Answer the user's question concisely (2-4 sentences max). Be friendly and direct.

What Mammals is:
- A personal AI agent system that runs on your Mac
- Powered by Claude Code (Anthropic's CLI coding agent)
- Includes HQ dashboard (web UI on port 5067), optional Telegram bot, optional Tailscale remote access
- Can be extended with custom agents, skills, and automations

Requirements:
- macOS (Apple Silicon or Intel)
- Node.js 20+, Python 3, Claude Code CLI with active subscription
- Optional: Telegram bot token (for messaging), Tailscale (for remote access)

Setup steps:
1. System Check — verifies Node, Python, Git, SQLite are installed
2. Claude Code — checks CLI is installed and authenticated (run 'claude login' if needed)
3. Identity — set your name and a PIN for the HQ dashboard
4. Build & Launch — saves config, builds TypeScript, installs background service via launchd

After setup:
- HQ dashboard available at http://localhost:5067
- If Tailscale is set up, accessible from any device on your Tailscale network
- Bot runs in background via launchd (auto-starts on login)
- Logs at /tmp/mammals.log

Troubleshooting:
- Claude not found: install with 'npm install -g @anthropic-ai/claude-code'
- Claude not authenticated: run 'claude login' in Terminal
- Node too old: run 'brew upgrade node'
- Build fails: check that npm install completed, try running 'npm run build' manually
- Service won't start: check /tmp/mammals.log for errors
- Port 5067 in use: another process is using it, find with 'lsof -i :5067'

macOS security:
- Gatekeeper may prompt when running downloaded software — click Open
- Firewall: no changes needed for local use; allow incoming connections if using Tailscale
- Tailscale installs a VPN configuration — you'll need to approve it in System Settings > VPN

If you don't know the answer, say so honestly."""

    try:
        result = subprocess.run(
            ['claude', '-p', '--system-prompt', system_prompt, '--max-turns', '1', question],
            capture_output=True, text=True, timeout=30
        )
        answer = result.stdout.strip()
        if not answer:
            answer = result.stderr.strip() or 'No response from Claude. Make sure Claude Code is installed and authenticated.'
        return jsonify({'answer': answer})
    except subprocess.TimeoutExpired:
        return jsonify({'answer': 'Claude took too long to respond. Try a simpler question.'})
    except FileNotFoundError:
        return jsonify({'answer': 'Claude Code CLI not found. Install it first, then come back to chat.'})
    except Exception as e:
        return jsonify({'answer': f'Error: {str(e)}'})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5067, debug=False)
