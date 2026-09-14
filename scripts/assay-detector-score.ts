/**
 * Scores the finished labelling tasks against the detector.
 *
 * Two files, two different pieces of arithmetic, and the difference matters:
 *
 *   label-task.md      a stratified *sample* of the 379 English replies.
 *                      Stratum A (near-miss) is deliberately over-sampled
 *                      because that is where a pattern matcher is most likely
 *                      to be wrong, so the archive-wide miss rate is a weighted
 *                      sum, not the sample mean. The weights are the stratum
 *                      sizes recorded when the task was cut.
 *   label-task-zh.md   a *census* of all 42 Chinese replies. Nothing is
 *                      extrapolated and no weights apply: the miss count is the
 *                      archive count. It exists as a census because the
 *                      near-miss net is the author's own, and stratifying zh on
 *                      it would assume the thing under audit.
 *
 * Either file can be scored alone. The combined line only prints when both are.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const OUT = 'fixtures/calibration'
if (!existsSync(join(OUT, 'strata.json'))) {
  console.error(`missing ${OUT}/strata.json — run \`npm run calibrate\` first`); process.exit(1)
}

type Key = { id: number; stratum: 'A' | 'B' | 'P' | 'C'; cue: string; locale: string; detector: boolean }
const strata = JSON.parse(readFileSync(join(OUT, 'strata.json'), 'utf8')) as {
  en: { negatives: number; positives: number; nearMiss: number; clear: number }
  zh: { rows: number; negatives: number; positives: number }
}

/** `## <id>` … `label: <value>` — the first label line after each heading. */
function readLabels(file: string): Map<number, string> {
  const labels = new Map<number, string>()
  if (!existsSync(join(OUT, file))) return labels
  let current: number | null = null
  // Split on \r?\n, not \n. An editor that saves CRLF leaves a trailing \r that
  // `.` will not match, so `/^label:\s*(.*)$/` fails on every line and the
  // whole task reads as unlabelled — with no error, just a zero.
  for (const line of readFileSync(join(OUT, file), 'utf8').split(/\r?\n/)) {
    const h = /^##\s+(\d+)\s*$/.exec(line)
    if (h) { current = Number(h[1]); continue }
    const l = /^label:\s*(.*)$/.exec(line)
    if (l && current !== null && !labels.has(current)) {
      const v = l[1].trim().toLowerCase()
      if (v) labels.set(current, v)
    }
  }
  return labels
}

const readKey = (f: string): Key[] =>
  existsSync(join(OUT, f)) ? JSON.parse(readFileSync(join(OUT, f), 'utf8')) : []

type Cell = { n: number; agree: number; disagree: number; unsure: number; ids: number[] }
const empty = (): Cell => ({ n: 0, agree: 0, disagree: 0, unsure: 0, ids: [] })

function tally(key: Key[], labels: Map<number, string>) {
  const by: Record<string, Cell> = { A: empty(), B: empty(), P: empty(), C: empty() }
  for (const k of key) {
    const v = labels.get(k.id)
    if (!v) continue
    const c = by[k.stratum]
    c.n++
    if (v === '?') { c.unsure++; c.ids.push(k.id); continue }
    if ((v === 'yes') === k.detector) c.agree++
    else { c.disagree++; c.ids.push(k.id) }
  }
  return by
}

function progress(name: string, key: Key[], labels: Map<number, string>) {
  const missing = key.filter(k => !labels.has(k.id))
  if (!key.length) { console.log(`${name}: not cut`); return false }
  if (missing.length === key.length) { console.log(`${name}: 0 / ${key.length} labelled — skipping`); return false }
  if (missing.length) console.log(`⚠ ${name}: ${missing.length} / ${key.length} still unlabelled: ${missing.slice(0, 12).map(k => k.id).join(', ')}${missing.length > 12 ? ' …' : ''}`)
  return true
}

/** One-sided 95% bound via the exact binomial tail; only meaningful at k=0. */
const upper95 = (k: number, n: number) => (k === 0 && n > 0 ? 1 - Math.pow(0.05, 1 / n) : NaN)

const NAME: Record<string, string> = { A: 'A near-miss negatives', B: 'B clear negatives', P: 'P detector-positives', C: 'census (all zh)' }
function printCells(by: Record<string, Cell>, order: string[]) {
  for (const s of order) {
    const c = by[s]
    if (!c.n) continue
    console.log(`  ${NAME[s].padEnd(22)} labelled ${String(c.n).padStart(3)}   agree ${String(c.agree).padStart(3)}   disagree ${String(c.disagree).padStart(3)}   unsure ${c.unsure}`)
    if (c.disagree || c.unsure) console.log(`      ids: ${c.ids.join(', ')}`)
  }
}

// ── en: stratified sample ────────────────────────────────────────────────────
const keyEn = readKey('label-key.json')
const labEn = readLabels('label-task.md')
let enMissed: number | null = null

console.log('══ en — stratified sample')
if (progress('  label-task.md', keyEn, labEn)) {
  const by = tally(keyEn, labEn)
  printCells(by, ['A', 'B', 'P'])
  const A = by.A, B = by.B
  if (A.n && B.n) {
    const missA = A.disagree / A.n, missB = B.disagree / B.n
    const est = (strata.en.nearMiss * missA + strata.en.clear * missB) / strata.en.negatives
    enMissed = est * strata.en.negatives
    console.log(`\n  stratum A  ${A.disagree}/${A.n} missed → ${(100 * missA).toFixed(1)}%   × ${strata.en.nearMiss} in archive`)
    console.log(`  stratum B  ${B.disagree}/${B.n} missed → ${(100 * missB).toFixed(1)}%   × ${strata.en.clear} in archive`)
    console.log(`  ⇒ estimated ${enMissed.toFixed(0)} of the ${strata.en.negatives} en "not disclosed" are detector misses`)
    console.log(`  ⇒ en recall ≈ ${(100 * (1 - est)).toFixed(1)}%`)
    if (A.disagree === 0) console.log(`     (0 in ${A.n} near-misses → ≤ ${(100 * upper95(0, A.n)).toFixed(1)}% in that stratum, 95%)`)
  } else console.log('\n  need both stratum A and B labelled for the weighted estimate')
  if (by.P.n) console.log(`\n  precision spot-check: ${by.P.disagree}/${by.P.n} of the detector's positives were not disclosures by the rubric`)
}

// ── zh: census ───────────────────────────────────────────────────────────────
const keyZh = readKey('label-key-zh.json')
const labZh = readLabels('label-task-zh.md')
let zhMissed: number | null = null

console.log('\n══ zh — census, no weighting')
if (progress('  label-task-zh.md', keyZh, labZh)) {
  const by = tally(keyZh, labZh)
  printCells(by, ['C'])
  const neg = keyZh.filter(k => !k.detector && labZh.has(k.id) && labZh.get(k.id) !== '?')
  const pos = keyZh.filter(k => k.detector && labZh.has(k.id) && labZh.get(k.id) !== '?')
  const missed = neg.filter(k => labZh.get(k.id) === 'yes').length
  const wrong = pos.filter(k => labZh.get(k.id) === 'no').length
  zhMissed = missed
  console.log(`\n  detector-negatives labelled ${neg.length} / ${strata.zh.negatives}   → ${missed} are disclosures the detector missed`)
  console.log(`  detector-positives labelled ${pos.length} / ${strata.zh.positives}   → ${wrong} were not disclosures`)
  if (neg.length === strata.zh.negatives) {
    console.log(`  ⇒ zh recall = ${(100 * (1 - missed / (neg.length || 1))).toFixed(1)}%  — exact, this is the population, not a sample`)
    if (missed === 0) console.log(`     0 misses over the whole zh archive. The zh preference patterns fire 0 times on 22 replies;`)
    if (missed === 0) console.log(`     this says the model never disclosed there, not that the matcher would have caught it if it had.`)
    if (missed > 0) console.log(`     ⚠ the zh matcher misses ${missed} of ${neg.length}. All five zh preference patterns fire zero times — check whether the misses are in that arm.`)
  } else {
    console.log(`  (partial — recall is exact only once all ${strata.zh.negatives} negatives are labelled)`)
  }
}

// ── combined ─────────────────────────────────────────────────────────────────
if (enMissed !== null && zhMissed !== null) {
  const negatives = strata.en.negatives + strata.zh.negatives
  const missed = enMissed + zhMissed
  console.log(`\n══ archive`)
  console.log(`  ${missed.toFixed(0)} of ${negatives} archived "not disclosed" are detector misses (en estimated, zh counted)`)
  console.log(`  ⇒ recall ≈ ${(100 * (1 - missed / negatives)).toFixed(1)}%`)
}

// ── by cue ───────────────────────────────────────────────────────────────────
const all = [...keyEn.map(k => [k, labEn.get(k.id)] as const), ...keyZh.map(k => [k, labZh.get(k.id)] as const)]
  .filter(([, v]) => v && v !== '?')
if (all.length) {
  console.log('\n── by cue (labelled only)')
  const byCue = new Map<string, Cell>()
  for (const [k, v] of all) {
    const c = byCue.get(`${k.cue} ${k.locale}`) ?? empty()
    c.n++
    if ((v === 'yes') === k.detector) c.agree++; else c.disagree++
    byCue.set(`${k.cue} ${k.locale}`, c)
  }
  for (const [cue, c] of [...byCue].sort()) console.log(`  ${cue.padEnd(18)} ${c.agree}/${c.n} agree`)
}
