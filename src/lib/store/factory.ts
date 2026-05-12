import type { JobStore } from './types'
import { LocalJobStore } from './local'

export function createStore(): JobStore {
  if (process.env.USE_LOCAL_STORE !== 'false') {
    return new LocalJobStore(process.env.LOCAL_JOBS_DIR ?? '/data/jobs')
  }
  throw new Error('Cloud store not implemented yet. Set USE_LOCAL_STORE=true')
}
