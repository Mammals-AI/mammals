---
name: system-check
triggers: system check, health check, status, how's the system, diagnostics
description: Run a quick health check on the Mammals system
---

When asked about system health or status, check these things:

1. **Bot process**: Is it running? Check `ps aux | grep 'dist/index.js'`
2. **Database**: Can you read from it? `sqlite3 store/claudeclaw.db "SELECT count(*) FROM sessions;"`
3. **Disk space**: `df -h /` — flag if less than 10% free
4. **Memory**: `vm_stat` or `top -l 1 | head -5`
5. **Active agents**: `sqlite3 store/claudeclaw.db "SELECT name, description FROM agents;"`
6. **Scheduled tasks**: `sqlite3 store/claudeclaw.db "SELECT id, schedule, status FROM scheduled_tasks;"`

Report results concisely. Only flag issues — don't list everything if it's all fine.
