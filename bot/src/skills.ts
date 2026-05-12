import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import type { SlackSkillConfig } from './state'

const SKILLS_DIR = process.env.SKILLS_DIR ?? '/app/skills'

export interface SkillEntry {
  skillName: string
  config: SlackSkillConfig
}

export async function loadSlackSkills(): Promise<SkillEntry[]> {
  const skills: SkillEntry[] = []

  let entries: string[]
  try {
    entries = await readdir(SKILLS_DIR)
  } catch (err) {
    console.warn(`[skills] could not read skills dir ${SKILLS_DIR}: ${err}`)
    return skills
  }

  for (const entry of entries) {
    const deployPath = join(SKILLS_DIR, entry, 'deploy.json')
    try {
      const raw = await readFile(deployPath, 'utf-8')
      const manifest = JSON.parse(raw)
      if (manifest.slack?.command) {
        skills.push({ skillName: manifest.skill, config: manifest.slack })
        console.log(`[skills] registered ${manifest.slack.command} → ${manifest.skill}/${manifest.slack.workflow}`)
      }
    } catch {
      // No deploy.json or no slack block — skip
    }
  }

  return skills
}
