import { configure } from '@zip.js/zip.js'
import {
  acceptsPassword,
  openArchive,
  unlockArchive,
  wrongPassword,
} from './lib/archive'
import { candidates, countCandidates } from './lib/candidates'
import type { WorkerRequest, WorkerResponse } from './lib/protocol'

configure({ useWebWorkers: false })
const send = (message: WorkerResponse) => self.postMessage(message)
let busy = false
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  if (busy) return
  busy = true
  let archive: Awaited<ReturnType<typeof openArchive>> | undefined
  try {
    const request = event.data
    archive = await openArchive(request.file, request.file.name)
    if (request.type === 'inspect') {
      send({ type: 'ready', info: archive.info })
      return
    }
    if (!archive.encrypted.length)
      throw new Error(
        'This ZIP is already unlocked. Download the original from the archive card.',
      )
    const total = countCandidates(request.config)
    const started = performance.now()
    let attempted = 0n
    let lastUpdate = 0
    const progress = () => {
      const elapsed = (performance.now() - started) / 1000
      return {
        attempted,
        total,
        elapsed,
        rate: Number(attempted) / Math.max(elapsed, 0.001),
      }
    }
    for (const password of candidates(request.config)) {
      attempted++
      if (await acceptsPassword(archive, password)) {
        send({ type: 'extracting' })
        try {
          const blob = await unlockArchive(archive, password)
          send({ type: 'found', password, blob, ...progress() })
          return
        } catch (error) {
          if (!wrongPassword(error)) throw error
          // Different entries can have different passwords. Continue until one unlocks all.
        }
      }
      if (performance.now() - lastUpdate > 150) {
        send({ type: 'progress', ...progress() })
        lastUpdate = performance.now()
      }
    }
    send({ type: 'exhausted', ...progress() })
  } catch (error) {
    send({
      type: 'error',
      message:
        error instanceof Error
          ? error.message
          : 'Unable to read this ZIP. It may be damaged or unsupported.',
    })
  } finally {
    await archive?.reader.close()
    busy = false
  }
}
