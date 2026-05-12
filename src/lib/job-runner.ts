import Anthropic from '@anthropic-ai/sdk'
import type { DeployManifest, Job, SSEEmitter } from '../types'
import type { JobStore } from './store/types'
import { writeAuditEntry, hashInputs } from './audit'
import { validateToolCall, resolveArgs, executeToolCall } from './tool-executor'

export class JobRunner {
  constructor(
    private client: Anthropic,
    private manifest: DeployManifest,
    private store: JobStore,
    private emit: SSEEmitter
  ) {}

  async run(job: Job): Promise<void> {
    try {
      job.status = 'running'
      job.updatedAt = new Date()

      // 1. Load workflow system prompt
      const workflowPath = `skills/${job.skill}/Workflows/${job.workflow}.md`
      const workflowFile = Bun.file(workflowPath)
      if (!(await workflowFile.exists())) {
        throw new Error(`Workflow not found: ${workflowPath}`)
      }
      const workflowContent = await workflowFile.text()
      const systemPrompt = buildSystemPrompt(workflowContent, job)
      console.log(`[job:${job.id.slice(0, 8)}] starting — skill=${job.skill} workflow=${job.workflow} inputDir=${job.inputDir}`)

      // 2. Build tool definitions for Anthropic SDK
      const tools: Anthropic.Messages.Tool[] = this.manifest.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Messages.Tool['input_schema'],
      }))

      // 3. Tool use loop
      const messages: Anthropic.Messages.MessageParam[] = [
        { role: 'user', content: buildUserMessage(job) },
      ]

      const deadline =
        Date.now() + this.manifest.security.max_job_duration_seconds * 1000

      while (true) {
        // Duration guard
        if (Date.now() > deadline) {
          throw new Error('Job exceeded max duration')
        }

        // Tool call count guard
        if (
          job.toolCallCount >= this.manifest.security.max_tool_calls_per_job
        ) {
          throw new Error(
            `Max tool calls (${this.manifest.security.max_tool_calls_per_job}) reached`
          )
        }

        const response = await this.client.messages.create({
          model: process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-6',
          max_tokens: parseInt(process.env.MAX_TOKENS ?? '32768', 10),
          system: systemPrompt,
          tools,
          messages,
        })

        // Log token usage per turn
        const u = response.usage
        console.log(`[job:${job.id.slice(0, 8)}] tokens: in=${u.input_tokens} out=${u.output_tokens} stop=${response.stop_reason}`)

        // Emit text blocks
        for (const block of response.content) {
          if (block.type === 'text') {
            console.log(`[job:${job.id.slice(0, 8)}] text: ${block.text.slice(0, 300).replace(/\n/g, '↵')}`)
            this.emit('text_delta', { jobId: job.id, text: block.text })
          }
        }

        // If model finished without tool calls, we're done
        if (response.stop_reason === 'end_turn') break

        // Token budget exhausted — surface it clearly rather than looping silently
        if (response.stop_reason === 'max_tokens') {
          throw new Error('Model hit max_tokens limit mid-response. Increase MAX_TOKENS or reduce output size.')
        }

        // Handle tool_use blocks
        const toolResults: Anthropic.Messages.ToolResultBlockParam[] = []
        for (const block of response.content) {
          if (block.type !== 'tool_use') continue
          job.toolCallCount++

          this.emit('tool_call', {
            jobId: job.id,
            toolName: block.name,
            inputSummary: summarizeInput(block.input as Record<string, unknown>),
          })

          const result = await this.handleToolUse(block, job)
          console.log(`[job:${job.id.slice(0, 8)}] ${block.name} → ${result.output.slice(0, 200).replace(/\n/g, '↵')}`)
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result.output,
          })

          this.emit('tool_result', {
            jobId: job.id,
            toolName: block.name,
            outputSize: result.output.length,
            durationMs: result.durationMs,
          })
        }

        messages.push({ role: 'assistant', content: response.content })
        messages.push({ role: 'user', content: toolResults })
      }

      // Collect output files
      const outputFiles = await this.store.listFiles(job.id, 'output')
      console.log(`[job:${job.id.slice(0, 8)}] complete — outputFiles=${JSON.stringify(outputFiles)}`)
      job.outputFiles = outputFiles
      job.status = 'complete'
      job.updatedAt = new Date()

      this.emit('complete', { jobId: job.id, outputFiles })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      job.status = 'failed'
      job.error = errorMessage
      job.updatedAt = new Date()

      this.emit('error', { jobId: job.id, error: errorMessage })
    }
  }

  private async handleToolUse(
    block: Anthropic.Messages.ToolUseBlock,
    job: Job
  ): Promise<{ output: string; durationMs: number }> {
    const toolInput = block.input as Record<string, unknown>
    const inputsHash = await hashInputs(toolInput)

    // Validate the tool call
    const validation = validateToolCall(
      block.name,
      toolInput,
      this.manifest,
      job.jobDir
    )

    if (!validation.valid) {
      job.violationCount++

      writeAuditEntry(job, {
        tool_name: block.name,
        input_field_names: Object.keys(toolInput),
        inputs_hash: inputsHash,
        path_violations: validation.violations,
        outcome: 'blocked',
        level: 'warn',
      })

      // Hard stop at 3 violations
      if (job.violationCount >= 3) {
        throw new Error(
          `Job terminated: ${job.violationCount} security violations. Latest: ${validation.violations.join('; ')}`
        )
      }

      return {
        output: `BLOCKED: ${validation.violations.join('; ')}`,
        durationMs: 0,
      }
    }

    // Resolve arguments and execute
    const toolDef = validation.toolDef!
    const resolvedArgs = resolveArgs(toolDef, toolInput, job.jobDir)

    let execResult: Awaited<ReturnType<typeof executeToolCall>> | null = null

    try {
      execResult = await executeToolCall(toolDef, toolInput, resolvedArgs, job)

      writeAuditEntry(job, {
        tool_name: block.name,
        input_field_names: Object.keys(toolInput),
        inputs_hash: inputsHash,
        output_size: execResult.output.length,
        duration_ms: execResult.durationMs,
        outcome: 'allowed',
        level: 'info',
      })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)

      writeAuditEntry(job, {
        tool_name: block.name,
        input_field_names: Object.keys(toolInput),
        inputs_hash: inputsHash,
        outcome: 'error',
        level: 'error',
      })

      return { output: `ERROR: ${errorMessage}`, durationMs: 0 }
    }

    // fail_on_nonzero: terminate job — checked OUTSIDE try/catch so it propagates up
    if (execResult && toolDef.fail_on_nonzero && execResult.exitCode !== 0) {
      throw new Error(`Tool "${block.name}" failed (exit ${execResult.exitCode}):\n${execResult.output.slice(0, 800)}`)
    }

    return { output: execResult!.output, durationMs: execResult!.durationMs }
  }
}

function buildSystemPrompt(workflowContent: string, job: Job): string {
  return `${workflowContent}

---
DEPLOYMENT CONTEXT:
You are running as a deployed service, not inside Claude Code.
- Do NOT reference Read, Write, Bash, Skill, or Task tools.
- Use the tool_use functions registered for this skill.
- Input files are in: ${job.inputDir}
- Write output files to: ${job.outputDir}
- Current job ID: ${job.id}
`
}

function buildUserMessage(job: Job): string {
  const paramsStr = JSON.stringify(job.params, null, 2)
  return `Run the "${job.workflow}" workflow with the following parameters:\n\n${paramsStr}\n\nInput files are available in: ${job.inputDir}\nWrite all output files to: ${job.outputDir}`
}

function summarizeInput(input: Record<string, unknown>): string {
  const keys = Object.keys(input)
  if (keys.length === 0) return '{}'
  const parts = keys.map((k) => {
    const v = input[k]
    if (typeof v === 'string' && v.length > 50) return `${k}: "${v.slice(0, 47)}..."`
    return `${k}: ${JSON.stringify(v)}`
  })
  const summary = parts.join(', ')
  return summary.length > 200 ? summary.slice(0, 197) + '...' : summary
}
