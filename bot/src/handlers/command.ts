import type { Middleware, SlackCommandMiddlewareArgs } from '@slack/bolt'
import { pendingJobs } from '../state'
import type { SkillEntry } from '../skills'

function resolveParams(
  templates: Record<string, string>,
  commandText: string,
  userRealName: string
): Record<string, string> {
  const resolved: Record<string, string> = {}
  for (const [key, template] of Object.entries(templates)) {
    resolved[key] = template
      .replace('{{command_text}}', commandText)
      .replace('{{user_real_name}}', userRealName)
  }
  return resolved
}

export function makeCommandHandler(skill: SkillEntry): Middleware<SlackCommandMiddlewareArgs> {
  const { skillName, config } = skill

  return async ({ command, ack, say, client }) => {
    await ack()

    const commandText = command.text.trim()
    console.log(`[${config.command}] text="${commandText}" channel=${command.channel_id} user=${command.user_id}`)

    if (!commandText) {
      await say({ text: config.empty_text_error })
      return
    }

    // Fetch Slack user's real name for {{user_real_name}} param substitution
    let userRealName = ''
    try {
      const userInfo = await client.users.info({ user: command.user_id })
      userRealName = (userInfo.user as any)?.profile?.real_name ?? (userInfo.user as any)?.real_name ?? ''
    } catch (err) {
      console.warn(`[${config.command}] could not fetch user info: ${err}`)
    }

    const resolvedParams = resolveParams(config.params, commandText, userRealName)

    // Build intro message — substitute {param_name} placeholders with resolved values
    let introText = config.intro_message
    for (const [key, val] of Object.entries(resolvedParams)) {
      introText = introText.replaceAll(`{${key}}`, val)
    }

    const result = await say({ text: introText })
    const threadTs = result.ts as string
    const key = `${command.channel_id}:${threadTs}`

    pendingJobs.set(key, {
      skillName,
      config,
      resolvedParams,
      channelId: command.channel_id,
      threadTs,
      createdAt: Date.now(),
    })

    console.log(`[${config.command}] pending job registered key=${key} skill=${skillName}`)
  }
}
