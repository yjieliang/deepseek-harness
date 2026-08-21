import { describe, expect, it } from 'vitest'
import { parseExplain } from '../src/index.ts'

describe('parseExplain', () => {
  it('parses a plain JSON object', () => {
    const result = parseExplain(JSON.stringify({
      word: 'seam',
      translation: '接缝',
      phonetic: '/siːm/',
      meanings: [{ partOfSpeech: 'noun', definitions: ['a line'] }],
      explanation: 'A seam is a line.',
    }), 'seam')
    expect(result).toEqual({
      word: 'seam',
      translation: '接缝',
      phonetic: '/siːm/',
      meanings: [{ partOfSpeech: 'noun', definitions: ['a line'] }],
      explanation: 'A seam is a line.',
    })
  })

  it('parses markdown-fenced JSON', () => {
    const result = parseExplain('```json\n{"translation": "接缝", "explanation": "A seam is a line."}\n```', 'seam')
    expect(result).toEqual({
      word: 'seam',
      translation: '接缝',
      explanation: 'A seam is a line.',
    })
  })

  it('filters malformed meanings and definitions', () => {
    const result = parseExplain(JSON.stringify({
      translation: '接缝',
      explanation: 'A seam is a line.',
      phonetic: '',
      meanings: [
        { partOfSpeech: 'noun', definitions: ['ok', '', 42, 'also ok'] },
        { partOfSpeech: 'verb', definitions: [] },
        'garbage',
      ],
    }), 'seam')
    expect(result).toEqual({
      word: 'seam',
      translation: '接缝',
      explanation: 'A seam is a line.',
      meanings: [{ partOfSpeech: 'noun', definitions: ['ok', 'also ok'] }],
    })
  })

  it('throws when the text carries no JSON object', () => {
    expect(() => parseExplain('the seam is here', 'seam')).toThrow(/no JSON object/)
    expect(() => parseExplain('', 'seam')).toThrow(/no JSON object/)
    // A JSON primitive has no braces, so it lands in the no-object branch too.
    expect(() => parseExplain('"just a string"', 'seam')).toThrow(/no JSON object/)
  })

  it('throws when translation or explanation is missing', () => {
    expect(() => parseExplain('{"translation": "接缝"}', 'seam')).toThrow(/lacked translation or explanation/)
    expect(() => parseExplain('{"explanation": "x"}', 'seam')).toThrow(/lacked translation or explanation/)
  })
})
