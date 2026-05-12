import * as path from 'node:path'
import * as fs from 'node:fs'
import type { DeployManifest, Job, ToolDefinition } from '../types'

const BANNED_TOOL_NAMES = [
  'run_bash', 'bash', 'exec', 'shell', 'eval', 'spawn',
  'run_command', 'execute', 'system', 'subprocess', 'popen',
  'run_script', 'run_code',
]

const BANNED_INPUT_FIELDS = [
  'command', 'shell', 'eval', 'code', 'script', 'exec', 'expression',
]

// ─── Path containment ─────────────────────────────────────────────

export interface ContainResult {
  allowed: boolean
  resolved: string
  reason?: string
}

export function containPath(rawPath: string, jobRoot: string): ContainResult {
  // 1. Null byte check
  if (rawPath.includes('\0')) {
    return { allowed: false, resolved: '', reason: 'null_byte' }
  }

  // 2. URL decode (single + try double)
  let decoded = decodeURIComponent(rawPath)
  try {
    decoded = decodeURIComponent(decoded)
  } catch {
    // already fully decoded
  }

  // 3. Resolve absolute or relative to jobRoot
  const base = path.isAbsolute(decoded) ? decoded : path.join(jobRoot, decoded)
  let resolved = path.resolve(base)

  // 4. realpathSync — follow symlinks
  try {
    resolved = fs.realpathSync(resolved)
  } catch {
    // File doesn't exist yet — resolve parent, keep basename
    const parent = path.dirname(resolved)
    const basename = path.basename(resolved)
    try {
      resolved = path.join(fs.realpathSync(parent), basename)
    } catch {
      // parent also doesn't exist, keep as-is
    }
  }

  // 5. Prefix check
  const normalRoot = jobRoot.endsWith('/') ? jobRoot : jobRoot + '/'
  if (!resolved.startsWith(normalRoot) && resolved !== jobRoot) {
    return { allowed: false, resolved, reason: 'outside_job_root' }
  }

  return { allowed: true, resolved }
}

// ─── Validation ────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean
  toolDef?: ToolDefinition
  violations: string[]
}

export function validateToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  manifest: DeployManifest,
  jobRoot: string
): ValidationResult {
  const violations: string[] = []

  // Step 1: Banned tool name
  if (BANNED_TOOL_NAMES.includes(toolName.toLowerCase())) {
    violations.push(`Banned tool name: ${toolName}`)
    return { valid: false, violations }
  }

  // Step 2: Tool must exist in manifest allowlist
  const toolDef = manifest.tools.find((t) => t.name === toolName)
  if (!toolDef) {
    violations.push(`Tool "${toolName}" not in manifest allowlist`)
    return { valid: false, violations }
  }

  // Step 3: Banned input field names
  for (const fieldName of Object.keys(toolInput)) {
    if (BANNED_INPUT_FIELDS.includes(fieldName.toLowerCase())) {
      violations.push(`Banned input field: ${fieldName}`)
    }
  }

  // Step 4: Path containment on path fields
  const pathFields = toolDef.path_fields ?? []
  for (const fieldName of pathFields) {
    const value = toolInput[fieldName]
    if (typeof value === 'string') {
      const result = containPath(value, jobRoot)
      if (!result.allowed) {
        violations.push(
          `Path containment violation on "${fieldName}": ${result.reason} (resolved: ${result.resolved})`
        )
      }
    }
  }

  if (violations.length > 0) {
    return { valid: false, toolDef, violations }
  }

  return { valid: true, toolDef, violations: [] }
}

// ─── Argument resolution ──────────────────────────────────────────

export function resolveArgs(
  toolDef: ToolDefinition,
  toolInput: Record<string, unknown>,
  jobRoot: string
): string[] {
  const args = [...toolDef.args]

  for (const [fieldName, mapping] of Object.entries(toolDef.input_map)) {
    const rawValue = toolInput[fieldName]
    if (rawValue === undefined || rawValue === null) continue

    let value: string
    const pathFields = toolDef.path_fields ?? []
    if (pathFields.includes(fieldName) && typeof rawValue === 'string') {
      // Use path-contained resolved value
      const contained = containPath(rawValue, jobRoot)
      value = contained.resolved
    } else {
      value = String(rawValue)
    }

    if (typeof mapping === 'string') {
      // Simple positional: "positional:N" just appends
      args.push(value)
    } else if (Array.isArray(mapping)) {
      const flag = mapping[0]
      if (mapping.length === 1 && flag.endsWith('=')) {
        // Concat form: "key=" + value → single arg "key=value"
        args.push(flag + value)
      } else {
        // Flag form: ["--flag"] → two args "--flag" "value"
        args.push(flag, value)
      }
    }
  }

  return args
}

// ─── Execution ─────────────────────────────────────────────────────

export interface ExecutionResult {
  output: string
  durationMs: number
  exitCode: number
}

export async function executeToolCall(
  toolDef: ToolDefinition,
  toolInput: Record<string, unknown>,
  resolvedArgs: string[],
  job: Job
): Promise<ExecutionResult> {
  const startTime = Date.now()

  // Built-in: write_file — write directly via Bun fs (avoids ARG_MAX issues with large content)
  if (toolDef._builtin === true && toolDef.command === '__builtin_write') {
    const relPath = String(toolInput['file_path'] ?? '')
    const content = String(toolInput['content'] ?? '')
    const contained = containPath(relPath, job.outputDir)
    if (!contained.allowed) {
      return { output: `BLOCKED: path outside output dir — ${contained.reason}`, durationMs: 0, exitCode: 1 }
    }
    const dir = path.dirname(contained.resolved)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(contained.resolved, content, 'utf-8')
    return { output: `Written ${content.length} chars to ${contained.resolved}`, durationMs: Date.now() - startTime, exitCode: 0 }
  }

  // Context tool: read bundled reference files from the skill's Context directory
  if (toolDef._context_tool === true) {
    const contextRoot = toolDef._context_root ?? '/app/skills/Context'
    const filename = String(toolInput['filename'] ?? '')
    // Validate: filename must be a plain filename, no path separators
    if (filename.includes('/') || filename.includes('..') || filename.includes('\0')) {
      return { output: 'BLOCKED: filename must be a plain filename with no path separators', durationMs: 0, exitCode: 1 }
    }
    const fullPath = path.join(contextRoot, filename)
    try {
      const content = fs.readFileSync(fullPath, 'utf-8')
      return { output: content, durationMs: Date.now() - startTime, exitCode: 0 }
    } catch {
      return { output: `File not found: ${filename}`, durationMs: Date.now() - startTime, exitCode: 1 }
    }
  }

  // Pre-create any output path_fields that look like directories
  for (const fieldName of toolDef.path_fields ?? []) {
    if (fieldName.includes('output') || fieldName.includes('dir')) {
      const val = toolInput[fieldName]
      if (typeof val === 'string') {
        const contained = containPath(val, job.jobDir)
        if (contained.allowed) fs.mkdirSync(contained.resolved, { recursive: true })
      }
    }
  }

  // CRITICAL: Array-form spawn — NEVER shell string interpolation
  const proc = Bun.spawn([toolDef.command, ...resolvedArgs], {
    env: buildToolEnv(job),
    cwd: job.jobDir,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])

  const exitCode = await proc.exited
  const durationMs = Date.now() - startTime

  const output = exitCode === 0
    ? stdout
    : `EXIT ${exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`

  return { output, durationMs, exitCode }
}

function buildToolEnv(job: Job): Record<string, string> {
  return {
    ...process.env as Record<string, string>,
    JOB_ID: job.id,
    JOB_DIR: job.jobDir,
    INPUT_DIR: job.inputDir,
    OUTPUT_DIR: job.outputDir,
    NODE_ENV: process.env.NODE_ENV ?? 'production',
  }
}
