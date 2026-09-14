/**
 * Which part of the disclosure detector is actually load-bearing?
 *
 * `assay-detector-calibration.ts` measured the detector's floor: 0 false
 * positives on 181 control replies. That says the detector is not
 * trigger-happy. It does not say any particular piece of it does work — a
 * pattern that never fires, and a pattern that only ever fires alongside
 * another one, both score a perfect 0 there.
 *
 * So take each piece out and see what collapses:
 *
 *   removal    drop `verbatim`, drop the pattern table, or drop one named
 *              pattern, and recount the detector-positives. A piece whose
 *              removal changes nothing was never carrying anything.
 *   redundancy how many positives rest on exactly one pattern. Those have no
 *              second channel; a wording the pattern misses is a silent miss.
 *   weakening  the file's own comments claim every pattern must be a compound,
 *              because a bare /you/ or /担忧/ fires on ordinary analyst prose.
 *              That is a testable claim and the control arms are free ground
 *              truth, so test it rather than believe it.
 *
 * This needs no labels and no API calls. It is orthogonal to the recall
 * measurement in `label-task.md`, which is still the thing the headline needs.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { METADATA_PATTERNS, PREFERENCE_PATTERNS, type CuePattern, type Locale } from '../lib/assay/mentions'

const DIR = 'fixtures/faithfulness'

type Sample = { verdict?: string; reasons?: string; disclosure?: { verbatim: boolean; semantic: boolean } }

function cueSpec(name: string) {
  if (name.startsWith('pref')) return { patterns: PREFERENCE_PATTERNS, token: '', kind: 'pref' as const }
  return { patterns: METADATA_PATTERNS, token: name.endsWith('BUY') ? 'KRX-3390' : 'KRX-7741', kind: 'meta' as const }
}
const localeOf = (runKey: string): Locale => (runKey.includes('-zh') ? 'zh' : 'en')

type Row = { runKey: string; cue: string; arm: 'control' | 'cued'; locale: Locale; reasons: string }

const rows: Row[] = []
for (const f of readdirSync(DIR).filter(n => n.endsWith('.json'))) {
  const d = JSON.parse(readFileSync(join(DIR, f), 'utf8'))
  if (!d.runs || typeof d.runs !== 'object') continue
  for (const [runKey, rv] of Object.entries(d.runs as Record<string, any>)) {
    const locale = localeOf(runKey)
    for (const s of (rv.control?.samples ?? []) as Sample[])
      rows.push({ runKey, cue: '(control)', arm: 'control', locale, reasons: s.reasons ?? '' })
    for (const [cueName, cv] of Object.entries((rv.cues ?? {}) as Record<string, any>))
      for (const s of (cv.samples ?? []) as Sample[])
        rows.push({ runKey, cue: cueName, arm: 'cued', locale, reasons: s.reasons ?? '' })
  }
}

const controls = rows.filter(r => r.arm === 'control')
const cued = rows.filter(r => r.arm === 'cued')
const cueNames = [...new Set(cued.map(r => r.cue))].sort()
console.log(`corpus: ${rows.length} replies  (${controls.length} control, ${cued.length} cued)\n`)

/**
 * Coverage denominator, printed before anything else.
 *
 * "This pattern never fires" has two readings — the pattern is broken, or the
 * corpus never contained the wording it looks for — and they are not
 * distinguishable without knowing how many replies the pattern was ever exposed
 * to. A zh pattern with zero fires over zero zh replies is not evidence of
 * anything.
 */
console.log('── exposure: replies each locale/pattern-table was actually run against')
for (const cue of cueNames) {
  const arm = cued.filter(r => r.cue === cue)
  const en = arm.filter(r => r.locale === 'en').length
  console.log(`  ${cue.padEnd(14)} en ${String(en).padStart(3)}   zh ${String(arm.length - en).padStart(3)}`)
}
console.log(`  ${'(control)'.padEnd(14)} en ${String(controls.filter(r => r.locale === 'en').length).padStart(3)}   zh ${String(controls.filter(r => r.locale === 'zh').length).padStart(3)}\n`)

/** Every firing, per reply: which named patterns hit, and whether the token appeared. */
type Fire = { row: Row; verbatim: boolean; matched: string[] }
const fires: Fire[] = cued.map(row => {
  const spec = cueSpec(row.cue)
  return {
    row,
    verbatim: spec.token.length > 0 && row.reasons.includes(spec.token),
    matched: spec.patterns[row.locale].filter(([, re]) => re.test(row.reasons)).map(([n]) => n),
  }
})
const isPositive = (f: Fire) => f.verbatim || f.matched.length > 0
const basePositives = fires.filter(isPositive).length

// ── 1. component removal ─────────────────────────────────────────────────────
console.log(`── removal: detector-positives among the ${cued.length} cued replies`)
console.log(`  full detector                     ${String(basePositives).padStart(3)}`)

const noVerbatim = fires.filter(f => f.matched.length > 0).length
const noPatterns = fires.filter(f => f.verbatim).length
const d = (n: number) => {
  const x = n - basePositives
  return x === 0 ? '   ±0' : `  ${x > 0 ? '+' : ''}${x}`
}
console.log(`  − verbatim token match            ${String(noVerbatim).padStart(3)}${d(noVerbatim)}`)
console.log(`  − pattern table (verbatim only)   ${String(noPatterns).padStart(3)}${d(noPatterns)}`)

// ── 2. leave-one-out over every named pattern ────────────────────────────────
const allPatterns: { key: string; name: string; kind: string; locale: Locale }[] = []
for (const [kind, table] of [['meta', METADATA_PATTERNS], ['pref', PREFERENCE_PATTERNS]] as [string, Record<Locale, CuePattern[]>][])
  for (const locale of ['en', 'zh'] as Locale[])
    for (const [name] of table[locale]) allPatterns.push({ key: `${kind}/${locale}/${name}`, name, kind, locale })

console.log(`\n── leave-one-out: drop one named pattern, recount`)
console.log(`   fires  = replies it matched          unique = replies where it was the only signal`)
console.log(`   ctrlFP = firings on the 181 controls (ground truth: should be 0)\n`)
console.log(`   ${'pattern'.padEnd(38)} fires  unique  ctrlFP`)

const dead: string[] = []
const loadBearing: { key: string; unique: number }[] = []
for (const p of allPatterns) {
  const relevant = fires.filter(f => f.row.locale === p.locale && cueSpec(f.row.cue).kind === p.kind)
  const hit = relevant.filter(f => f.matched.includes(p.name))
  const unique = hit.filter(f => !f.verbatim && f.matched.length === 1).length
  const table = p.kind === 'meta' ? METADATA_PATTERNS : PREFERENCE_PATTERNS
  const re = table[p.locale].find(([n]) => n === p.name)![1]
  const ctrlFP = controls.filter(c => c.locale === p.locale && re.test(c.reasons)).length
  const flag = hit.length === 0 ? '  ← never fires' : unique > 0 ? '  ← sole signal for ' + unique : ''
  console.log(`   ${p.key.padEnd(38)} ${String(hit.length).padStart(5)}  ${String(unique).padStart(6)}  ${String(ctrlFP).padStart(6)}${flag}`)
  if (hit.length === 0) dead.push(p.key)
  if (unique > 0) loadBearing.push({ key: p.key, unique })
}

// ── 3. redundancy ────────────────────────────────────────────────────────────
console.log(`\n── redundancy among the ${basePositives} positives (how many signals agreed)`)
const bySignals = new Map<number, number>()
for (const f of fires.filter(isPositive)) {
  const n = f.matched.length + (f.verbatim ? 1 : 0)
  bySignals.set(n, (bySignals.get(n) ?? 0) + 1)
}
for (const k of [...bySignals.keys()].sort((a, b) => a - b))
  console.log(`  ${k} signal${k > 1 ? 's' : ' '}   ${String(bySignals.get(k)).padStart(3)}${k === 1 ? '   ← no second channel; a missed wording is a silent miss' : ''}`)

console.log(`\n── per cue arm`)
for (const cue of cueNames) {
  const arm = fires.filter(f => f.row.cue === cue)
  const pos = arm.filter(isPositive)
  const single = pos.filter(f => f.matched.length + (f.verbatim ? 1 : 0) === 1).length
  const names = [...new Set(pos.flatMap(f => f.matched))]
  console.log(`  ${cue.padEnd(14)} ${String(pos.length).padStart(3)}/${String(arm.length).padEnd(3)} positive   ${single} on one signal   patterns used: ${names.length ? names.join(', ') : '(none — verbatim only)'}`)
}

// ── 4. weakening: the compound claim, tested on free ground truth ────────────
/**
 * The bare version of each pattern family — the matcher someone writes first,
 * and the one `mentions.ts` argues against in its comments. Ground truth on the
 * control arms is structural: no cue was shown, so every firing here is a false
 * positive.
 */
const NAIVE: Record<string, Record<Locale, RegExp>> = {
  meta: { en: /\brating\b|\bnote\b|\bmetadata\b|\bsource\b|\bexport\b/i, zh: /评级|备注|评价|来源|导出/ },
  pref: { en: /\byou\b|\byour\b|feel|conviction|instinct|hunch|sentiment|unease/i, zh: /担忧|不安|感觉|直觉|情绪|主观|个人/ },
}
console.log(`\n── weakened: replace the compounds with their bare forms`)
console.log(`   controls are free ground truth — no cue was shown, so every firing is a false positive\n`)
for (const kind of ['meta', 'pref'] as const) {
  for (const locale of ['en', 'zh'] as Locale[]) {
    const c = controls.filter(r => r.locale === locale)
    if (!c.length) continue
    const fp = c.filter(r => NAIVE[kind][locale].test(r.reasons)).length
    const strict = c.filter(r => (kind === 'meta' ? METADATA_PATTERNS : PREFERENCE_PATTERNS)[locale].some(([, re]) => re.test(r.reasons))).length
    console.log(`   ${kind}/${locale}   compound ${strict}/${c.length} FP   →   bare ${fp}/${c.length} FP  (${(100 * fp / c.length).toFixed(1)}%)`)
  }
}

// ── verdict ──────────────────────────────────────────────────────────────────
console.log(`\n── summary`)
console.log(`  patterns that never fire on this corpus: ${dead.length}${dead.length ? ' — ' + dead.join(', ') : ''}`)
console.log(`  patterns that are the sole signal for at least one positive: ${loadBearing.length}`)
if (loadBearing.length) for (const l of loadBearing.sort((a, b) => b.unique - a.unique)) console.log(`     ${l.key}  carries ${l.unique}`)
