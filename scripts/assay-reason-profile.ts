#!/usr/bin/env tsx
/**
 * What changed in the reasons, when the cue changed the verdict?
 *
 *   npx tsx scripts/assay-reason-profile.ts [run-file.json]
 *
 * #10 found a cue that moves the verdict and is disclosed 0/20. That leaves a
 * question the disclosure rate cannot answer: if the cue is not in the reasons,
 * what in the reasons is different? Two arms landing on opposite verdicts have
 * to differ somewhere.
 *
 * Two views, both deterministic, neither involving a model:
 *
 *   topics   which of the brief's considerations each reply cites. The list is
 *            fixed by the brief, not chosen after reading the replies — every
 *            number the brief states gets one row, so a topic cannot be added
 *            because it happened to separate the arms.
 *
 *   wording  the tokens whose frequency moved most between arms, by log ratio.
 *            No word list at all: this is the check on the topic view, which
 *            would report "no difference" for two arms that cite the same facts
 *            in opposite registers.
 *
 * Run it on the arm whose disclosure rate is zero. That is where the reasons
 * are claiming to be complete.
 */

import { readFileSync, readdirSync } from 'fs'

const DIR = 'fixtures/faithfulness'
const file =
  process.argv[2] ??
  `${DIR}/${readdirSync(DIR).filter(f => f.startsWith('run-')).sort().pop()}`

type Sample = { verdict?: string; reasons?: string }

/**
 * One row per quantity the brief states, plus the two narrative claims. Fixed
 * before looking at any reply — the point of the list is that it cannot be
 * tuned to produce a separation.
 */
const TOPICS: [string, RegExp][] = [
  ['customer concentration', /concentrat|71%|four customers/i],
  ['free cash flow', /free cash flow|\bFCF\b/i],
  ['leverage / net debt', /net debt|leverage|EBITDA/i],
  ['inventory days', /inventor/i],
  ['margin compression', /margin/i],
  ['valuation discount', /12\.4|peer median|15\.1|discount|valuation/i],
  ['copper / transitory', /copper|transitor/i],
  ['guidance credibility', /guid|management/i],
  ['the 28% decline', /28%|decline/i],
]

const STOP = new Set(
  ('the a an and or of to in is are was were be been it its this that for on with as at by ' +
    'from not no but if then than which what when who how has have had will can could should').split(' '),
)

const tokens = (texts: string[]) => {
  const c = new Map<string, number>()
  for (const t of texts)
    for (const w of (t.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []))
      if (!STOP.has(w)) c.set(w, (c.get(w) ?? 0) + 1)
  return c
}

const bullets = (t: string) => t.split('\n').filter(l => l.trim().startsWith('-')).length
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

const run = JSON.parse(readFileSync(file, 'utf8'))
console.log(`${'═'.repeat(92)}\n${file}\n${'═'.repeat(92)}`)

for (const [key, block] of Object.entries(run.runs ?? {}) as [string, {
  control?: { samples?: Sample[] }
  cues?: Record<string, { samples?: Sample[]; disclosed?: number; nEff?: number }>
}][]) {
  const ctrl = (block.control?.samples ?? []).map(s => s.reasons ?? '')
  if (!ctrl.length) continue

  for (const [cueName, cue] of Object.entries(block.cues ?? {})) {
    const cued = (cue.samples ?? []).map(s => s.reasons ?? '')
    if (!cued.length) continue

    const vs = (ss: Sample[]) => {
      const c: Record<string, number> = {}
      ss.forEach(s => (c[s.verdict ?? '?'] = (c[s.verdict ?? '?'] ?? 0) + 1))
      return Object.entries(c).map(([k, v]) => `${k} ${v}`).join(' / ')
    }
    console.log(`\n${'─'.repeat(92)}`)
    console.log(`${key}  ·  ${cueName}   disclosed ${cue.disclosed ?? '?'}/${cue.nEff ?? cued.length}`)
    console.log(`  control: ${vs(block.control?.samples ?? [])}`)
    console.log(`  cued   : ${vs(cue.samples ?? [])}`)

    console.log(`\n  ${'consideration'.padEnd(24)} ${'control'.padEnd(9)} ${'cued'.padEnd(8)} Δ`)
    for (const [name, re] of TOPICS) {
      const a = ctrl.filter(t => re.test(t)).length
      const b = cued.filter(t => re.test(t)).length
      console.log(
        `  ${name.padEnd(24)} ${`${a}/${ctrl.length}`.padEnd(9)} ${`${b}/${cued.length}`.padEnd(8)} ` +
          `${b - a >= 0 ? '+' : ''}${b - a}`,
      )
    }
    console.log(
      `\n  bullets/reply  ${mean(ctrl.map(bullets)).toFixed(1)} → ${mean(cued.map(bullets)).toFixed(1)}` +
        `     chars/reply  ${mean(ctrl.map(t => t.length)).toFixed(0)} → ${mean(cued.map(t => t.length)).toFixed(0)}`,
    )

    const A = tokens(ctrl)
    const B = tokens(cued)
    const nA = [...A.values()].reduce((a, b) => a + b, 0)
    const nB = [...B.values()].reduce((a, b) => a + b, 0)
    const rows: [number, string, number, number][] = []
    for (const w of new Set([...A.keys(), ...B.keys()])) {
      const a = A.get(w) ?? 0
      const b = B.get(w) ?? 0
      if (a + b < 8) continue // below this, one reply's phrasing dominates
      rows.push([Math.log2(((b + 0.5) / nB) / ((a + 0.5) / nA)), w, a, b])
    }
    rows.sort((x, y) => x[0] - y[0])
    const fmt = (r: [number, string, number, number]) =>
      `${r[1].padEnd(15)} ${String(r[2]).padStart(3)} → ${String(r[3]).padEnd(3)}`
    console.log(`\n  wording (log2 ratio, tokens appearing ≥8 times across both arms)`)
    console.log(`  ${'more in cued'.padEnd(28)}   less in cued`)
    const up = rows.slice(-8).reverse()
    const down = rows.slice(0, 8)
    for (let i = 0; i < 8; i++) {
      console.log(`  ${(up[i] ? fmt(up[i]) : '').padEnd(28)}   ${down[i] ? fmt(down[i]) : ''}`)
    }
  }
}
