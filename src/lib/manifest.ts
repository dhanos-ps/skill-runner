import type { DeployManifest, ToolDefinition } from '../types'

const BANNED_TOOL_NAMES = [
  'run_bash', 'bash', 'exec', 'shell', 'eval', 'spawn',
  'run_command', 'execute', 'system', 'subprocess', 'popen',
  'run_script', 'run_code',
]

const BANNED_COMMANDS = [
  '/bin/bash', '/bin/sh', '/bin/zsh',
  '/usr/bin/python', 'python', 'python3',
  'node', 'perl', 'ruby',
]

const BANNED_INPUT_FIELDS = [
  'command', 'shell', 'eval', 'code', 'script', 'exec', 'expression',
]

export async function loadManifest(skillName: string): Promise<DeployManifest> {
  const manifestPath = `skills/${skillName}/deploy.json`
  const file = Bun.file(manifestPath)

  if (!(await file.exists())) {
    throw new Error(`Manifest not found: ${manifestPath}`)
  }

  const raw = await file.json()
  return validateManifest(raw, manifestPath)
}

function validateManifest(raw: unknown, path: string): DeployManifest {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`Invalid manifest at ${path}: not an object`)
  }

  const manifest = raw as Record<string, unknown>

  // Required top-level fields
  const requiredFields = ['skill', 'tier', 'tools', 'workflows_dir', 'security']
  for (const field of requiredFields) {
    if (!(field in manifest)) {
      throw new Error(`Manifest ${path} missing required field: ${field}`)
    }
  }

  // Tier validation
  const tier = manifest.tier as number
  if (![1, 2, 3].includes(tier)) {
    throw new Error(`Manifest ${path}: tier must be 1, 2, or 3 (got ${tier})`)
  }

  // Tools validation
  const tools = manifest.tools as ToolDefinition[]
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error(`Manifest ${path}: tools must be a non-empty array`)
  }

  for (const tool of tools) {
    validateTool(tool, path)
  }

  // Security validation
  const security = manifest.security as DeployManifest['security']
  if (typeof security !== 'object' || security === null) {
    throw new Error(`Manifest ${path}: security must be an object`)
  }

  return manifest as unknown as DeployManifest
}

function validateTool(tool: ToolDefinition, manifestPath: string): void {
  // Required tool fields
  if (!tool.name || !tool.command || !tool.description) {
    throw new Error(
      `Manifest ${manifestPath}: tool missing required fields (name, command, description)`
    )
  }

  // Banned tool name check
  const lowerName = tool.name.toLowerCase()
  if (BANNED_TOOL_NAMES.includes(lowerName)) {
    throw new Error(
      `Manifest ${manifestPath}: tool name "${tool.name}" is banned`
    )
  }

  // Banned command check
  const lowerCommand = tool.command.toLowerCase()
  if (BANNED_COMMANDS.includes(lowerCommand)) {
    throw new Error(
      `Manifest ${manifestPath}: command "${tool.command}" is banned`
    )
  }

  // Banned input field check
  if (tool.input_schema && typeof tool.input_schema === 'object') {
    const schema = tool.input_schema as Record<string, unknown>
    const properties = schema.properties as Record<string, unknown> | undefined
    if (properties) {
      for (const fieldName of Object.keys(properties)) {
        if (BANNED_INPUT_FIELDS.includes(fieldName.toLowerCase())) {
          throw new Error(
            `Manifest ${manifestPath}: tool "${tool.name}" has banned input field "${fieldName}"`
          )
        }
      }
    }
  }
}
