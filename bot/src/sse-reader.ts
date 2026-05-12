type SseCallback = (eventName: string, data: Record<string, unknown>) => Promise<void>

const MAX_RETRIES = 10
const RETRY_DELAY_MS = 3_000

export async function readSse(url: string, onEvent: SseCallback): Promise<void> {
  let attempts = 0

  while (attempts < MAX_RETRIES) {
    attempts++
    try {
      const resp = await fetch(url, {
        headers: { Accept: 'text/event-stream' },
        signal: AbortSignal.timeout(20 * 60 * 1000),
      })

      if (!resp.ok || !resp.body) {
        throw new Error(`SSE connection failed: ${resp.status}`)
      }

      const reader = resp.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let currentEvent = 'message'

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (line.startsWith('event:')) {
            currentEvent = line.slice(6).trim()
          } else if (line.startsWith('data:')) {
            const raw = line.slice(5).trim()
            try {
              const data = JSON.parse(raw) as Record<string, unknown>
              await onEvent(currentEvent, data)
              // Terminal events — clean exit, no retry
              if (currentEvent === 'complete' || currentEvent === 'error') {
                reader.cancel()
                return
              }
            } catch {
              // non-JSON data line (e.g. comment/ping), skip
            }
            currentEvent = 'message'
          }
          // Lines starting with ':' are SSE comments (heartbeat pings) — ignore
        }
      }

      // Stream ended without a terminal event — retry (job still running on server)
      console.log(`[sse] connection closed mid-stream (attempt ${attempts}/${MAX_RETRIES}), reconnecting in ${RETRY_DELAY_MS}ms...`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`[sse] connection error (attempt ${attempts}/${MAX_RETRIES}): ${msg}, reconnecting in ${RETRY_DELAY_MS}ms...`)
    }

    if (attempts < MAX_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS))
    }
  }

  throw new Error(`SSE stream failed after ${MAX_RETRIES} attempts`)
}
