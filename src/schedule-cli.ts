import { initDatabase, createTask, listTasks, deleteTask, pauseTask, resumeTask } from './db.js'
import { computeNextRun } from './scheduler.js'
import { randomUUID } from 'node:crypto'

initDatabase()

const args = process.argv.slice(2)
const cmd = args[0]

function usage() {
  console.log(`Usage:
  schedule-cli create "<prompt>" "<cron>" <chat_id>
  schedule-cli list [chat_id]
  schedule-cli delete <id>
  schedule-cli pause <id>
  schedule-cli resume <id>`)
}

switch (cmd) {
  case 'create': {
    const [, prompt, cron, chatId] = args
    if (!prompt || !cron || !chatId) { usage(); process.exit(1) }
    try {
      const nextRun = computeNextRun(cron)
      const id = randomUUID().slice(0, 8)
      createTask(id, chatId, prompt, cron, nextRun)
      console.log(`Created task ${id} — next run: ${new Date(nextRun * 1000).toLocaleString()}`)
    } catch (err) {
      console.error(`Invalid cron expression: ${err}`)
      process.exit(1)
    }
    break
  }
  case 'list': {
    const tasks = listTasks(args[1])
    if (tasks.length === 0) {
      console.log('No scheduled tasks.')
    } else {
      for (const t of tasks) {
        const next = new Date(t.next_run * 1000).toLocaleString()
        console.log(`[${t.id}] ${t.status.toUpperCase()} | "${t.prompt.slice(0, 60)}" | ${t.schedule} | next: ${next}`)
      }
    }
    break
  }
  case 'delete': {
    if (!args[1]) { usage(); process.exit(1) }
    deleteTask(args[1]) ? console.log('Deleted.') : console.log('Not found.')
    break
  }
  case 'pause': {
    if (!args[1]) { usage(); process.exit(1) }
    pauseTask(args[1])
    console.log('Paused.')
    break
  }
  case 'resume': {
    if (!args[1]) { usage(); process.exit(1) }
    resumeTask(args[1])
    console.log('Resumed.')
    break
  }
  default:
    usage()
}
