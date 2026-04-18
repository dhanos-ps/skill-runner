export class PaiClient {
  constructor(public readonly baseUrl: string) {}

  async createJob(skill: string, workflow: string, params: Record<string, unknown>): Promise<{ jobId: string }> {
    const resp = await fetch(`${this.baseUrl}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skill, workflow, params }),
    })
    if (!resp.ok) throw new Error(`createJob failed: ${resp.status} ${await resp.text()}`)
    return resp.json()
  }

  async uploadFile(jobId: string, bytes: Uint8Array, filename: string): Promise<{ uploaded: string[] }> {
    const form = new FormData()
    form.append('file', new Blob([bytes] as BlobPart[]), filename)
    const resp = await fetch(`${this.baseUrl}/jobs/${jobId}/upload`, {
      method: 'POST',
      body: form,
    })
    if (!resp.ok) throw new Error(`uploadFile failed: ${resp.status} ${await resp.text()}`)
    return resp.json()
  }

  async downloadOutput(jobId: string, filename: string): Promise<Uint8Array> {
    const resp = await fetch(`${this.baseUrl}/jobs/${jobId}/output/${filename}`)
    if (!resp.ok) throw new Error(`downloadOutput failed: ${resp.status}`)
    return new Uint8Array(await resp.arrayBuffer())
  }

  async getJob(jobId: string): Promise<{ status: string; error?: string; outputFiles?: string[] }> {
    const resp = await fetch(`${this.baseUrl}/jobs/${jobId}`)
    if (!resp.ok) throw new Error(`getJob failed: ${resp.status}`)
    return resp.json()
  }
}
