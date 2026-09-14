/**
 * Scores a finished `label-task.md` against the detector, and turns the two
 * stratum recalls into one number for the whole archive.
 *
 * The sample is deliberately unrepresentative — stratum A (near-miss) is
 * over-sampled because that is where a pattern matcher is most likely to be
 * wrong. So the archive-wide miss rate is a weighted sum, not the sample mean,
 * and the weights are the stratum sizes recorded when the task was cut.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const OUT = 'fixtures/calibration'
for (const f of ['label-task.md', 'label-key.json', 'strata.json']) {
  if (!existsSync(join(OUT, f))) { console.error(`missing ${OUT}/${f} — run assay-detector-calibration first`); process.exit(1) }
}

const md = readFileSync(join(OUT, 'label-task.md'), 'utf8')
const key = JSON.parse(readFileSync(join(OUT, 'label-key.json'), 'utf8')) as
  { id: number; stratum: 'A' | 'B' | 'P'; cue: string; detector: boolean }[]
const strata = JSON.parse(readFileSync(join(OUT, 'strata.json'), 'utf8')) as
  { negatives: number; positives: number; nearMiss: number; clear: number }

/** `## <id>` … `label: <value>` — the first label line after each heading. */
const labels = new Map<number, string>()
let current: number | null = null
for (const line of md.split('\n')) {
  const h = /^##\s+(\d+)\s*$/.exec(line)
  if (h) { current = Number(h[1]); continue }
  const l = /^label:\s*(.*)$/.exec(line)
  if (l && current !== null && !labels.has(current)) {
    const v = l[1].trim().toLowerCase()
    if (v) labels.set(current, v)
  }
}

const unlabelled = key.filter(k => !labels.has(k.id))
if (unlabelled.length) {
  console.log(`⚠ ${unlabelled.length} / ${key.length} still unlabelled: ${unlabelled.slice(0, 12).map(k => k.id).join(', ')}${unlabelled.length > 12 ? ' …' : ''}\n`)
}

type Cell = { n: number; agree: number; disagree: number; unsure: number; ids: number[] }
const empty = (): Cell => ({ n: 0, agree: 0, disagree: 0, unsure: 0, ids: [] })
const byStratum: Record<string, Cell> = { A: empty(), B: empty(), P: empty() }

for (const k of key) {
  const v = labels.get(k.id)
  if (!v) continue
  const c = byStratum[k.stratum]
  c.n++
  if (v === '?') { c.unsure++; c.ids.push(k.id); continue }
  const human = v === 'yes'
  if (human === k.detector) c.agree++
  else { c.disagree++; c.ids.push(k.id) }
}

console.log('── per stratum  (disagree = the detector and the human differ)')
const NAME: Record<string, string> = { A: 'A near-miss negatives', B: 'B clear negatives', P: 'P detector-positives' }
for (const s of ['A', 'B', 'P']) {
  const c = byStratum[s]
  if (!c.n) continue
  console.log(`  ${NAME[s].padEnd(22)} labelled ${String(c.n).padStart(3)}   agree ${String(c.agree).padStart(3)}   disagree ${String(c.disagree).padStart(3)}   unsure ${c.unsure}`)
  if (c.disagree || c.unsure) console.log(`      ids: ${c.ids.join(', ')}`)
}

/** Clopper–Pearson-ish one-sided bound via the exact binomial tail, for k=0. */
const upper95 = (k: number, n: number) => (k === 0 && n > 0 ? 1 - Math.pow(0.05, 1 / n) : NaN)

console.log('\n── recall over the whole archive (stratum-weighted)')
const A = byStratum.A, B = byStratum.B
if (A.n && B.n) {
  const missA = A.disagree / A.n
  const missB = B.disagree / B.n
  const est = (strata.nearMiss * missA + strata.clear * missB) / strata.negatives
  const missed = est * strata.negatives
  console.log(`  stratum A  ${A.disagree}/${A.n} missed  → ${(100 * missA).toFixed(1)}%   × ${strata.nearMiss} in archive`)
  console.log(`  stratum B  ${B.disagree}/${B.n} missed  → ${(100 * missB).toFixed(1)}%   × ${strata.clear} in archive`)
  console.log(`  ⇒ estimated ${missed.toFixed(0)} of the ${strata.negatives} archived "not disclosed" are detector misses`)
  console.log(`  ⇒ recall ≈ ${(100 * (1 - est)).toFixed(1)}%`)
  if (A.disagree === 0) console.log(`     (0 misses in ${A.n} near-misses → miss rate ≤ ${(100 * upper95(0, A.n)).toFixed(1)}% in that stratum, 95%)`)
} else {
  console.log('  need both stratum A and B labelled')
}

if (byStratum.P.n) {
  const p = byStratum.P
  console.log(`\n── precision spot-check: ${p.disagree}/${p.n} of the detector's positives were not disclosures by the rubric`)
}

console.log('\n── by cue (labelled only)')
const byCue = new Map<string, Cell>()
for (const k of key) {
  const v = labels.get(k.id)
  if (!v || v === '?') continue
  const c = byCue.get(k.cue) ?? empty()
  c.n++
  if ((v === 'yes') === k.detector) c.agree++; else c.disagree++
  byCue.set(k.cue, c)
}
for (const [cue, c] of [...byCue].sort()) {
  console.log(`  ${cue.padEnd(14)} ${c.agree}/${c.n} agree`)
}
