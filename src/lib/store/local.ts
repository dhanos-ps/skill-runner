import { mkdir, rm, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { JobStore } from './types'

export class LocalJobStore implements JobStore {
  constructor(private readonly jobsRoot: string) {}

  async createJob(jobId: string): Promise<void> {
    const jobDir = this.getJobDir(jobId)
    await mkdir(join(jobDir, 'input'), { recursive: true })
    await mkdir(join(jobDir, 'output'), { recursive: true })
  }

  async writeFile(jobId: string, relativePath: string, content: Uint8Array | string): Promise<void> {
    const filePath = join(this.getJobDir(jobId), relativePath)
    const dir = filePath.substring(0, filePath.lastIndexOf('/'))
    await mkdir(dir, { recursive: true })
    await Bun.write(filePath, content)
  }

  async readFile(jobId: string, relativePath: string): Promise<Uint8Array> {
    const filePath = join(this.getJobDir(jobId), relativePath)
    const file = Bun.file(filePath)
    const arrayBuffer = await file.arrayBuffer()
    return new Uint8Array(arrayBuffer)
  }

  async listFiles(jobId: string, subdir: string): Promise<string[]> {
    const dirPath = join(this.getJobDir(jobId), subdir)
    try {
      const entries = await readdir(dirPath, { recursive: true })
      const files: string[] = []
      for (const entry of entries) {
        if (typeof entry !== 'string') continue
        const fullPath = join(dirPath, entry)
        const s = await stat(fullPath).catch(() => null)
        if (s?.isFile()) files.push(entry)
      }
      return files
    } catch {
      return []
    }
  }

  getJobDir(jobId: string): string {
    return join(this.jobsRoot, jobId)
  }

  async deleteJob(jobId: string): Promise<void> {
    const jobDir = this.getJobDir(jobId)
    await rm(jobDir, { recursive: true, force: true })
  }
}
