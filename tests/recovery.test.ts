import { describe, expect, it } from 'vitest'
import {
  BlobReader,
  BlobWriter,
  TextReader,
  TextWriter,
  ZipReader,
  ZipWriter,
  configure,
} from '@zip.js/zip.js'
import {
  candidates,
  countCandidates,
  DEFAULT_CONFIG,
  parseWords,
} from '../src/lib/candidates'
import { acceptsPassword, openArchive, unlockArchive } from '../src/lib/archive'

configure({ useWebWorkers: false })

describe('candidate generation', () => {
  it('deduplicates a wordlist without altering password whitespace', () => {
    expect(parseWords(' hello \r\nhello\nhello\n')).toEqual([
      ' hello ',
      'hello',
    ])
  })
  it('enumerates brute force in length order and matches its estimate', () => {
    const config = {
      ...DEFAULT_CONFIG,
      method: 'brute' as const,
      charset: 'aab',
      minLength: 1,
      maxLength: 2,
    }
    expect([...candidates(config)]).toEqual(['a', 'b', 'aa', 'ab', 'ba', 'bb'])
    expect(countCandidates(config)).toBe(6)
  })
  it('expands masks and literal question marks', () => {
    const config = {
      ...DEFAULT_CONFIG,
      method: 'mask' as const,
      mask: 'zip???d',
    }
    expect([...candidates(config)]).toEqual(
      Array.from({ length: 10 }, (_, n) => `zip?${n}`),
    )
    expect(() => countCandidates({ ...config, mask: '?x' })).toThrow(
      'Unknown pattern',
    )
  })
  it('generates case variants and padded hybrid suffixes', () => {
    const config = {
      ...DEFAULT_CONFIG,
      method: 'hybrid' as const,
      words: 'zip',
      suffixDigits: 2,
    }
    const list = [...candidates(config)]
    expect(list).toContain('Zip07')
    expect(list).toContain('ZIP')
    expect(list.length).toBe(countCandidates(config))
  })
  it('rejects excessive searches and invalid bounds before enumeration', () => {
    expect(() =>
      countCandidates({
        ...DEFAULT_CONFIG,
        method: 'brute',
        charset: 'abcdefghijklmnopqrstuvwxyz',
        maxLength: 12,
      }),
    ).toThrow('5 million')
    expect(() =>
      countCandidates({
        ...DEFAULT_CONFIG,
        method: 'brute',
        minLength: 4,
        maxLength: 1,
      }),
    ).toThrow('lengths')
    expect([
      ...candidates({ ...DEFAULT_CONFIG, method: 'known', password: '' }),
    ]).toEqual([''])
  })
})

async function fixture(zipCrypto: boolean, password = 'zip07') {
  const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false })
  await writer.add('notes/', undefined, { directory: true })
  await writer.add('notes/hello.md', new TextReader('Your files are back.'), {
    password,
    zipCrypto,
  })
  await writer.add('public.md', new TextReader('An unencrypted entry'))
  return writer.close()
}

describe.each([true, false])(
  'real ZIP recovery (ZipCrypto: %s)',
  (zipCrypto) => {
    it('rejects incorrect passwords and creates a verified unencrypted ZIP', async () => {
      const archive = await openArchive(await fixture(zipCrypto))
      try {
        expect(archive.info.encrypted).toBe(1)
        expect(await acceptsPassword(archive, 'wrong')).toBe(false)
        expect(await acceptsPassword(archive, 'zip07')).toBe(true)
        const unlocked = new ZipReader(
          new BlobReader(await unlockArchive(archive, 'zip07')),
        )
        try {
          const entries = await unlocked.getEntries()
          expect(entries.every((entry) => !entry.encrypted)).toBe(true)
          const entry = entries.find(
            (entry) => entry.filename === 'notes/hello.md',
          )!
          expect(
            !entry.directory && (await entry.getData(new TextWriter())),
          ).toBe('Your files are back.')
        } finally {
          await unlocked.close()
        }
      } finally {
        await archive.reader.close()
      }
    })
  },
)

describe('archive validation', () => {
  it('rejects a malformed ZIP', async () => {
    await expect(openArchive(new Blob(['not a zip']))).rejects.toThrow()
  })
  it('rejects traversal paths', async () => {
    const writer = new ZipWriter(new BlobWriter(), { useWebWorkers: false })
    await writer.add('../escape.md', new TextReader('test'))
    await expect(openArchive(await writer.close())).rejects.toThrow(/unsafe/i)
  })
})
