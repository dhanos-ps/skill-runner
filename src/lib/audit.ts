import { appendFileSync } from 'node:fs'
import type { Job } from '../types'

export interface AuditEntry {
  tool_name: string
  input_field_names: string[]
  inputs_hash: string
  output_size?: number
  duration_ms?: number
  path_violations?: string[]
  outcome: 'allowed' | 'blocked' | 'error'
  level: 'info' | 'warn' | 'error'
}

export function writeAuditEntry(job: Job, entry: AuditEntry): void {
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    job_id: job.id,
    ...entry,
  })
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')

  appendFileSync(job.auditPath, line + '\n')
}

export async function hashInputs(inputs: unknown): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(JSON.stringify(inputs))
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}
