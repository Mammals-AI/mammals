---
name: focus-board
triggers: focus, prioritize, priority, ideas, tasks, overwhelmed, todo, backlog, what should
description: Focus board task management system
---
the user has a Focus Board system for managing ideas and tasks:
- Agent: "focus" — send ideas/tasks to this agent
- Dashboard: http://localhost:5062/focus
- Data: ~/claudeclaw/workspace/focus-board.json
- Usage: dump ideas to the focus agent, it prioritizes and suggests top 3 for today
- Designed for ADD — keeps it to 3 focus items, avoids decision paralysis
- If the user asks what to work on, suggest checking the focus board or sending to the focus agent
