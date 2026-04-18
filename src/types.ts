export type JobStatus = 'pending' | 'running' | 'complete' | 'failed' | 'cancelled'

export interface Job {
  id: string
  skill: string
  workflow: string
  params: Record<string, unknown>
  status: JobStatus
  createdAt: Date
  updatedAt: Date
  jobDir: string
  inputDir: string
  outputDir: string
  auditPath: string
  toolCallCount: number
  violationCount: number
  error?: string
  outputFiles?: string[]
}

export interface ToolDefinition {
  name: string
  description: string
  command: string
  args: string[]
  input_schema: object
  input_map: Record<string, string | string[]>
  path_fields?: string[]
  // If true, a non-zero exit code terminates the job immediately (no model recovery attempt)
  fail_on_nonzero?: boolean
  // Built-in tools handled directly by tool-executor (no subprocess)
  _builtin?: boolean
  _context_tool?: boolean
  _context_root?: string
}

export interface DeployManifest {
  skill: string
  tier: 1 | 2 | 3
  tools: ToolDefinition[]
  workflows_dir: string
  security: {
    path_containment: boolean
    max_tool_calls_per_job: number
    max_job_duration_seconds: number
    max_upload_size_mb: number
    audit_log: boolean
  }
}

export type SSEEmitter = (event: string, data: object) => void
