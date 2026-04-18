export interface JobStore {
  createJob(jobId: string): Promise<void>
  writeFile(jobId: string, relativePath: string, content: Uint8Array | string): Promise<void>
  readFile(jobId: string, relativePath: string): Promise<Uint8Array>
  listFiles(jobId: string, subdir: string): Promise<string[]>
  getJobDir(jobId: string): string
  deleteJob(jobId: string): Promise<void>
}
