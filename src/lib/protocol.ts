import type { ArchiveInfo } from './archive'
import type { SearchConfig } from './candidates'

export type WorkerRequest =
  | { type: 'inspect'; file: File }
  | { type: 'start'; file: File; config: SearchConfig }
export type Progress = {
  attempted: number
  total: number
  elapsed: number
  rate: number
}
export type WorkerResponse =
  | { type: 'ready'; info: ArchiveInfo }
  | ({ type: 'progress' | 'exhausted' } & Progress)
  | ({ type: 'found'; password: string; blob: Blob } & Progress)
  | { type: 'extracting' }
  | { type: 'error'; message: string }
