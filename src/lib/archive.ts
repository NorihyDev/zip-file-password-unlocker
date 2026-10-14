import {
  BlobReader,
  BlobWriter,
  ZipReader,
  ZipWriter,
  ERR_INVALID_PASSWORD,
  ERR_INVALID_CRC32,
  ERR_INVALID_COMPRESSED_DATA,
  ERR_INVALID_UNCOMPRESSED_SIZE,
  ERR_INVALID_AUTHENTICATION_CODE,
} from '@zip.js/zip.js'

export const MAX_ZIP_BYTES = 100 * 1024 * 1024
export const MAX_EXPANDED_BYTES = 200 * 1024 * 1024
export const MAX_ENTRIES = 2_000
export type ArchiveInfo = {
  name: string
  size: number
  expandedSize: number
  entries: number
  encrypted: number
  encryption: string
  filenames: string[]
}

export async function openArchive(file: Blob, name = 'archive.zip') {
  if (file.size > MAX_ZIP_BYTES)
    throw new Error('Choose a ZIP smaller than 100 MB for browser recovery.')
  const reader = new ZipReader(new BlobReader(file), {
    useWebWorkers: false,
    checkCrc32: true,
    checkAuthenticationCode: true,
  })
  try {
    const entries = await reader.getEntries()
    if (!entries.length)
      throw new Error('This ZIP is empty. Choose an archive containing files.')
    if (entries.length > MAX_ENTRIES)
      throw new Error('This archive exceeds the 2,000-entry browser limit.')
    const expandedSize = entries.reduce(
      (sum, entry) => sum + entry.uncompressedSize,
      0,
    )
    if (
      !Number.isSafeInteger(expandedSize) ||
      expandedSize > MAX_EXPANDED_BYTES
    )
      throw new Error(
        'The uncompressed archive exceeds the 200 MB browser limit.',
      )
    for (const entry of entries) {
      const path = entry.filename.replaceAll('\\', '/')
      if (
        path.startsWith('/') ||
        /^[a-z]:/i.test(path) ||
        path.split('/').includes('..') ||
        path.includes('\0')
      )
        throw new Error(
          'This ZIP contains unsafe file paths. Choose a different archive.',
        )
    }
    const encrypted = entries.filter(
      (entry) => entry.encrypted && !entry.directory,
    )
    const encryption = encrypted.length
      ? [
          ...new Set(
            encrypted.map((entry) => (entry.zipCrypto ? 'ZipCrypto' : 'AES')),
          ),
        ].join(' + ')
      : 'None'
    const info: ArchiveInfo = {
      name,
      size: file.size,
      expandedSize,
      entries: entries.length,
      encrypted: encrypted.length,
      encryption,
      filenames: entries.slice(0, 6).map((entry) => entry.filename),
    }
    return {
      reader,
      entries,
      encrypted: encrypted.sort(
        (a, b) => a.uncompressedSize - b.uncompressedSize,
      ),
      info,
    }
  } catch (error) {
    await reader.close()
    throw error
  }
}

export type OpenArchive = Awaited<ReturnType<typeof openArchive>>
export function wrongPassword(error: unknown): boolean {
  return (
    error instanceof Error &&
    [
      ERR_INVALID_PASSWORD,
      ERR_INVALID_CRC32,
      ERR_INVALID_COMPRESSED_DATA,
      ERR_INVALID_UNCOMPRESSED_SIZE,
      ERR_INVALID_AUTHENTICATION_CODE,
    ].includes(error.message)
  )
}

async function readEntry(
  entry: OpenArchive['entries'][number],
  password: string,
): Promise<Blob> {
  if (entry.directory) return new Blob([])
  let emitted = 0
  const chunks: Uint8Array<ArrayBuffer>[] = []
  // Enforce the actual decoded size as well as the ZIP directory's claimed size.
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      emitted += chunk.byteLength
      if (emitted > entry.uncompressedSize || emitted > MAX_EXPANDED_BYTES)
        throw new Error('Decoded data exceeds the archive size limit.')
      chunks.push(new Uint8Array(chunk))
    },
  })
  await entry.getData(output, {
    password,
    checkCrc32: true,
    checkAuthenticationCode: true,
  })
  return new Blob(chunks)
}

export async function acceptsPassword(
  archive: OpenArchive,
  password: string,
): Promise<boolean> {
  if (!archive.encrypted.length) return false
  try {
    // Verify actual decoded contents, avoiding ZipCrypto's short-header false positives.
    await readEntry(archive.encrypted[0], password)
    return true
  } catch (error) {
    if (wrongPassword(error)) return false
    throw error
  }
}

export async function unlockArchive(
  archive: OpenArchive,
  password: string,
): Promise<Blob> {
  const writer = new ZipWriter(new BlobWriter('application/zip'), {
    useWebWorkers: false,
  })
  try {
    for (const entry of archive.entries) {
      const data = await readEntry(entry, password)
      await writer.add(entry.filename, new BlobReader(data), {
        directory: entry.directory,
        lastModDate: entry.lastModDate,
        level: 0,
      })
    }
    return await writer.close()
  } catch (error) {
    await writer.close().catch(() => undefined)
    throw error
  }
}
