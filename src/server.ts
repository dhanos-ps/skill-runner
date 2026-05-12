import Anthropic from '@anthropic-ai/sdk'
import { v4 as uuidv4 } from 'uuid'
import { join } from 'node:path'
import type { Job, SSEEmitter } from './types'
import { createStore } from './lib/store/factory'
import { loadManifest } from './lib/manifest'
import { JobRunner } from './lib/job-runner'

// ─── Module-level singletons ──────────────────────────────────────

const jobs = new Map<string, Job>()
const sseSubscribers = new Map<string, Set<SSEEmitter>>()
const store = createStore()
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const startTime = Date.now()
const PORT = parseInt(process.env.PORT ?? '8080', 10)
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_JOBS ?? '10', 10)
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_SIZE_MB ?? '100', 10)

// ─── SSE helpers ──────────────────────────────────────────────────

function subscribe(jobId: string, emitter: SSEEmitter): void {
  let subs = sseSubscribers.get(jobId)
  if (!subs) {
    subs = new Set()
    sseSubscribers.set(jobId, subs)
  }
  subs.add(emitter)
}

function unsubscribe(jobId: string, emitter: SSEEmitter): void {
  const subs = sseSubscribers.get(jobId)
  if (subs) {
    subs.delete(emitter)
    if (subs.size === 0) sseSubscribers.delete(jobId)
  }
}

function broadcastEmitter(jobId: string): SSEEmitter {
  return (event: string, data: object) => {
    const subs = sseSubscribers.get(jobId)
    if (subs) {
      for (const emitter of subs) {
        emitter(event, data)
      }
    }
  }
}

// ─── Route handlers ───────────────────────────────────────────────

async function handleCreateJob(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as {
      skill?: string
      workflow?: string
      params?: Record<string, unknown>
    }

    if (!body.skill || !body.workflow) {
      return Response.json(
        { error: 'Missing required fields: skill, workflow' },
        { status: 400 }
      )
    }

    // Check concurrent job limit
    let runningCount = 0
    for (const j of jobs.values()) {
      if (j.status === 'running') runningCount++
    }
    if (runningCount >= MAX_CONCURRENT) {
      return Response.json(
        { error: `Max concurrent jobs (${MAX_CONCURRENT}) reached` },
        { status: 429 }
      )
    }

    // Load and validate manifest
    const manifest = await loadManifest(body.skill)

    // Create job
    const jobId = uuidv4()
    const jobDir = store.getJobDir(jobId)
    await store.createJob(jobId)

    const job: Job = {
      id: jobId,
      skill: body.skill,
      workflow: body.workflow,
      params: body.params ?? {},
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
      jobDir,
      inputDir: join(jobDir, 'input'),
      outputDir: join(jobDir, 'output'),
      auditPath: join(jobDir, 'audit.jsonl'),
      toolCallCount: 0,
      violationCount: 0,
    }

    jobs.set(jobId, job)

    return Response.json({ jobId, status: 'pending' }, { status: 201 })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ error: message }, { status: 500 })
  }
}

function handleGetJob(jobId: string): Response {
  const job = jobs.get(jobId)
  if (!job) {
    return Response.json({ error: 'Job not found' }, { status: 404 })
  }

  return Response.json({
    id: job.id,
    skill: job.skill,
    workflow: job.workflow,
    status: job.status,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    toolCallCount: job.toolCallCount,
    violationCount: job.violationCount,
    error: job.error,
    outputFiles: job.outputFiles,
  })
}

function handleStreamJob(jobId: string): Response {
  const job = jobs.get(jobId)
  if (!job) {
    return Response.json({ error: 'Job not found' }, { status: 404 })
  }

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      let closed = false

      // Heartbeat — keeps the TCP connection alive during long Anthropic API calls
      const heartbeat = setInterval(() => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(': ping\n\n'))
        } catch {
          clearInterval(heartbeat)
        }
      }, 25_000)

      const emitter: SSEEmitter = (event: string, data: object) => {
        if (closed) return
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
        try {
          controller.enqueue(encoder.encode(payload))
        } catch {
          // Stream closed
          unsubscribe(jobId, emitter)
        }

        // Close stream on terminal events
        if (event === 'complete' || event === 'error') {
          closed = true
          clearInterval(heartbeat)
          try {
            controller.close()
          } catch {
            // Already closed
          }
          unsubscribe(jobId, emitter)
        }
      }

      subscribe(jobId, emitter)

      // If job already completed, send final event immediately
      if (job.status === 'complete') {
        emitter('complete', { jobId, outputFiles: job.outputFiles ?? [] })
      } else if (job.status === 'failed') {
        emitter('error', { jobId, error: job.error ?? 'Unknown error' })
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}

// Extension → input subdir classification
// Customize these mappings for your skills' input file types
const EXT_SUBDIRS: Record<string, string> = {
  '.xml': 'xml',
  '.json': 'json',
  '.pdf': 'documents',
  '.txt': 'text',
  '.md': 'text',
  '.csv': 'data',
  '.xlsx': 'data',
  '.xls': 'data',
}

function classifyFile(filename: string): string {
  const lower = filename.toLowerCase()
  for (const [ext, subdir] of Object.entries(EXT_SUBDIRS)) {
    if (lower.endsWith(ext)) return subdir
  }
  return 'other'
}

async function extractZip(zipPath: string, destDir: string): Promise<string[]> {
  // Array-form spawn — no shell string interpolation
  const proc = Bun.spawn(['unzip', '-o', '-j', zipPath, '-d', destDir], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  await proc.exited
  // List extracted files
  const ls = Bun.spawn(['find', destDir, '-maxdepth', '1', '-type', 'f'], {
    stdout: 'pipe',
  })
  const out = await new Response(ls.stdout).text()
  return out.trim().split('\n').filter(Boolean)
}

async function handleUpload(req: Request, jobId: string): Promise<Response> {
  const job = jobs.get(jobId)
  if (!job) {
    return Response.json({ error: 'Job not found' }, { status: 404 })
  }

  try {
    const contentType = req.headers.get('content-type') ?? ''
    if (!contentType.includes('multipart/form-data')) {
      return Response.json(
        { error: 'Content-Type must be multipart/form-data' },
        { status: 400 }
      )
    }

    const formData = await req.formData()
    const uploaded: string[] = []

    for (const [, value] of formData.entries()) {
      if (typeof value !== 'object' || value === null || !('arrayBuffer' in value)) continue
      const file = value as File

      if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
        return Response.json(
          { error: `File "${file.name}" exceeds ${MAX_UPLOAD_MB}MB limit` },
          { status: 413 }
        )
      }

      const bytes = new Uint8Array(await file.arrayBuffer())
      const isZip = file.name.toLowerCase().endsWith('.zip') ||
        file.type === 'application/zip' ||
        file.type === 'application/x-zip-compressed'

      if (isZip) {
        // Write zip to a temp path, extract, classify each file into subdir
        const tmpZip = `${job.jobDir}/_upload.zip`
        await store.writeFile(jobId, '_upload.zip', bytes)
        const tmpFlat = `${job.jobDir}/_unzip_tmp`
        const proc = Bun.spawn(['mkdir', '-p', tmpFlat])
        await proc.exited
        const extracted = await extractZip(tmpZip, tmpFlat)
        console.log(`[upload:${jobId.slice(0, 8)}] extracted ${extracted.length} files: ${extracted.join(', ')}`)
        for (const filePath of extracted) {
          const name = filePath.split('/').pop() ?? filePath
          const subdir = classifyFile(name)
          const content = new Uint8Array(await Bun.file(filePath).arrayBuffer())
          await store.writeFile(jobId, `input/${subdir}/${name}`, content)
          uploaded.push(`${subdir}/${name}`)
        }
        // Cleanup temp files
        Bun.spawn(['rm', '-rf', tmpZip, tmpFlat])
      } else {
        const subdir = classifyFile(file.name)
        await store.writeFile(jobId, `input/${subdir}/${file.name}`, bytes)
        uploaded.push(`${subdir}/${file.name}`)
      }
    }

    // Start runner now that input files are in place
    const manifest = await loadManifest(job.skill)
    const emit = broadcastEmitter(job.id)
    const runner = new JobRunner(anthropic, manifest, store, emit)
    job.status = 'running'
    job.updatedAt = new Date()
    runner.run(job).catch((err) => {
      job.status = 'failed'
      job.error = err instanceof Error ? err.message : String(err)
      job.updatedAt = new Date()
      emit('error', { jobId: job.id, error: job.error })
    })

    return Response.json({ uploaded })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json({ error: message }, { status: 500 })
  }
}

async function handleGetOutput(jobId: string, filename: string): Promise<Response> {
  const job = jobs.get(jobId)
  if (!job) {
    return Response.json({ error: 'Job not found' }, { status: 404 })
  }

  try {
    const buffer = await store.readFile(jobId, `output/${filename}`)
    const ext = filename.split('.').pop()?.toLowerCase()
    const mimeTypes: Record<string, string> = {
      json: 'application/json',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      xls: 'application/vnd.ms-excel',
      pdf: 'application/pdf',
      xml: 'application/xml',
      txt: 'text/plain',
      md: 'text/markdown',
      csv: 'text/csv',
    }
    const contentType = mimeTypes[ext ?? ''] ?? 'application/octet-stream'

    return new Response(buffer as unknown as BodyInit, {
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch {
    return Response.json({ error: 'File not found' }, { status: 404 })
  }
}

function handleCancelJob(jobId: string): Response {
  const job = jobs.get(jobId)
  if (!job) {
    return Response.json({ error: 'Job not found' }, { status: 404 })
  }

  if (job.status === 'running' || job.status === 'pending') {
    job.status = 'cancelled'
    job.updatedAt = new Date()
    broadcastEmitter(jobId)('error', {
      jobId,
      error: 'Job cancelled by user',
    })
  }

  return Response.json({ id: job.id, status: job.status })
}

function handleHealth(): Response {
  return Response.json({
    status: 'ok',
    version: '0.1.0',
    uptime: Math.floor((Date.now() - startTime) / 1000),
  })
}

// ─── Router ───────────────────────────────────────────────────────

function parseRoute(
  method: string,
  pathname: string
): { handler: string; params: Record<string, string> } | null {
  // GET /health
  if (method === 'GET' && pathname === '/health') {
    return { handler: 'health', params: {} }
  }

  // POST /jobs
  if (method === 'POST' && pathname === '/jobs') {
    return { handler: 'createJob', params: {} }
  }

  // Match /jobs/:id patterns
  const jobMatch = pathname.match(/^\/jobs\/([a-f0-9-]+)$/)
  if (jobMatch) {
    const id = jobMatch[1]
    if (method === 'GET') return { handler: 'getJob', params: { id } }
    if (method === 'DELETE') return { handler: 'cancelJob', params: { id } }
  }

  // GET /jobs/:id/stream
  const streamMatch = pathname.match(/^\/jobs\/([a-f0-9-]+)\/stream$/)
  if (streamMatch && method === 'GET') {
    return { handler: 'streamJob', params: { id: streamMatch[1] } }
  }

  // POST /jobs/:id/upload
  const uploadMatch = pathname.match(/^\/jobs\/([a-f0-9-]+)\/upload$/)
  if (uploadMatch && method === 'POST') {
    return { handler: 'uploadJob', params: { id: uploadMatch[1] } }
  }

  // GET /jobs/:id/output/:filename
  const outputMatch = pathname.match(
    /^\/jobs\/([a-f0-9-]+)\/output\/(.+)$/
  )
  if (outputMatch && method === 'GET') {
    return {
      handler: 'getOutput',
      params: { id: outputMatch[1], filename: outputMatch[2] },
    }
  }

  return null
}

// ─── Server ───────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const route = parseRoute(req.method, url.pathname)

    if (!route) {
      return Response.json({ error: 'Not found' }, { status: 404 })
    }

    try {
      switch (route.handler) {
        case 'health':
          return handleHealth()
        case 'createJob':
          return await handleCreateJob(req)
        case 'getJob':
          return handleGetJob(route.params.id)
        case 'streamJob':
          return handleStreamJob(route.params.id)
        case 'uploadJob':
          return await handleUpload(req, route.params.id)
        case 'getOutput':
          return await handleGetOutput(route.params.id, route.params.filename)
        case 'cancelJob':
          return handleCancelJob(route.params.id)
        default:
          return Response.json({ error: 'Not found' }, { status: 404 })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return Response.json({ error: message }, { status: 500 })
    }
  },
})

console.log(`pai-runner v0.1.0 listening on port ${server.port}`)
