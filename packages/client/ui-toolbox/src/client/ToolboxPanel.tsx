/**
 * Developer toolbox panel: a floating overlay with ten tabbed widgets —
 * JSON format/validate, time conversion, regex testing, Base64, URL, text
 * translation, line diff, UUID generation, byte unit conversion, and cron
 * expression validation/description/next-run times. All compute client-side
 * except translation and UUID, which go through the injected `toolbox` Remote
 * calls.
 */

import type { PointerEvent as ReactPointerEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ToolboxPanelProps } from './contract.ts'
import css from './ToolboxPanel.module.css'

/** A translator over the toolbox locale keys; helpers accept any key via `string`. */
type Translator = (key: string, params?: Record<string, unknown>) => string

/** One base64 encode/decode helper, UTF-8 safe. */
const B64 = (() => {
  const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const encode = (input: string): string => {
    let out = ''
    const bytes = new TextEncoder().encode(input)
    for (let i = 0; i < bytes.length; i += 3) {
      const b0 = bytes[i]!
      const b1 = bytes[i + 1]
      const b2 = bytes[i + 2]
      out += CHARS[b0 >> 2]
      out += CHARS[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)]
      out += b1 === undefined ? '=' : CHARS[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)]
      out += b2 === undefined ? '=' : CHARS[b2 & 63]
    }
    return out
  }
  const decode = (input: string): string => {
    const clean = input.replace(/\s+/g, '')
    const bytes = new Uint8Array(clean.length * 3)
    let w = 0
    for (let i = 0; i < clean.length; i += 4) {
      const c0 = CHARS.indexOf(clean[i]!)
      const c1 = CHARS.indexOf(clean[i + 1]!)
      const c2 = CHARS.indexOf(clean[i + 2]!)
      const c3 = CHARS.indexOf(clean[i + 3]!)
      if (c0 < 0 || c1 < 0) throw new Error('invalid base64 character')
      const n = (c0 << 18) | (c1 << 12) | ((c2 < 0 ? 0 : c2) << 6) | (c3 < 0 ? 0 : c3)
      bytes[w++] = (n >> 16) & 255
      if (c2 >= 0) bytes[w++] = (n >> 8) & 255
      if (c3 >= 0) bytes[w++] = n & 255
    }
    return new TextDecoder().decode(bytes.subarray(0, w))
  }
  return { encode, decode }
})()

/** Large language codes for the translation widget. */
const LANGS: Array<[string, string]> = [
  ['auto', '自动检测'], ['zh-CN', '中文(简体)'], ['zh-TW', '中文(繁体)'], ['en', '英语'],
  ['ja', '日语'], ['ko', '韩语'], ['fr', '法语'], ['de', '德语'], ['es', '西班牙语'],
  ['ru', '俄语'], ['pt', '葡萄牙语'], ['it', '意大利语'], ['ar', '阿拉伯语'],
]

function JsonWidget({ t }: { t: Translator }) {
  const [text, setText] = useState('')
  const [out, setOut] = useState('')
  const [err, setErr] = useState('')
  const [space, setSpace] = useState(2)
  const run = (mode: 'pretty' | 'minify' | 'validate') => {
    if (text.trim().length === 0) { setOut(''); setErr(''); return }
    try {
      const parsed = JSON.parse(text)
      if (mode === 'validate') {
        setOut('')
        setErr('\u2713 JSON 有效，类型：' + (Array.isArray(parsed) ? '数组' : typeof parsed === 'object' && parsed !== null ? '对象' : typeof parsed))
        return
      }
      setOut(JSON.stringify(parsed, null, mode === 'pretty' ? space : 0))
      setErr('')
    } catch (error) {
      setOut('')
      const message = error instanceof Error ? error.message : String(error)
      const position = typeof (error as { position?: unknown }).position === 'number'
        ? '（位置 ' + String((error as { position: number }).position) + '）' : ''
      setErr('JSON 解析错误' + position + '：' + message)
    }
  }
  return (
    <div className={css.column}>
      <div className={css.row}>
        <span className={css.label}>{t('json')}</span>
        <select className={css.select} value={space} onChange={e => setSpace(Number(e.target.value))}>
          {[2, 4].map(n => <option key={n} value={n}>{n} {t('indent')}</option>)}
        </select>
        <button className={css.primary} onClick={() => run('pretty')}>{t('pretty')}</button>
        <button className={css.btn} onClick={() => run('minify')}>{t('minify')}</button>
        <button className={css.btn} onClick={() => run('validate')}>{t('validate')}</button>
      </div>
      <textarea className={css.textarea} value={text} onChange={e => setText(e.target.value)} placeholder={t('jsonPlaceholder')} />
      {err !== '' && <div className={css.error}>{err}</div>}
      {out !== '' && <pre className={css.out}>{out}</pre>}
    </div>
  )
}

/** Timezone selector options (IANA ids plus common fixed-offset labels). */
const TIMEZONES: Array<[string, string]> = [
  ['local', '本地时区'],
  ['Asia/Shanghai', 'Asia/Shanghai'],
  ['UTC', 'UTC'],
  ['Asia/Tokyo', 'Asia/Tokyo'],
  ['Asia/Seoul', 'Asia/Seoul'],
  ['America/New_York', 'America/New_York'],
  ['America/Los_Angeles', 'America/Los_Angeles'],
  ['Europe/London', 'Europe/London'],
  ['Europe/Berlin', 'Europe/Berlin'],
  ['Asia/Kolkata', 'Asia/Kolkata'],
]

/** Resolve the configured timezone to an IANA id; `local` uses the browser zone. */
function resolveTz(tz: string): string | undefined {
  return tz === 'local' ? undefined : tz
}

/** The UTC offset (minutes) of a timezone at a given instant; positive east of UTC. */
function tzOffsetMinutes(tz: string | undefined, at: Date): number {
  if (tz === undefined) return -at.getTimezoneOffset()
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(at)
  const offsetPart = parts.find(p => p.type === 'timeZoneName')?.value ?? ''
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(offsetPart)
  if (m === null) return 0
  const sign = m[1] === '-' ? -1 : 1
  const hours = Number(m[2])
  const minutes = m[3] === undefined ? 0 : Number(m[3])
  return sign * (hours * 60 + minutes)
}

/** Format a Date as a `YYYY-MM-DD HH:mm:ss` wall-clock string in a timezone. */
function formatWallClock(date: Date, tz: string | undefined): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date).reduce<Record<string, string>>((acc, p) => {
    acc[p.type] = p.value
    return acc
  }, {})
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
}

/** Parse `YYYY-MM-DD HH:mm:ss` as a wall-clock time in a timezone, returning epoch ms. */
function parseWallClock(input: string, tz: string | undefined): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(input.trim())
  if (m === null) return Number.NaN
  const years = Number(m[1])
  const months = Number(m[2]) - 1
  const days = Number(m[3])
  const hours = Number(m[4])
  const minutes = Number(m[5])
  const seconds = Number(m[6])
  // Treat the parsed fields as the desired timezone's wall-clock, then correct to UTC.
  const asUtc = Date.UTC(years, months, days, hours, minutes, seconds)
  const probe = new Date(asUtc)
  const offset = tzOffsetMinutes(tz, probe)
  return asUtc - offset * 60_000
}

function TimeWidget({ t }: { t: Translator }) {
  const [tab, setTab] = useState<'single' | 'batch'>('single')
  // Live current timestamp.
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [nowUnit, setNowUnit] = useState<'s' | 'ms'>('s')
  const [paused, setPaused] = useState(false)
  // 时间戳 → 日期
  const [tsInput, setTsInput] = useState('')
  const [tsUnit, setTsUnit] = useState<'s' | 'ms'>('s')
  const [tsTz, setTsTz] = useState('local')
  const [tsResult, setTsResult] = useState('')
  const [tsErr, setTsErr] = useState('')
  // 日期 → 时间戳
  const [dtInput, setDtInput] = useState('')
  const [dtTz, setDtTz] = useState('local')
  const [dtUnit, setDtUnit] = useState<'s' | 'ms'>('ms')
  const [dtResult, setDtResult] = useState('')
  const [dtErr, setDtErr] = useState('')
  const [copied, setCopied] = useState(false)

  // Tick the live clock once per second unless paused.
  useEffect(() => {
    if (paused) return
    const id = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [paused])

  const nowDisplay = nowUnit === 's' ? Math.floor(nowMs / 1000) : nowMs
  const nowWall = useMemo(() => formatWallClock(new Date(nowMs), undefined), [nowMs])
  const nowWallTz = useMemo(() => formatWallClock(new Date(nowMs), resolveTz(tsTz)), [nowMs, tsTz])

  const emitNow = () => {
    setTsInput(String(nowUnit === 's' ? Math.floor(Date.now() / 1000) : Date.now()))
    // If converting from current instant in the chosen unit, run immediately.
    setTsErr('')
    const stamp = nowUnit === 's' ? Math.floor(Date.now() / 1000) : Date.now()
    const date = new Date(nowUnit === 's' ? stamp * 1000 : stamp)
    setTsResult(formatWallClock(date, resolveTz(tsTz)))
  }

  const convertTs = () => {
    const raw = tsInput.trim()
    if (raw.length === 0) { setTsResult(''); setTsErr(''); return }
    const value = Number(raw)
    if (!Number.isFinite(value) || !/^-?\d+$/.test(raw)) { setTsResult(''); setTsErr('请输入整数时间戳'); return }
    const ms = tsUnit === 's' ? value * 1000 : value
    const date = new Date(ms)
    if (Number.isNaN(date.getTime())) { setTsResult(''); setTsErr('时间戳超出可表示范围'); return }
    setTsErr('')
    setTsResult(formatWallClock(date, resolveTz(tsTz)))
  }

  const convertDt = () => {
    const raw = dtInput.trim()
    if (raw.length === 0) { setDtResult(''); setDtErr(''); return }
    const epoch = parseWallClock(raw, resolveTz(dtTz))
    if (Number.isNaN(epoch)) { setDtResult(''); setDtErr('格式应为 YYYY-MM-DD HH:mm:ss'); return }
    setDtErr('')
    setDtResult(String(dtUnit === 's' ? Math.floor(epoch / 1000) : epoch))
  }

  const copyText = (value: string) => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    }).catch(() => { setCopied(true) })
  }

  const singleView = (
    <div className={css.column}>
      <div className={css.card}>
        <div className={css.sectionHead}><span className={css.sectionIcon}>🕒</span>{t('tsToDate')}</div>
        <div className={css.fieldRow}>
          <div className={css.field}>
            <span className={css.fieldLabel}>{t('timestamp')}</span>
            <input className={css.input} value={tsInput} onChange={e => setTsInput(e.target.value)} placeholder="1787565892901" />
          </div>
          <select className={css.select} value={tsUnit} onChange={e => setTsUnit(e.target.value as 's' | 'ms')}>
            <option value="s">{t('seconds')}</option>
            <option value="ms">{t('milliseconds')}</option>
          </select>
          <select className={css.select} value={tsTz} onChange={e => setTsTz(e.target.value)}>
            {TIMEZONES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <button className={css.btn} onClick={emitNow}>{t('fillNow')}</button>
          <button className={css.primary} onClick={convertTs}>{t('convert')}</button>
        </div>
        <div className={css.fieldRow}>
          <div className={css.field}>
            <span className={css.fieldLabel}>{t('result')}</span>
            <div className={css.resultBox}>{tsErr !== '' ? <span className={css.error}>{tsErr}</span> : tsResult}</div>
          </div>
          <button className={css.btn} onClick={() => copyText(tsResult)} disabled={tsResult.length === 0}>{copied ? t('copied') : t('copy')}</button>
        </div>
      </div>

      <div className={css.card}>
        <div className={css.sectionHead}><span className={css.sectionIcon}>📅</span>{t('dateToTs')}</div>
        <div className={css.fieldRow}>
          <div className={css.field}>
            <span className={css.fieldLabel}>{t('datetime')}</span>
            <input className={css.input} value={dtInput} onChange={e => setDtInput(e.target.value)} placeholder="2026-08-24 18:04:52" />
          </div>
          <select className={css.select} value={dtTz} onChange={e => setDtTz(e.target.value)}>
            {TIMEZONES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          <button className={css.primary} onClick={convertDt}>{t('convert')}</button>
        </div>
        <div className={css.fieldRow}>
          <div className={css.field}>
            <span className={css.fieldLabel}>{t('result')}</span>
            <div className={css.resultBox}>{dtErr !== '' ? <span className={css.error}>{dtErr}</span> : dtResult}</div>
          </div>
          <select className={css.select} value={dtUnit} onChange={e => setDtUnit(e.target.value as 's' | 'ms')}>
            <option value="s">{t('seconds')}</option>
            <option value="ms">{t('milliseconds')}</option>
          </select>
          <button className={css.btn} onClick={() => copyText(dtResult)} disabled={dtResult.length === 0}>{copied ? t('copied') : t('copy')}</button>
        </div>
      </div>
    </div>
  )

  const batchView = (
    <div className={css.column}>
      <div className={css.card}>
        <div className={css.sectionHead}><span className={css.sectionIcon}>🕒</span>{t('tsToDate')} · {t('batch')}</div>
        <textarea className={css.textarea} placeholder={t('batchPlaceholder')} />
        <button className={css.primary}>{t('convert')}</button>
      </div>
    </div>
  )

  return (
    <div className={css.column}>
      <div className={css.nowCard}>
        <span className={css.fieldLabel}>{t('currentTs')}</span>
        <div className={css.nowRow}>
          <span className={css.nowValue}>{String(nowDisplay)}</span>
          <span className={css.nowUnit}>{nowUnit === 's' ? t('seconds') : t('milliseconds')}</span>
          <span className={css.nowWall}>{nowWall}</span>
          <button className={css.btn} onClick={() => setNowUnit(u => u === 's' ? 'ms' : 's')}>{t('switchUnit')}</button>
          <button className={css.btn} onClick={() => copyText(String(nowDisplay))}>{copied ? t('copied') : t('copy')}</button>
          <button className={css.btnRed} onClick={() => setPaused(p => !p)}>{paused ? t('resume') : t('pause')}</button>
        </div>
      </div>
      <div className={css.modeTabs}>
        <button className={tab === 'single' ? css.modeTabActive : css.modeTab} onClick={() => setTab('single')}>{t('singleMode')}</button>
        <button className={tab === 'batch' ? css.modeTabActive : css.modeTab} onClick={() => setTab('batch')}>{t('batchMode')}</button>
      </div>
      {tab === 'single' ? singleView : batchView}
      <div className={css.hint}>{t('liveWallHint')}：{nowWallTz}</div>
    </div>
  )
}

function RegexWidget({ t }: { t: Translator }) {
  const [pat, setPat] = useState('')
  const [flags, setFlags] = useState('g')
  const [text, setText] = useState('')
  const [items, setItems] = useState<Array<{ full: string; index: number; groups: Array<{ i: number; v: string | null }> }>>([])
  const [source, setSource] = useState('')
  const [err, setErr] = useState('')
  const test = () => {
    let src = pat
    const m = /^\/(.*)\/([a-z]*)$/s.exec(pat.trim())
    if (m !== null && m[1] !== undefined && m[1] !== '') { src = m[1]; setFlags(m[2] ?? '') }
    let re: RegExp
    try { re = new RegExp(src, flags) } catch (error) { setItems([]); setErr('正则语法错误：' + String(error instanceof Error ? error.message : error)); return }
    setErr('')
    const res: Array<{ full: string; index: number; groups: Array<{ i: number; v: string | null }> }> = []
    if (flags.includes('g')) {
      const rr = new RegExp(src, flags)
      let mm: RegExpExecArray | null
      while ((mm = rr.exec(text)) !== null) {
        res.push({ full: mm[0], index: mm.index, groups: mm.slice(1).map((g, i) => ({ i: i + 1, v: g === undefined ? null : g })) })
        if (mm[0] === '') rr.lastIndex++
      }
    } else {
      const mm = re.exec(text)
      if (mm !== null) res.push({ full: mm[0], index: mm.index, groups: mm.slice(1).map((g, i) => ({ i: i + 1, v: g === undefined ? null : g })) })
    }
    setItems(res)
    setSource(src)
  }
  return (
    <div className={css.column}>
      <div className={css.row}>
        <span className={css.label}>{t('regex')}</span>
        <input className={css.input} value={pat} onChange={e => setPat(e.target.value)} placeholder={t('regexPlaceholder')} />
        <input className={css.smallInput} value={flags} onChange={e => setFlags(e.target.value)} placeholder="g" />
        <button className={css.primary} onClick={test}>{t('test')}</button>
      </div>
      <textarea className={css.textarea} value={text} onChange={e => setText(e.target.value)} placeholder="在此输入要匹配的文本…" />
      {err !== '' && <div className={css.error}>{err}</div>}
      {items.length > 0 && <div className={css.hint}>共 {items.length} 处匹配（/{source}/{flags}）</div>}
      {items.length > 0 && <pre className={css.out}>{items.map((it, idx) => '#' + (idx + 1) + ' @' + it.index + '  ' + it.full + (it.groups.some(g => g.v !== null) ? '\n  分组: ' + it.groups.map(g => '$' + g.i + '=' + (g.v === null ? '(未捕获)' : g.v)).join('  ') : '')).join('\n')}</pre>}
    </div>
  )
}

function B64Widget({ t }: { t: Translator }) {
  const [mode, setMode] = useState<'encode' | 'decode'>('encode')
  const [inp, setInp] = useState('')
  const [out, setOut] = useState('')
  const [err, setErr] = useState('')
  const run = () => {
    if (inp.length === 0) { setOut(''); setErr(''); return }
    try { setOut(mode === 'encode' ? B64.encode(inp) : B64.decode(inp)); setErr('') }
    catch (error) { setOut(''); setErr(error instanceof Error ? error.message : String(error)) }
  }
  return (
    <div className={css.column}>
      <div className={css.row}>
        <span className={css.label}>{t('b64')}</span>
        <select className={css.select} value={mode} onChange={e => setMode(e.target.value as 'encode' | 'decode')}>
          <option value="encode">编码 (文本→Base64)</option>
          <option value="decode">解码 (Base64→文本)</option>
        </select>
        <button className={css.primary} onClick={run}>{t('convert')}</button>
      </div>
      <textarea className={css.textarea} value={inp} onChange={e => setInp(e.target.value)} placeholder={t('b64Placeholder')} />
      {err !== '' && <div className={css.error}>{err}</div>}
      {out !== '' && <pre className={css.out}>{out}</pre>}
    </div>
  )
}

function UrlWidget({ t }: { t: Translator }) {
  const [mode, setMode] = useState<'encode' | 'decode' | 'encfull' | 'decfull'>('encode')
  const [inp, setInp] = useState('')
  const [out, setOut] = useState('')
  const [err, setErr] = useState('')
  const run = () => {
    if (inp.length === 0) { setOut(''); setErr(''); return }
    try {
      const f = { encode: encodeURIComponent, decode: decodeURIComponent, encfull: encodeURI, decfull: decodeURI }[mode]
      setOut(f(inp)); setErr('')
    } catch (error) { setOut(''); setErr(error instanceof Error ? error.message : String(error)) }
  }
  return (
    <div className={css.column}>
      <div className={css.row}>
        <span className={css.label}>{t('url')}</span>
        <select className={css.select} value={mode} onChange={e => setMode(e.target.value as typeof mode)}>
          <option value="encode">encodeURIComponent</option>
          <option value="decode">decodeURIComponent</option>
          <option value="encfull">encodeURI</option>
          <option value="decfull">decodeURI</option>
        </select>
        <button className={css.primary} onClick={run}>{t('convert')}</button>
      </div>
      <textarea className={css.textarea} value={inp} onChange={e => setInp(e.target.value)} placeholder={t('urlPlaceholder')} />
      {err !== '' && <div className={css.error}>{err}</div>}
      {out !== '' && <pre className={css.out}>{out}</pre>}
    </div>
  )
}

function TranslateWidget({ t, translate }: { t: Translator; translate: ToolboxPanelProps['translate'] }) {
  const [text, setText] = useState('')
  const [sl, setSl] = useState('auto')
  const [tl, setTl] = useState('zh-CN')
  const [engine, setEngine] = useState<'api' | 'model'>('api')
  const [out, setOut] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async () => {
    if (text.trim().length === 0) { setOut(''); setErr(''); return }
    setBusy(true); setErr(''); setOut('')
    try {
      const res = await translate({ text, source: sl, target: tl, engine })
      if (res.error !== undefined) { setErr(res.error); return }
      setOut(res.text || '')
    } catch (error) {
      setErr('翻译请求失败：' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={css.column}>
      <div className={css.row}>
        <span className={css.label}>{t('translate')}</span>
        <select className={css.select} value={engine} onChange={e => setEngine(e.target.value as 'api' | 'model')}>
          <option value="api">{t('freeApi')}</option>
          <option value="model">{t('currentModel')}</option>
        </select>
        <button className={css.primary} onClick={run} disabled={busy}>{busy ? t('translating') : t('translateButton')}</button>
      </div>
      <div className={css.row}>
        <select className={css.select} value={sl} onChange={e => setSl(e.target.value)}>
          {LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <button className={css.btn} onClick={() => { setSl(tl); setTl(sl) }}>⇄</button>
        <select className={css.select} value={tl} onChange={e => setTl(e.target.value)}>
          {LANGS.filter(([v]) => v !== 'auto').map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      <textarea className={css.textarea} value={text} onChange={e => setText(e.target.value)} placeholder={t('translatePlaceholder')} style={{ minHeight: 140 }} />
      {err !== '' && <div className={css.error}>{err}</div>}
      {out !== '' && <pre className={css.out} style={{ maxHeight: 300 }}>{out}</pre>}
    </div>
  )
}

/** LCS line diff producing same/add/del operations. */
function lineDiff(a: string, b: string): Array<{ t: 'same' | 'add' | 'del'; v: string }> {
  const la = a.split('\n')
  const lb = b.split('\n')
  const n = la.length
  const m = lb.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = la[i] === lb[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const ops: Array<{ t: 'same' | 'add' | 'del'; v: string }> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (la[i] === lb[j]) { ops.push({ t: 'same', v: la[i]! }); i++; j++ }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { ops.push({ t: 'del', v: la[i]! }); i++ }
    else { ops.push({ t: 'add', v: lb[j]! }); j++ }
  }
  while (i < n) { ops.push({ t: 'del', v: la[i]! }); i++ }
  while (j < m) { ops.push({ t: 'add', v: lb[j]! }); j++ }
  return ops
}

function DiffWidget({ t }: { t: Translator }) {
  const [left, setLeft] = useState('')
  const [right, setRight] = useState('')
  const [ops, setOps] = useState<Array<{ t: 'same' | 'add' | 'del'; v: string }>>([])
  const [ran, setRan] = useState(false)
  const run = () => { setOps(lineDiff(left, right)); setRan(true) }
  return (
    <div className={css.column}>
      <div className={css.row}>
        <span className={css.label}>{t('diff')}</span>
        <button className={css.primary} onClick={run}>{t('compare')}</button>
        {ran && <span className={css.hint}>{ops.filter(o => o.t !== 'same').length} {t('diffChanges')}</span>}
      </div>
      <textarea className={css.textarea} value={left} onChange={e => setLeft(e.target.value)} placeholder={t('diffPlaceholderA')} style={{ minHeight: 110 }} />
      <textarea className={css.textarea} value={right} onChange={e => setRight(e.target.value)} placeholder={t('diffPlaceholderB')} style={{ minHeight: 110 }} />
      {ran && (
        <div className={css.diff}>
          {ops.map((op, idx) => {
            if (op.t === 'same') return <pre key={idx}><span className={css.lineNo}>  </span>{op.v}</pre>
            if (op.t === 'del') return <pre key={idx} className={css.del}><span className={css.lineNo}>-</span>{op.v}</pre>
            return <pre key={idx} className={css.add}><span className={css.lineNo}>+</span>{op.v}</pre>
          })}
        </div>
      )}
    </div>
  )
}

function UuidWidget({ t, uuid }: { t: Translator; uuid: ToolboxPanelProps['uuid'] }) {
  const [count, setCount] = useState(1)
  const [v4, setV4] = useState('')
  const [v1, setV1] = useState('')
  const [err, setErr] = useState('')
  const gen = async () => {
    setErr('')
    try {
      const res = await uuid(Number(count) || 1)
      if (res.error !== undefined) { setErr(res.error); return }
      setV4(res.v4.join('\n'))
      setV1(res.v1.join('\n'))
    } catch (error) {
      setErr('生成失败：' + (error instanceof Error ? error.message : String(error)))
    }
  }
  return (
    <div className={css.column}>
      <div className={css.row}>
        <span className={css.label}>{t('uuid')}</span>
        <input className={css.countInput} type="number" min={1} max={100} value={count} onChange={e => setCount(Number(e.target.value))} />
        <button className={css.primary} onClick={gen}>{t('generate')}</button>
      </div>
      {err !== '' && <div className={css.error}>{err}</div>}
      {v4 !== '' && <div><div className={css.hint}>{t('uuidV4')}</div><pre className={css.out} style={{ maxHeight: 160 }}>{v4}</pre></div>}
      {v1 !== '' && <div><div className={css.hint}>{t('uuidV1')}</div><pre className={css.out} style={{ maxHeight: 160 }}>{v1}</pre></div>}
    </div>
  )
}

/** A byte unit with its label and conversion factor relative to one byte. */
interface ByteUnit { label: string; factor: number }

/** Byte units: decimal (1000-based) and binary (1024-based) names. */
const BYTE_UNITS: ByteUnit[] = (() => {
  const dec = (name: string, exp: number): ByteUnit => ({ label: name, factor: 1000 ** exp })
  const bin = (name: string, exp: number): ByteUnit => ({ label: name, factor: 1024 ** exp })
  return [
    { label: 'B', factor: 1 },
    dec('KB', 1), dec('MB', 2), dec('GB', 3), dec('TB', 4), dec('PB', 5),
    bin('KiB', 1), bin('MiB', 2), bin('GiB', 3), bin('TiB', 4), bin('PiB', 5),
  ]
})()

/** Convert a byte value between units; returns a display string like "1.5 MiB". */
function byteConvert(value: number, from: ByteUnit, to: ByteUnit): string {
  const bytes = value * from.factor
  const result = bytes / to.factor
  const precision = Number.isInteger(result) ? 0 : Math.min(4, Math.max(2, Math.abs(result) < 0.01 ? 6 : 4))
  const formatted = result.toFixed(precision).replace(/\.?0+$/, '')
  return `${formatted} ${to.label}`
}

function BytesWidget({ t }: { t: Translator }) {
  const [value, setValue] = useState('')
  const [from, setFrom] = useState('MB')
  const [to, setTo] = useState('GB')
  const [out, setOut] = useState('')
  const [err, setErr] = useState('')
  const units = BYTE_UNITS.map(u => u.label)
  const run = () => {
    const raw = value.trim()
    if (raw.length === 0) { setOut(''); setErr(''); return }
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) { setOut(''); setErr('请输入非负数值'); return }
    const fromUnit = BYTE_UNITS.find(u => u.label === from)
    const toUnit = BYTE_UNITS.find(u => u.label === to)
    if (fromUnit === undefined || toUnit === undefined) { setOut(''); setErr('未知单位'); return }
    setErr('')
    setOut(byteConvert(n, fromUnit, toUnit))
  }
  return (
    <div className={css.column}>
      <div className={css.row}>
        <span className={css.label}>{t('bytes')}</span>
        <input className={css.input} value={value} onChange={e => setValue(e.target.value)} placeholder="数值，如 2048 或 1.5" />
        <select className={css.select} value={from} onChange={e => setFrom(e.target.value)}>
          {units.map(u => <option key={u} value={u}>{u}</option>)}
        </select>
        <button className={css.btn} onClick={() => { setFrom(to); setTo(from) }}>⇄</button>
        <select className={css.select} value={to} onChange={e => setTo(e.target.value)}>
          {units.map(u => <option key={u} value={u}>{u}</option>)}
        </select>
        <button className={css.primary} onClick={run}>{t('convert')}</button>
      </div>
      <div className={css.hint}>{t('decimalPrefix')}: KB=1000B · {t('binaryPrefix')}: KiB=1024B</div>
      {err !== '' && <div className={css.error}>{err}</div>}
      {out !== '' && <pre className={css.out}>{out}</pre>}
    </div>
  )
}

/** Cron field bounds and aliases; year is used only by the 6-field form. */
const CRON_FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 },
  { name: 'year', min: 1970, max: 2099 },
]
const CRON_ALIASES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

/** Parse a cron field into the accepted value set; throws on invalid syntax. */
function parseCronField(expr: string, meta: { min: number; max: number }): Set<number> {
  const v = expr.trim().toLowerCase()
  const values = new Set<number>()
  const resolve = (s: string): number => {
    const num = parseInt(s, 10)
    if (!Number.isNaN(num)) return num
    const alias = CRON_ALIASES[s]
    if (alias !== undefined) return alias
    throw new Error(`未知值 "${s}"`)
  }
  const range = (start: number, end: number) => {
    if (start < meta.min || end > meta.max || start > end) throw new Error(`范围 ${start}-${end} 超出 ${meta.min}-${meta.max}`)
    values.add(start)
    for (let i = start + 1; i <= end; i++) values.add(i)
  }
  for (const seg of v === '*' ? ['*'] : v.split(',')) {
    const s = seg.trim()
    if (s === '*') { range(meta.min, meta.max); continue }
    const step = s.match(/^(.+?)\/(\d+)$/)
    if (step !== null) {
      const st = parseInt(step[2]!, 10)
      if (st <= 0) throw new Error(`非法步长 "${step[2]}"`)
      let start: number
      let end: number
      if (step[1] === '*') { start = meta.min; end = meta.max }
      else {
        const r = step[1]!.match(/^(\d+)(?:-(\d+))?$/)
        if (r === null) throw new Error(`非法范围 "${step[1]}"`)
        start = resolve(r[1]!)
        end = r[2] === undefined ? meta.max : resolve(r[2])
      }
      if (start < meta.min || end > meta.max || start > end) throw new Error(`范围 ${start}-${end} 超出 ${meta.min}-${meta.max}`)
      for (let i = start; i <= end; i += st) values.add(i)
      continue
    }
    const r = s.match(/^(\d+)-(\d+)$/)
    if (r !== null) { range(resolve(r[1]!), resolve(r[2]!)); continue }
    const one = resolve(s)
    if (one < meta.min || one > meta.max) throw new Error(`值 ${one} 超出 ${meta.min}-${meta.max}`)
    values.add(one)
  }
  if (values.size === 0) throw new Error(`空字段 "${expr}"`)
  return values
}

/** Describe a cron field as a short readout. */
function describeCronField(values: Set<number>, all: boolean, unit: string, max: number, label?: (v: number) => string): string {
  const fmt = (v: number): string => (label === undefined ? String(v) : label(v))
  if (all) return `每${unit}`
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return `每${unit}`
  if (sorted.length === 1) return `${fmt(sorted[0]!)}${unit}`
  const step = sorted[1]! - sorted[0]!
  const isStep = step > 1 && sorted.every((v, i) => i === 0 || v - sorted[i - 1]! === step)
  if (isStep && sorted[0]! === 0 && sorted[sorted.length - 1]! + step > max) return `每${step}${unit}`
  if (isStep) return `${fmt(sorted[0]!)}-${fmt(sorted[sorted.length - 1]!)}${unit}每${step}`
  const ranges: string[] = []
  let start = sorted[0]!
  let prev = sorted[0]!
  const push = () => ranges.push(start === prev ? fmt(start) : `${fmt(start)}-${fmt(prev)}`)
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]! - prev > 1) { push(); start = sorted[i]! }
    prev = sorted[i]!
  }
  push()
  return ranges.join('、') + unit
}

/** Compute the next N matching UTC instants after the reference time. */
function cronNextRuns(expr: string, count: number, reference: Date): string[] {
  const parts = expr.trim().split(/\s+/)
  const parsed = parts.map((p, i) => parseCronField(p, CRON_FIELDS[i]!))
  const m: Set<number> = parsed[0]!
  const h: Set<number> = parsed[1]!
  const dom: Set<number> = parsed[2]!
  const mon: Set<number> = parsed[3]!
  const dow: Set<number> = parsed[4]!
  const yr: Set<number> | undefined = parsed[5]
  const results: string[] = []
  let guard = 0
  for (let year = reference.getUTCFullYear(); year <= 2099 && results.length < count; year++) {
    if (yr !== undefined && !yr.has(year)) continue
    for (let month = 1; month <= 12 && results.length < count; month++) {
      if (!mon.has(month)) continue
      const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
      for (let day = 1; day <= days && results.length < count; day++) {
        if (!dom.has(day)) continue
        const wd = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
        const norm = wd === 0 ? 7 : wd
        if (!dow.has(norm) && !dow.has(wd === 0 ? 0 : norm)) continue
        for (let hour = 0; hour <= 23 && results.length < count; hour++) {
          if (!h.has(hour)) continue
          for (let minute = 0; minute <= 59 && results.length < count; minute++) {
            if (!m.has(minute)) continue
            const at = Date.UTC(year, month - 1, day, hour, minute)
            if (++guard > 4000) return results
            if (at > reference.getTime()) results.push(new Date(at).toISOString())
          }
        }
      }
    }
  }
  return results
}

/** Clock day-of-week index to a short Chinese weekday name (0 = Sunday). */
const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** Build a Chinese description of a valid cron expression. */
function describeCron(parsed: Set<number>[]): string {
  const m: Set<number> = parsed[0]!
  const h: Set<number> = parsed[1]!
  const dom: Set<number> = parsed[2]!
  const mon: Set<number> = parsed[3]!
  const dow: Set<number> = parsed[4]!
  const yr: Set<number> | undefined = parsed[5]
  const mAll = m.size === 60
  const hAll = h.size === 24
  const domAll = dom.size === 31
  const monAll = mon.size === 12
  const dowAll = dow.size === 8
  const dowLabel = (v: number): string => WEEKDAY_NAMES[v % 7]!
  const chunks: string[] = []
  if (mAll && hAll) chunks.push('每分钟')
  else if (hAll) chunks.push(describeCronField(m, false, '分钟', 59))
  else if (mAll) chunks.push(describeCronField(h, false, '点', 23))
  else chunks.push(describeCronField(h, false, '点', 23) + describeCronField(m, false, '分', 59))
  if (!domAll) chunks.push('每月第 ' + describeCronField(dom, false, '天', 31))
  if (!monAll) chunks.push(describeCronField(mon, false, '月', 12))
  if (!dowAll) chunks.push('每' + describeCronField(dow, false, '', 7, dowLabel))
  if (yr !== undefined && yr.size !== 130) chunks.push(describeCronField(yr, false, '年', 2099))
  if (chunks.length === 0) chunks.push('每分钟')
  return chunks.join('，') + '执行'
}

/** Common cron expression shortcuts: [expression, label]. */
const CRON_PRESETS: Array<[string, string]> = [
  ['*/5 * * * *', '每 5 分钟'],
  ['0 * * * *', '每小时整点'],
  ['0 9 * * *', '每天 09:00'],
  ['0 9 * * 1', '周一 09:00'],
  ['0 0 1 * *', '每月 1 号'],
]

function CronWidget({ t }: { t: Translator }) {
  const [expr, setExpr] = useState('')
  const [action, setAction] = useState<'validate' | 'describe' | 'next'>('describe')
  const [count, setCount] = useState(5)
  const [valid, setValid] = useState<boolean | null>(null)
  const [desc, setDesc] = useState('')
  const [next, setNext] = useState<string[]>([])
  const [err, setErr] = useState('')

  const execute = (rawInput: string, act: 'validate' | 'describe' | 'next') => {
    const raw = rawInput.trim()
    if (raw.length === 0) { setValid(null); setDesc(''); setNext([]); setErr(''); return }
    try {
      const parts = raw.split(/\s+/)
      if (parts.length < 5 || parts.length > 6) {
        throw new Error(`Cron 表达式须为 5 或 6 个字段（当前 ${parts.length} 个）：分 时 日 月 周 [年]`)
      }
      const parsed = parts.map((p, i) => parseCronField(p, CRON_FIELDS[i]!))
      setValid(true); setErr('')
      if (act === 'describe' || act === 'next') setDesc(describeCron(parsed))
      else setDesc('')
      setNext(act === 'next' ? cronNextRuns(raw, Math.min(Math.max(count, 1), 100), new Date()) : [])
    } catch (error) {
      setValid(false); setDesc(''); setNext([])
      setErr(error instanceof Error ? error.message : String(error))
    }
  }

  const pick = (act: 'validate' | 'describe' | 'next') => {
    setAction(act)
    execute(expr, act)
  }

  const applyPreset = (value: string) => {
    setExpr(value)
    setAction('describe')
    execute(value, 'describe')
  }

  return (
    <div className={css.column}>
      <div className={css.row}>
        <span className={css.label}>{t('cron')}</span>
        <input
          className={css.input}
          value={expr}
          onChange={e => setExpr(e.target.value)}
          placeholder="分 时 日 月 周 [年] · 如 */5 * * * *"
          onKeyDown={e => { if (e.key === 'Enter') pick(action) }}
        />
      </div>

      <div className={css.modeTabs}>
        <button className={action === 'validate' ? css.modeTabActive : css.modeTab} onClick={() => pick('validate')}>{t('cronActionValidate')}</button>
        <button className={action === 'describe' ? css.modeTabActive : css.modeTab} onClick={() => pick('describe')}>{t('cronActionDescribe')}</button>
        <button className={action === 'next' ? css.modeTabActive : css.modeTab} onClick={() => pick('next')}>{t('cronActionNext')}</button>
      </div>

      {action === 'next' && (
        <div className={css.row}>
          <span className={css.label}>{t('cronCount')}</span>
          <input className={css.countInput} type="number" min={1} max={100} value={count} onChange={e => setCount(Number(e.target.value))} />
          <span className={css.hint}>计算未来 N 次（1-100），点击「下次执行」输出</span>
        </div>
      )}

      <div className={css.chips}>
        <span className={css.hint}>常用：</span>
        {CRON_PRESETS.map(([value, label]) => (
          <button key={value} className={css.chip} onClick={() => applyPreset(value)} title={value}>{label}</button>
        ))}
      </div>

      <div className={css.hint}>
        字段顺序：分钟(0-59) 小时(0-23) 日期(1-31) 月份(1-12) 星期(0-7) [年份]。每字段支持 *、N、N-M、*/N、N-M/P、A,B,C；月份/星期可用英文缩写。
      </div>

      {valid === true && (
        <div className={css.card}>
          <div><span className={css.fieldLabel}>✓ {t('cronValid')}</span>{desc !== '' && <span className={css.hint}> · {desc}</span>}</div>
          {next.length > 0 && (
            <pre className={css.out}>{(() => {
              const lines = next.map((s, i) => `${i + 1}. ${new Date(s).toLocaleString('zh-CN', { timeZone: 'UTC' })} (UTC)`)
              return `${t('cronNextTimes')}：\n${lines.join('\n')}`
            })()}</pre>
          )}
        </div>
      )}
      {valid === false && <div className={css.error}>✗ {t('cronInvalid')}：{err}</div>}
    </div>
  )
}

/** Tab ids and their labels. */
const TABS: Array<[string, string]> = [
  ['json', 'JSON'], ['time', '时间'], ['regex', '正则'], ['b64', 'Base64'],
  ['url', 'URL'], ['translate', '翻译'], ['diff', 'Diff'], ['uuid', 'UUID'],
  ['bytes', '字节'], ['cron', 'Cron'],
]

/**
 * Render the developer toolbox panel.
 * @param props - composed slot props.
 * @returns the overlay panel, or null when closed.
 */
export function ToolboxPanel({ useToolboxUi, close, translate, uuid, t }: ToolboxPanelProps) {
  const state = useToolboxUi(snapshot => snapshot)
  const [tab, setTab] = useState('json')
  const shellRef = useRef<HTMLDivElement | null>(null)
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null)
  if (!state.open) return null
  const tabT = t as Translator

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // Drag only from the header; ignore clicks on the close button.
    if ((e.target as HTMLElement).closest('button')) return
    const el = shellRef.current
    if (el === null) return
    const startX = e.clientX
    const startY = e.clientY
    const baseX = offset?.x ?? 0
    const baseY = offset?.y ?? 0
    const move = (ev: PointerEvent) => {
      setOffset({ x: baseX + (ev.clientX - startX), y: baseY + (ev.clientY - startY) })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div
      ref={shellRef}
      className={css.shell}
      style={offset === null ? undefined : { transform: `translate(${offset.x}px, ${offset.y}px)` }}
    >
      <div className={css.head} onPointerDown={onPointerDown}>
        <span>🧰 开发者工具箱</span>
        <button className={css.close} onClick={close} title={t('close')} aria-label={t('close')}>✕</button>
      </div>
      <div className={css.tabs}>
        {TABS.map(([id, label]) => (
          <button key={id} className={tab === id ? css.tabActive : css.tab} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {tab === 'json' && <JsonWidget t={tabT} />}
      {tab === 'time' && <TimeWidget t={tabT} />}
      {tab === 'regex' && <RegexWidget t={tabT} />}
      {tab === 'b64' && <B64Widget t={tabT} />}
      {tab === 'url' && <UrlWidget t={tabT} />}
      {tab === 'translate' && <TranslateWidget t={tabT} translate={translate} />}
      {tab === 'diff' && <DiffWidget t={tabT} />}
      {tab === 'uuid' && <UuidWidget t={tabT} uuid={uuid} />}
      {tab === 'bytes' && <BytesWidget t={tabT} />}
      {tab === 'cron' && <CronWidget t={tabT} />}
      {tab === 'translate' && <div className={css.hint}>免费 API 不消耗额度；大文本或高质量需求建议用当前模型</div>}
    </div>
  )
}
