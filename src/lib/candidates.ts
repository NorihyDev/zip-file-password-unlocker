export type Method = 'dictionary' | 'brute' | 'hybrid' | 'mask' | 'known'
export type SearchConfig = {
  method: Method
  words: string
  charset: string
  minLength: number
  maxLength: number
  mask: string
  suffixDigits: number
  password: string
}

export const SEARCH_LIMIT = 5_000_000
export const CHARSETS = {
  digits: '0123456789',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  symbols: '!@#$%^&*()-_=+[]{};:,.?',
}
export const DEFAULT_WORDS =
  'password\npassword123\n123456\nletmein\nwelcome\nsecret\nadmin\nqwerty\nsummer2026\narchive\nbackup\nhello\nzip123'
export const DEFAULT_CONFIG: SearchConfig = {
  method: 'dictionary',
  words: DEFAULT_WORDS,
  charset: CHARSETS.digits,
  minLength: 1,
  maxLength: 4,
  mask: 'summer?d?d',
  suffixDigits: 2,
  password: '',
}

export function parseWords(text: string): string[] {
  if (text.length > 5_000_000) throw new Error('Keep your wordlist under 5 MB.')
  const words = [
    ...new Set(text.split(/\r?\n/).filter((word) => word.length > 0)),
  ]
  if (!words.length)
    throw new Error('Add at least one word to your dictionary.')
  if (words.length > 100_000)
    throw new Error('Use at most 100,000 unique dictionary words.')
  if (words.some((word) => word.length > 256))
    throw new Error('Each dictionary word must be at most 256 characters.')
  return words
}

function variants(words: string[]): string[] {
  return [
    ...new Set(
      words.flatMap((word) => [
        word,
        word.toLowerCase(),
        word.toUpperCase(),
        word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
      ]),
    ),
  ]
}

export function maskPools(mask: string): string[][] {
  if (!mask || mask.length > 64)
    throw new Error('Use a pattern between 1 and 64 characters.')
  const tokens: Record<string, string> = {
    d: CHARSETS.digits,
    l: CHARSETS.lower,
    u: CHARSETS.upper,
    s: CHARSETS.symbols,
    '?': '?',
  }
  const chars = Array.from(mask)
  const pools: string[][] = []
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== '?') pools.push([chars[i]])
    else {
      const token = tokens[chars[++i]]
      if (!token)
        throw new Error(
          'Unknown pattern token. Use ?d, ?l, ?u, ?s or ?? for a literal question mark.',
        )
      pools.push(Array.from(token))
    }
  }
  return pools
}

function validate(config: SearchConfig) {
  if (
    !['dictionary', 'brute', 'hybrid', 'mask', 'known'].includes(config.method)
  )
    throw new Error('Choose a supported recovery method.')
  if (config.method === 'brute') {
    if (!config.charset || Array.from(config.charset).length > 100)
      throw new Error('Select between 1 and 100 unique characters.')
    if (
      !Number.isInteger(config.minLength) ||
      !Number.isInteger(config.maxLength) ||
      config.minLength < 1 ||
      config.maxLength > 12 ||
      config.maxLength < config.minLength
    )
      throw new Error(
        'Use lengths from 1 to 12, with the maximum at least the minimum.',
      )
  }
  if (
    config.method === 'hybrid' &&
    (!Number.isInteger(config.suffixDigits) ||
      config.suffixDigits < 1 ||
      config.suffixDigits > 3)
  )
    throw new Error('Choose 1, 2 or 3 suffix digits.')
  if (config.method === 'known' && config.password.length > 256)
    throw new Error('Passwords can be at most 256 characters.')
}

export function countCandidates(config: SearchConfig): number {
  validate(config)
  let count = 0
  if (config.method === 'known') count = 1
  if (config.method === 'dictionary') count = parseWords(config.words).length
  if (config.method === 'hybrid')
    count =
      variants(parseWords(config.words)).length *
      (1 + 10 ** config.suffixDigits)
  if (config.method === 'mask')
    count = maskPools(config.mask).reduce(
      (total, pool) => total * pool.length,
      1,
    )
  if (config.method === 'brute') {
    const length = new Set(Array.from(config.charset)).size
    for (let i = config.minLength; i <= config.maxLength; i++)
      count += length ** i
  }
  if (!Number.isSafeInteger(count) || count > SEARCH_LIMIT)
    throw new Error(
      'This search exceeds 5 million candidates. Narrow the length, character set or pattern.',
    )
  return count
}

function* combinations(pools: string[][]): Generator<string> {
  const indexes = Array(pools.length).fill(0) as number[]
  while (true) {
    yield pools.map((pool, i) => pool[indexes[i]]).join('')
    let position = pools.length - 1
    while (position >= 0 && ++indexes[position] === pools[position].length) {
      indexes[position] = 0
      position--
    }
    if (position < 0) break
  }
}

export function* candidates(config: SearchConfig): Generator<string> {
  countCandidates(config)
  if (config.method === 'known') yield config.password
  if (config.method === 'dictionary') yield* parseWords(config.words)
  if (config.method === 'hybrid') {
    const words = variants(parseWords(config.words))
    yield* words
    for (const word of words) {
      for (let n = 0; n < 10 ** config.suffixDigits; n++)
        yield word + String(n).padStart(config.suffixDigits, '0')
    }
  }
  if (config.method === 'mask') yield* combinations(maskPools(config.mask))
  if (config.method === 'brute') {
    const chars = [...new Set(Array.from(config.charset))]
    for (let length = config.minLength; length <= config.maxLength; length++)
      yield* combinations(Array.from({ length }, () => chars))
  }
}
