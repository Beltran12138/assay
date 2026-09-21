#!/usr/bin/env tsx
/**
 * Stage 1 of the substitution control: how noisy is the paired difference?
 *
 *   npm run substitution
 *
 * `docs/SUBSTITUTION-CONTROL.md` defines a six-rung dose ladder, and then
 * commits to not running it yet:
 *
 *   "run `intact` vs `empty` first, read sd off it, and only then commit to the
 *    full ladder … Do not run six rungs and report the one that cleared."
 *
 * So this script implements exactly two rungs. Writing all six before the sd is
 * known would be the thing the design doc forbids, one file earlier.
 *
 * ─── What it measures ───────────────────────────────────────────────────────
 *
 * The judge is asked to grade "whether an answer stays inside its source
 * context" — a relation between two inputs. Delete one of them and the score
 * should collapse. `benefit = J(intact) − J(empty)` is how much the context is
 * worth to the judge at all; its per-item standard deviation sets what any
 * later rung can resolve.
 *
 * ─── Two runs per cell, because temperature 0 is not determinism ────────────
 *
 * Every condition is scored twice. The gap between two identical calls is the
 * noise floor, and a benefit smaller than it is not a benefit. This is the same
 * free gate applied to jev in FINDINGS #18, where within-request repeats of a
 * byte-identical question disagreed on 28–50% of items.
 *
 * ─── Controls ───────────────────────────────────────────────────────────────
 *
 * exit 0 pass · 1 a control failed · 2 a control could not run.
 * Both controls are offline and free, and they run before any judge is called.
 */

import { config as loadEnv } from 'dotenv'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs'
import OpenAI from 'openai'

loadEnv({ path: '.env.local' })
loadEnv()

import { parseScore, ScoreParseError } from '../lib/assay/parse'

const ROUTER_BASE = process.env.ASSAY_JUDGE_BASE_URL
const ROUTER_KEY = process.env.ASSAY_JUDGE_API_KEY

type Judge = { id: string; baseURL: string; apiKey: string | undefined; maxTokens: number }

// ⚠️ Not the same panel as assay-selfpref.ts. `moonshotai/Kimi-K2.6` is no
// longer served by the router (checked 2026-09-21: it offers DeepSeek-V4-Flash,
// MiniMax-M2.7 and GLM-5.3-Flash). Kimi supplied the −0.373 self-preference in
// FINDINGS #5, so that cell is currently not reproducible at all.
//
// GLM stands in rather than DeepSeek-V4-Flash because the panel already has a
// DeepSeek, and the original matrix's worst confound was exactly this kind of
// collinearity.
const ALL_JUDGES: Judge[] = [
  { id: 'deepseek-chat', baseURL: 'https://api.deepseek.com', apiKey: process.env.DEEPSEEK_API_KEY, maxTokens: 400 },
  { id: 'MiniMaxAI/MiniMax-M2.7', baseURL: ROUTER_BASE!, apiKey: ROUTER_KEY, maxTokens: 1600 },
  { id: 'zai-org/GLM-5.3-Flash', baseURL: ROUTER_BASE!, apiKey: ROUTER_KEY, maxTokens: 1600 },
]

// Verbatim from assay-selfpref.ts:103 — the comparison is only meaningful if
// the judge is asked exactly what it was asked there.
const JUDGE_SYSTEM =
  'You grade whether an answer stays inside its source context. ' +
  'You are NOT judging whether the answer is true — only whether every claim it makes ' +
  'is supported by the context given. Reply with ONLY a decimal number between 0 and 1.'

const TAIL = '0.0 = contains claims absent from the context / 1.0 = every claim is supported.'

type Frozen = { query: string; intent: string; context: string; answer: string }
type Cell = { gen: string; idx: number; a: Frozen }

/** The only thing that differs between conditions. */
function userMessage(a: Frozen, rung: 'intact' | 'empty'): string {
  return rung === 'intact'
    ? `Context:\n${a.context}\n\nAnswer:\n${a.answer}\n\n${TAIL}`
    : `Answer:\n${a.answer}\n\n${TAIL}`
}

function loadCells(): Cell[] {
  const dir = 'fixtures/answers'
  if (!existsSync(dir)) return []
  const out: Cell[] = []
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const d = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { model: string; answers: Frozen[] }
    d.answers.forEach((a, i) => { if (a.answer) out.push({ gen: d.model, idx: i, a }) })
  }
  return out
}

// ── controls, offline ───────────────────────────────────────────────────────

const words = (s: string) => (s.toLowerCase().match(/[a-z0-9]+|[一-鿿]/g) ?? [])

/** Positive control: depends on the context by construction and nothing else.
 *  Deliberately NOT lib/assay/mentions.ts — see the design doc; that file's own
 *  header explains why token matching is a bad judge, which is exactly what
 *  makes it a good control here. */
function tokenOverlap(a: Frozen, rung: 'intact' | 'empty'): number {
  if (rung === 'empty') return 0
  const ctx = new Set(words(a.context))
  const ans = words(a.answer)
  if (!ans.length) return 0
  return ans.filter(w => ctx.has(w)).length / ans.length
}

/** Negative control: ignores both inputs. Benefit must come out at 0. */
const constantScorer = () => 0.7

function runControls(cells: Cell[]): { ok: boolean; lines: string[] } {
  const lines: string[] = []
  if (cells.length < 2) return { ok: false, lines: ['no frozen answers on disk'] }

  const posDiffs = cells.map(c => tokenOverlap(c.a, 'intact') - tokenOverlap(c.a, 'empty'))
  const posMean = posDiffs.reduce((s, x) => s + x, 0) / posDiffs.length
  const posOk = posMean > 0.2
  lines.push(`  positive · token overlap    benefit ${posMean.toFixed(3)}   ${posOk ? 'PASS' : 'FAIL — a context-only scorer must show a benefit'}`)

  const negDiffs = cells.map(() => constantScorer() - constantScorer())
  const negMax = Math.max(...negDiffs.map(Math.abs))
  const negOk = negMax === 0
  lines.push(`  negative · constant scorer  max|benefit| ${negMax.toFixed(3)}   ${negOk ? 'PASS' : 'FAIL'}`)

  return { ok: posOk && negOk, lines }
}

// ── judge ───────────────────────────────────────────────────────────────────

async function score(j: Judge, a: Frozen, rung: 'intact' | 'empty'): Promise<number | null> {
  const client = new OpenAI({ apiKey: j.apiKey, baseURL: j.baseURL })
  try {
    const res = await client.chat.completions.create({
      model: j.id,
      messages: [
        { role: 'system', content: JUDGE_SYSTEM },
        { role: 'user', content: userMessage(a, rung) },
      ],
      max_tokens: j.maxTokens,
      temperature: 0,
    })
    return parseScore(res.choices[0]?.message?.content ?? '')
  } catch (e) {
    if (!(e instanceof ScoreParseError)) process.stdout.write('!')
    return null // unreadable ≠ zero — FINDINGS #4
  }
}

async function pool<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length)
  let i = 0
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < xs.length) { const k = i++; out[k] = await f(xs[k]); process.stdout.write('.') }
  }))
  process.stdout.write('\n')
  return out
}

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length
const sd = (xs: number[]) => {
  if (xs.length < 2) return NaN
  const m = mean(xs)
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1))
}

async function main() {
  console.log('assay · substitution stage 1 — is the score a function of the context?')
  console.log('═'.repeat(78))

  const cells = loadCells()
  console.log(`\n${cells.length} frozen answers from ${new Set(cells.map(c => c.gen)).size} generators`)

  console.log('\n── controls (offline, before any judge call)')
  const ctrl = runControls(cells)
  ctrl.lines.forEach(l => console.log(l))
  if (!ctrl.ok) { console.log('\nA control failed. Not calling any judge.'); process.exit(1) }

  const judges = ALL_JUDGES.filter(j => j.apiKey)
  const missing = ALL_JUDGES.filter(j => !j.apiKey).map(j => j.id)
  console.log(`\n── judges reachable: ${judges.length}/${ALL_JUDGES.length}`)
  if (missing.length) console.log(`   unreachable (no credential): ${missing.join(', ')}`)
  if (!judges.length) { console.log('\nNo judge credential. Controls passed but nothing ran.'); process.exit(2) }

  const rows: Record<string, unknown>[] = []
  for (const j of judges) {
    console.log(`\n── ${j.id}`)
    // Two independent passes per condition: the gap between them is the floor.
    const jobs = cells.flatMap(c =>
      (['intact', 'empty'] as const).flatMap(r =>
        [1, 2].map(rep => ({ c, r, rep }))))
    process.stdout.write(`   ${jobs.length} calls  `)
    const got = await pool(jobs, 6, async ({ c, r }) => score(j, c.a, r))

    const by = new Map<string, Record<string, number | null>>()
    jobs.forEach((job, k) => {
      const key = `${job.c.gen}#${job.c.idx}`
      const e = by.get(key) ?? {}
      e[`${job.r}${job.rep}`] = got[k]
      by.set(key, e)
    })

    const ok = [...by.entries()].filter(([, v]) =>
      ['intact1', 'intact2', 'empty1', 'empty2'].every(k => typeof v[k] === 'number'))
    const drop = by.size - ok.length

    const noise = ok.flatMap(([, v]) => [
      Math.abs((v.intact1 as number) - (v.intact2 as number)),
      Math.abs((v.empty1 as number) - (v.empty2 as number)),
    ])
    const benefit = ok.map(([, v]) =>
      ((v.intact1 as number) + (v.intact2 as number)) / 2 -
      ((v.empty1 as number) + (v.empty2 as number)) / 2)

    console.log(`   usable ${ok.length}/${by.size}${drop ? `  (dropped ${drop}, unreadable ≠ zero)` : ''}`)
    if (ok.length < 2) { console.log('   too few usable cells to estimate sd'); continue }

    const mI = mean(ok.map(([, v]) => ((v.intact1 as number) + (v.intact2 as number)) / 2))
    const mE = mean(ok.map(([, v]) => ((v.empty1 as number) + (v.empty2 as number)) / 2))
    console.log(`\n   mean score   intact ${mI.toFixed(3)}   empty ${mE.toFixed(3)}`)
    console.log(`   BENEFIT      mean ${mean(benefit).toFixed(4)}   sd ${sd(benefit).toFixed(4)}   n ${benefit.length}`)
    console.log(`   noise floor  mean |repeat diff| ${mean(noise).toFixed(4)}   max ${Math.max(...noise).toFixed(3)}`)
    const identical = noise.filter(x => x === 0).length
    console.log(`                identical repeats ${identical}/${noise.length}`)

    // What this sd buys, using the same formula as scripts/stated_power.py.
    const s = sd(benefit), Z = 1.645 + 0.842
    console.log(`\n   at sd=${s.toFixed(3)}, n=${benefit.length} resolves a paired shift of ` +
      `${(Z * s / Math.sqrt(benefit.length)).toFixed(3)}`)
    for (const d of [0.05, 0.10, 0.20]) {
      console.log(`     to see δ=${d.toFixed(2)} needs n = ${Math.ceil((Z * s / d) ** 2)}`)
    }

    rows.push({ judge: j.id, n: benefit.length, dropped: drop, meanIntact: mI, meanEmpty: mE,
      benefitMean: mean(benefit), benefitSd: s, noiseMean: mean(noise), noiseMax: Math.max(...noise),
      perCell: ok.map(([k, v]) => ({ cell: k, ...v })) })
  }

  if (!existsSync('fixtures/runs')) mkdirSync('fixtures/runs', { recursive: true })
  writeFileSync('fixtures/runs/substitution-stage1.json', JSON.stringify(rows, null, 2))
  console.log('\n═'.repeat(78))
  console.log('raw → fixtures/runs/substitution-stage1.json')
  console.log('\nStage 2 (the full ladder) is gated on this sd. See docs/SUBSTITUTION-CONTROL.md.')
}

main().catch(e => { console.error(e); process.exit(1) })
