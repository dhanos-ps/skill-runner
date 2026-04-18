import type { Middleware, SlackEventMiddlewareArgs } from '@slack/bolt'
import { pendingJobs } from '../state'
import { PaiClient } from '../pai-client'

interface FileSharedEvent {
  file_id: string
  channel_id: string
  event_ts: string
}

export const handleFileUploaded: Middleware<SlackEventMiddlewareArgs<'file_shared'>> = async ({ event, client }) => {
  const { file_id, channel_id } = event as FileSharedEvent
  console.log(`[file_shared] file_id=${file_id} channel_id=${channel_id}`)

  // Resolve thread_ts from file share metadata
  const fileInfo = await client.files.info({ file: file_id })
  const file = fileInfo.file!
  const shares = (file as any).shares ?? {}
  const channelShares: any[] = shares?.public?.[channel_id] ?? shares?.private?.[channel_id] ?? shares?.im?.[channel_id] ?? []
  let threadTs: string | undefined = channelShares[0]?.thread_ts

  // Fallback: scan pending jobs by channel prefix (common in DMs)
  let pending = threadTs ? pendingJobs.get(`${channel_id}:${threadTs}`) : undefined
  if (!pending) {
    for (const [key, job] of pendingJobs.entries()) {
      if (key.startsWith(`${channel_id}:`)) {
        pending = job
        threadTs = key.split(':')[1]
        break
      }
    }
  }

  console.log(`[file_shared] threadTs=${threadTs} pending=${!!pending}`)
  if (!pending || !threadTs) {
    console.log('[file_shared] no matching pending job — ignoring')
    return
  }

  pendingJobs.delete(`${channel_id}:${threadTs}`)

  const { config, skillName, resolvedParams } = pending
  const displayName = resolvedParams[Object.keys(resolvedParams)[0]] ?? skillName

  const statusMsg = await client.chat.postMessage({
    channel: channel_id,
    thread_ts: threadTs,
    text: `Received file — starting analysis for *${displayName}*...`,
  })
  const statusTs = statusMsg.ts as string

  try {
    const downloadUrl = (file as { url_private_download?: string }).url_private_download
    if (!downloadUrl) throw new Error('File has no download URL')

    const fileResp = await fetch(downloadUrl, {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    })
    if (!fileResp.ok) throw new Error(`Slack download failed: ${fileResp.status}`)
    const fileBytes = new Uint8Array(await fileResp.arrayBuffer())

    const pai = new PaiClient(process.env.PAI_RUNNER_URL ?? 'http://api:8080')
    const { jobId } = await pai.createJob(skillName, config.workflow, resolvedParams)

    const filename = (file.name as string) ?? 'upload.zip'
    await pai.uploadFile(jobId, fileBytes, filename)

    await client.chat.update({
      channel: channel_id,
      ts: statusTs,
      text: `*${displayName}* — analysis running (job \`${jobId.slice(0, 8)}\`)\n\nThis takes 5–10 minutes. You'll be notified here when it's ready — no need to wait in this chat.`,
    })

    // Poll until complete
    const POLL_INTERVAL_MS = 15_000
    const MAX_POLL_MINUTES = 20
    const MAX_POLLS = (MAX_POLL_MINUTES * 60 * 1000) / POLL_INTERVAL_MS
    let outputFiles: string[] = []
    let elapsed = 0

    for (let i = 0; i < MAX_POLLS; i++) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS))
      elapsed += POLL_INTERVAL_MS

      const job = await pai.getJob(jobId)

      if (job.status === 'complete') {
        outputFiles = job.outputFiles ?? []
        break
      }

      if (job.status === 'failed') {
        throw new Error(job.error ?? 'Job failed with no error message')
      }

      if (i % 2 === 1) {
        const mins = Math.floor(elapsed / 60000)
        const secs = Math.floor((elapsed % 60000) / 1000)
        const elapsed_str = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`
        await client.chat.update({
          channel: channel_id,
          ts: statusTs,
          text: `*${displayName}* — analysis running (${elapsed_str} elapsed)\n\nYou'll be notified here when it's ready.`,
        })
      }

      if (i === MAX_POLLS - 1) {
        throw new Error(`Job timed out after ${MAX_POLL_MINUTES} minutes`)
      }
    }

    // Deliver output — prefer the configured extension, fall back to first file
    const outputFile = config.output_extension
      ? outputFiles.find(f => f.endsWith(config.output_extension!))
      : outputFiles[0]

    if (outputFile) {
      const outputBytes = await pai.downloadOutput(jobId, outputFile)
      await client.filesUploadV2({
        channel_id,
        thread_ts: threadTs,
        filename: outputFile,
        file: Buffer.from(outputBytes),
        initial_comment: `*${displayName}* — analysis complete. Here's your file:`,
      })
    } else {
      await client.chat.postMessage({
        channel: channel_id,
        thread_ts: threadTs,
        text: `Analysis complete. Output files: ${outputFiles.join(', ')}`,
      })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await client.chat.postMessage({
      channel: channel_id,
      thread_ts: threadTs,
      text: `Job failed: ${message}`,
    })
  }
}
