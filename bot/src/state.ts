export interface SlackSkillConfig {
  command: string
  empty_text_error: string
  intro_message: string
  workflow: string
  accepts_file: boolean
  output_extension?: string
  params: Record<string, string>  // template vars: {{command_text}}, {{user_real_name}}
}

export interface PendingJob {
  skillName: string
  config: SlackSkillConfig
  resolvedParams: Record<string, string>
  channelId: string
  threadTs: string
  createdAt: number
}

export const pendingJobs = new Map<string, PendingJob>()

// Expire pending jobs after 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000
  for (const [key, job] of pendingJobs.entries()) {
    if (job.createdAt < cutoff) pendingJobs.delete(key)
  }
}, 60_000)
