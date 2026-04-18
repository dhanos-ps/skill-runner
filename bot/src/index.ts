import { App } from '@slack/bolt'
import { loadSlackSkills } from './skills'
import { makeCommandHandler } from './handlers/command'
import { handleFileUploaded } from './handlers/file-upload'

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
})

app.event('file_shared', handleFileUploaded)

;(async () => {
  const skills = await loadSlackSkills()

  if (skills.length === 0) {
    console.warn('[bot] no skills with slack config found — bot will not respond to any commands')
  }

  for (const skill of skills) {
    app.command(skill.config.command, makeCommandHandler(skill))
    console.log(`[bot] registered command ${skill.config.command}`)
  }

  await app.start()
  console.log(`[bot] started (socket mode) — ${skills.length} skill command(s) registered`)
})()
