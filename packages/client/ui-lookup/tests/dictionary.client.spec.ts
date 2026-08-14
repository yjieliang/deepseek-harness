import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LookupSources } from '../src/client/dictionary.ts'
import {
  HttpError,
  defaultLookupSources,
  detectDirection,
  isNotFound,
  lookupWord,
  parseFreeDictionary,
  parseGoogleTranslate,
  parseMyMemory,
  parseWikipedia,
} from '../src/client/dictionary.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('detectDirection', () => {
  it('treats CJK text as zh-en', () => {
    expect(detectDirection('插件')).toBe('zh-en')
    expect(detectDirection('划词查询')).toBe('zh-en')
  })

  it('treats other text as en-zh', () => {
    expect(detectDirection('seam')).toBe('en-zh')
    expect(detectDirection('123')).toBe('en-zh')
  })
})

describe('parseMyMemory', () => {
  it('reads the translated text', () => {
    expect(parseMyMemory({ responseData: { translatedText: '接缝' } })).toBe('接缝')
  })

  it('returns undefined for missing, empty, or non-object payloads', () => {
    expect(parseMyMemory({})).toBeUndefined()
    expect(parseMyMemory({ responseData: { translatedText: '' } })).toBeUndefined()
    expect(parseMyMemory(null)).toBeUndefined()
  })
})

describe('parseFreeDictionary', () => {
  const entry = {
    word: 'seam',
    phonetic: '/siːm/',
    meanings: [
      {
        partOfSpeech: 'noun',
        definitions: [
          { definition: 'a line where two pieces of fabric are sewn together' },
          { definition: 'a thin line or layer' },
        ],
      },
      { partOfSpeech: 'verb', definitions: [{ definition: 'to join with a seam' }] },
    ],
  }

  it('reads phonetic and meaning groups', () => {
    expect(parseFreeDictionary([entry])).toEqual({
      phonetic: '/siːm/',
      meanings: [
        {
          partOfSpeech: 'noun',
          definitions: ['a line where two pieces of fabric are sewn together', 'a thin line or layer'],
        },
        { partOfSpeech: 'verb', definitions: ['to join with a seam'] },
      ],
    })
  })

  it('falls back to the first phonetics text when the top-level phonetic is absent', () => {
    expect(parseFreeDictionary([{ phonetics: [{ text: '/siːm/' }], meanings: [] }]))
      .toEqual({ phonetic: '/siːm/', meanings: [] })
  })

  it('caps meaning groups at three and definitions at three', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      partOfSpeech: `pos${i}`,
      definitions: Array.from({ length: 5 }, (_, j) => ({ definition: `def${i}-${j}` })),
    }))
    const parsed = parseFreeDictionary([{ meanings: many }])
    expect(parsed?.meanings?.length).toBe(3)
    expect(parsed?.meanings?.[0]?.definitions).toEqual(['def0-0', 'def0-1', 'def0-2'])
  })

  it('skips groups without definitions and non-array payloads', () => {
    expect(parseFreeDictionary([{ meanings: [{ partOfSpeech: 'x', definitions: [] }] }]))
      .toEqual({ meanings: [] })
    expect(parseFreeDictionary({})).toBeUndefined()
  })
})

describe('parseWikipedia', () => {
  it('reads a standard page extract', () => {
    expect(parseWikipedia({
      type: 'standard',
      extract: 'intro text',
      title: 'Seam',
      content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Seam' } },
    })).toEqual({
      extract: 'intro text',
      title: 'Seam',
      url: 'https://en.wikipedia.org/wiki/Seam',
    })
  })

  it('returns undefined for non-standard pages and missing extracts', () => {
    expect(parseWikipedia({ type: 'disambiguation', extract: 'x' })).toBeUndefined()
    expect(parseWikipedia({ type: 'standard' })).toBeUndefined()
    expect(parseWikipedia(null)).toBeUndefined()
  })
})

describe('parseGoogleTranslate', () => {
  it('joins the translated segments of a gtx response', () => {
    expect(parseGoogleTranslate([[['接缝', 'seam', null, null, 10]], null, 'en'])).toBe('接缝')
    expect(parseGoogleTranslate([[['a', null, null, null, 1], ['b', null, null, null, 1]], null, 'en'])).toBe('ab')
  })

  it('returns undefined for malformed payloads', () => {
    expect(parseGoogleTranslate(null)).toBeUndefined()
    expect(parseGoogleTranslate({})).toBeUndefined()
    expect(parseGoogleTranslate([])).toBeUndefined()
    expect(parseGoogleTranslate([['not-an-array']])).toBeUndefined()
  })
})

describe('defaultLookupSources.translate', () => {
  it('falls back to MyMemory when the Google endpoint fails', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const href = url
      if (href.includes('translate.googleapis.com')) throw new Error('Failed to fetch')
      return { ok: true, json: async () => ({ responseData: { translatedText: '接缝' } }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    await expect(defaultLookupSources.translate('en', 'zh-CN', 'seam', new AbortController().signal))
      .resolves.toBe('接缝')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns the Google translation when it answers', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => [[['接缝', 'seam', null, null, 10]], null, 'en'],
    }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(defaultLookupSources.translate('en', 'zh-CN', 'seam', new AbortController().signal))
      .resolves.toBe('接缝')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('lookupWord retry policy', () => {
  const signal = new AbortController().signal

  it('retries a rate-limited translate once and succeeds', async () => {
    let attempts = 0
    const result = await lookupWord('seam', {
      translate: async () => {
        attempts += 1
        if (attempts === 1) throw new HttpError(429)
        return '接缝'
      },
      dictionary: async () => undefined,
      wikipedia: async () => undefined,
    }, signal)
    expect(attempts).toBe(2)
    expect(result.errors).toEqual([])
    expect(result.translation).toBe('接缝')
  }, 5_000)

  it('records the rate-limit message when the retry also fails', async () => {
    const result = await lookupWord('seam', {
      translate: async () => { throw new HttpError(429) },
      dictionary: async () => undefined,
      wikipedia: async () => undefined,
    }, signal)
    expect(result.errors).toEqual(['HTTP 429'])
  }, 5_000)

  it('retries a network-dropped dictionary call once and succeeds', async () => {
    let attempts = 0
    const result = await lookupWord('seam', {
      translate: async () => '接缝',
      dictionary: async () => {
        attempts += 1
        if (attempts === 1) throw new Error('Failed to fetch')
        return { phonetic: '/siːm/', meanings: [] }
      },
      wikipedia: async () => undefined,
    }, signal)
    expect(attempts).toBe(2)
    expect(result.errors).toEqual([])
    expect(result.phonetic).toBe('/siːm/')
  }, 5_000)

  it('does not retry ordinary 500 failures', async () => {
    let attempts = 0
    const result = await lookupWord('seam', {
      translate: async () => {
        attempts += 1
        throw new HttpError(500)
      },
      dictionary: async () => undefined,
      wikipedia: async () => undefined,
    }, signal)
    expect(attempts).toBe(1)
    expect(result.errors).toEqual(['HTTP 500'])
  })
})

describe('lookupWord', () => {
  const signal = new AbortController().signal

  it('assembles every facet for an English word', async () => {
    const result = await lookupWord('seam', {
      translate: async () => '接缝',
      dictionary: async () => ({
        phonetic: '/siːm/',
        meanings: [{ partOfSpeech: 'noun', definitions: ['line'] }],
      }),
      wikipedia: async () => ({ extract: 'A seam is a line.', title: 'Seam' }),
    }, signal)
    expect(result).toMatchObject({
      word: 'seam',
      direction: 'en-zh',
      translation: '接缝',
      phonetic: '/siːm/',
      meanings: [{ partOfSpeech: 'noun', definitions: ['line'] }],
      intro: 'A seam is a line.',
      introTitle: 'Seam',
      errors: [],
    })
  })

  it('records translation and dictionary failures but treats a Wikipedia miss as silence', async () => {
    const result = await lookupWord('seam', {
      translate: async () => { throw new Error('translate down') },
      dictionary: async () => { throw new Error('dict down') },
      wikipedia: async () => { throw new HttpError(404) },
    }, signal)
    expect(result.errors).toEqual(['translate down', 'dict down'])
    expect(result.intro).toBeUndefined()
    expect(result.translation).toBeUndefined()
  })

  it('treats a dictionary 404 as an ordinary miss, not a failure', async () => {
    const result = await lookupWord('xyzzy', {
      translate: async () => '未收录',
      dictionary: async () => { throw new HttpError(404) },
      wikipedia: async () => undefined,
    }, signal)
    expect(result.errors).toEqual([])
    expect(result.meanings).toBeUndefined()
  })

  it('records a dictionary 500 as a failure', async () => {
    const result = await lookupWord('seam', {
      translate: async () => '接缝',
      dictionary: async () => { throw new HttpError(500) },
      wikipedia: async () => undefined,
    }, signal)
    expect(result.errors).toEqual(['HTTP 500'])
  })

  it('isNotFound narrows only HTTP 404 fetch failures', () => {
    expect(isNotFound(new HttpError(404))).toBe(true)
    expect(isNotFound(new HttpError(500))).toBe(false)
    expect(isNotFound(new Error('HTTP 404'))).toBe(false)
  })

  it('uses the zh-en path for CJK words and never consults the English dictionary', async () => {
    const result = await lookupWord('插件', {
      translate: async () => 'plugin',
      dictionary: async () => { throw new Error('must not be called') },
      wikipedia: async () => ({ extract: '插件是……', title: '插件' }),
    }, signal)
    expect(result).toMatchObject({
      word: '插件',
      direction: 'zh-en',
      translation: 'plugin',
      intro: '插件是……',
      errors: [],
    })
    expect(result.phonetic).toBeUndefined()
    expect(result.meanings).toBeUndefined()
  })

  it('passes the direction-corrected language pair to the translator', async () => {
    const seen: Array<[string, string]> = []
    const sources: LookupSources = {
      translate: async (from, to) => { seen.push([from, to]); return 'ok' },
      dictionary: async () => undefined,
      wikipedia: async () => undefined,
    }
    await lookupWord('seam', sources, signal)
    expect(seen).toEqual([['en', 'zh-CN']])
    seen.length = 0
    await lookupWord('插件', sources, signal)
    expect(seen).toEqual([['zh-CN', 'en']])
  })
})
