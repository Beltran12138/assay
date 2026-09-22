#!/usr/bin/env tsx
/**
 * Substitution control — does the judge use what it reads?
 *
 *   npm run substitution            # stage 1: intact vs empty, measure sd
 *   npm run substitution -- --stage2  # the ladder, identity_free as the contrast
 *
 * `docs/SUBSTITUTION-CONTROL.md` has the design, the pre-registration, and the
 * stage-1 result that changed stage 2 before it ran.
 *
 * ─── Stage 1, kept ──────────────────────────────────────────────────────────
 *
 * Two rungs only, because the design doc forbids running the full ladder before
 * the sd is known. It found something else on the way: with the Context block
 * deleted, MiniMax returned a perfect 1.0 seven times and GLM twice, on a prompt
 * where "every claim is supported by the context" has no truth-maker. deepseek
 * returned 0 on all 78. See FINDINGS #19.
 *
 * ─── Stage 2, and two things the corpus would not allow ─────────────────────
 *
 * The design doc specified six rungs including `sibling` (another context from
 * the SAME intent) and `distant` (a different intent), whose gap was to be the
 * graded-dependence probe. The corpus cannot support it:
 *
 *   · 13 queries spread over 11 intents — only `fee` and `withdraw` have two
 *     each, so `sibling` exists for 4 queries out of 13;
 *   · all three generators answer the same 13 queries, so there are 13 distinct
 *     contexts, not 39. The 39 cells share them.
 *
 * At n=12 with the measured sd of 0.23 the sibling rung resolves 0.17, which is
 * larger than any effect worth reporting. So `sibling` and `distant` are merged
 * into one rung, `other`, and the graded probe is dropped rather than run
 * underpowered. This is a corpus limit, not a finding.
 *
 * MiniMax is excluded from stage 2: its stage-1 noise floor (0.1671) is
 * essentially the smallest shift its n and sd can resolve (0.173).
 */

import { config as loadEnv } from 'dotenv'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs'
import OpenAI from 'openai'

loadEnv({ path: '.env.local' })
loadEnv()

import { parseScore, ScoreParseError } from '../lib/assay/parse'
import {
  CLAIM_JUDGE_SYSTEM, blockTitles, claimUserMessage, derivedScore, localisation,
  parseClaimReport, type ClaimReport, type Localisation,
} from '../lib/assay/claims'

const STAGE2 = process.argv.includes('--stage2')
const STAGE3 = process.argv.includes('--stage3')
const STAGE4 = process.argv.includes('--stage4')
const CLAIMS = process.argv.includes('--claims')
/** Repeat runs go to their own artifact. A rerun at temperature 0 on the same
 *  cells is the decomposition-stability check FINDINGS #23 listed as missing, so
 *  it must not overwrite the run it is being compared against. */
const TAG = (() => {
  const i = process.argv.indexOf('--tag')
  return i > 0 && process.argv[i + 1] ? `-${process.argv[i + 1]}` : ''
})()

const ROUTER_BASE = process.env.ASSAY_JUDGE_BASE_URL
const ROUTER_KEY = process.env.ASSAY_JUDGE_API_KEY

type Judge = { id: string; baseURL: string; apiKey: string | undefined; maxTokens: number }

// ⚠️ Not the same panel as assay-selfpref.ts. `moonshotai/Kimi-K2.6` is no
// longer served by the router (checked 2026-09-21). Kimi supplied the −0.373
// self-preference in FINDINGS #5, so that cell is not reproducible; the raw
// matrix survives in fixtures/runs/selfpref-matrix.json.
const STAGE1_JUDGES: Judge[] = [
  { id: 'deepseek-chat', baseURL: 'https://api.deepseek.com', apiKey: process.env.DEEPSEEK_API_KEY, maxTokens: 400 },
  { id: 'MiniMaxAI/MiniMax-M2.7', baseURL: ROUTER_BASE!, apiKey: ROUTER_KEY, maxTokens: 1600 },
  { id: 'zai-org/GLM-5.3-Flash', baseURL: ROUTER_BASE!, apiKey: ROUTER_KEY, maxTokens: 1600 },
]
const STAGE2_JUDGES = STAGE1_JUDGES.filter(j => !j.id.includes('MiniMax'))

// Verbatim from assay-selfpref.ts:103.
const JUDGE_SYSTEM =
  'You grade whether an answer stays inside its source context. ' +
  'You are NOT judging whether the answer is true — only whether every claim it makes ' +
  'is supported by the context given. Reply with ONLY a decimal number between 0 and 1.'

const TAIL = '0.0 = contains claims absent from the context / 1.0 = every claim is supported.'

type Rung = 'intact' | 'shuffled' | 'other' | 'identity_free' | 'empty' | 'swap_top1' | 'swap_bot2' | 'contradict' | 'perturb_unused'
const STAGE1_RUNGS: Rung[] = ['intact', 'empty']
const STAGE2_RUNGS: Rung[] = ['intact', 'identity_free', 'shuffled', 'other', 'empty']
const STAGE3_RUNGS: Rung[] = ['intact', 'swap_top1', 'swap_bot2', 'identity_free']
// Stage 4: one fact rewritten so the context CONTRADICTS the answer. Everything
// else — length, topic, block count, internal coherence — is held. It is the
// rung FINDINGS #21 listed as untried; it was first scoped as `one_number` and
// rejected for power (4 of 13 queries share a numeric token), then widened from
// "change a number" to "contradict a stated fact", which all 11 contexts allow.
// `perturb_unused` is the controlled comparison: an edit of the same kind and
// size, landing on the 常見追問 line that no answer draws on. The cited/uncited
// split from `cite` is kept as a secondary read but is badly unbalanced (34 vs
// 5) and depends on whether an answer happened to mention the fact; this rung
// does not depend on that.
const STAGE4_RUNGS: Rung[] = ['intact', 'contradict', 'perturb_unused']
/** Repeats per rung. The two anchors of the contrast get two; the rest get one,
 *  because stage 1 already measured the noise floor for these judges. */
const REPEATS: Record<Rung, number> = {
  intact: 2, identity_free: 2, shuffled: 1, other: 1, empty: 1,
  // stage 3: the two swap rungs are the contrast, identity_free only anchors the
  // floor and stage 2 already showed it is a hard 0.000 for both judges.
  swap_top1: 2, swap_bot2: 2,
  contradict: 2, perturb_unused: 2,
}

type Frozen = { query: string; intent: string; context: string; answer: string }
type Cell = { gen: string; idx: number; a: Frozen }

// ── deterministic rng, so a rerun substitutes the same things ───────────────
function rng(seed: number) {
  let s = seed >>> 0
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
}

// ── the filler corpus: same shape, unrelated world ──────────────────────────
// Matched on the observed structure — a header line, 【】-titled blocks, and a
// 常見追問 line each — and on length (real contexts run 370–563 chars).
const HEADER = '\n\nRelevant knowledge base context (use this to answer accurately):\n'
const FILLER = [
  ['春季播种', '番茄适宜在土温稳定在12度以上时移栽，过早移栽会导致根系停滞。行距建议保持在60厘米，株距40厘米，便于后期搭架与通风。', '什么时候搭架？ / 需要多少底肥？'],
  ['浇水与排水', '苗期保持土壤见干见湿，结果期需水量增加约三成。雨季须提前开挖排水沟，积水超过6小时容易引发根腐。', '滴灌和沟灌哪个好？ / 叶片发黄是缺水吗？'],
  ['常见病害', '晚疫病多在连续阴雨后发生，叶背出现水渍状斑点。发现后须立即摘除病叶并远离田块销毁，不可堆在地头。', '可以用什么药？ / 会传染给辣椒吗？'],
  ['整枝与打杈', '单干整枝保留主茎，侧枝长到5厘米时及时摘除。打杈宜在晴天上午进行，伤口当天可以愈合。', '双干整枝什么时候用？ / 打杈后要喷药吗？'],
  ['采收与储运', '果实转色七成时采收最耐运输，完全红熟的果实货架期不足3天。采后避免阳光直射，堆放高度不超过4层。', '青果能催熟吗？ / 冷库温度设多少？'],
]

function identityFree(targetLen: number, r: () => number): string {
  const order = [...FILLER].sort(() => r() - 0.5)
  let out = HEADER
  let i = 0
  while (out.length < targetLen && i < order.length * 3) {
    const [t, b, q] = order[i % order.length]
    out += `【${t}】\n${b}\n常見追問：${q}\n\n`
    i++
  }
  return out.slice(0, Math.max(targetLen, HEADER.length + 60))
}

/** Does the filler leak anything the answer could be scored against?
 *
 *  Chinese single characters overlap by construction, so the test has to be on
 *  tokens that carry gradeable facts. The first version counted every integer
 *  and reported 19/39 cells "leaking" — on inspection the shared tokens were
 *  `3, 4, 6, 5`, bare digits from "6小时" and "5厘米" in the filler colliding
 *  with unrelated digits in the answers. That is not a leak, it is the birthday
 *  problem on a ten-symbol alphabet.
 *
 *  A leak is a token specific enough that a judge could match it: a decimal or
 *  percentage figure, or a latin term of three or more characters. */
function leakTokens(answer: string, filler: string): string[] {
  const facty = (s: string) =>
    new Set(s.match(/\d+\.\d+%?|\d+%|[A-Za-z][A-Za-z0-9.-]{2,}/g) ?? [])
  const f = facty(filler)
  return [...facty(answer)].filter(t => f.has(t))
}

// ── stage 3: partial degradation ────────────────────────────────────────────
// Stage 2 left every rung except `shuffled` at the floor: both judges score
// 0.000 on identity_free and on another real context. The ladder has no middle,
// and real deployments degrade context partially, not totally.
//
// `one_number` (alter a single figure the answer depends on) was the first
// choice and was dropped: only 4 of 13 queries share a numeric token between
// answer and context, which is 12 cells and resolves 0.17 — the same
// underpowering that killed `sibling`.
//
// These two swap block-for-block, so length, format and block count are held
// fixed, and they are designed to point in OPPOSITE directions:
//
//   swap_top1  replaces the ONE block most related to the answer  (1/3 of the text)
//   swap_bot2  replaces the TWO least related blocks              (2/3 of the text)
//
// A judge tracking *which* block supports the answer loses more on top1. A judge
// counting *how much* genuine material is present loses more on bot2. The pair
// is a discriminator, not two more points on a line.

function splitBlocks(ctx: string): { header: string; blocks: string[] } {
  const i = ctx.indexOf('【')
  if (i < 0) return { header: ctx, blocks: [] }
  return { header: ctx.slice(0, i), blocks: ctx.slice(i).split(/\n\n(?=【)/).filter(b => b.trim()) }
}

/** Character-set overlap with the answer. Crude on purpose: it decides only
 *  which block to remove, and the removal is what gets measured. */
function relevance(block: string, answer: string): number {
  const a = new Set(answer), b = new Set(block)
  return b.size ? [...b].filter(c => a.has(c)).length / b.size : 0
}

function fillerBlock(i: number): string {
  const [t, b, q] = FILLER[i % FILLER.length]
  return `【${t}】\n${b}\n常見追問：${q}`
}

function swapBlocks(a: Frozen, mode: 'top1' | 'bot2'): string | null {
  const { header, blocks } = splitBlocks(a.context)
  if (blocks.length < 3) return null
  const ranked = blocks.map((b, i) => ({ i, s: relevance(b, a.answer) })).sort((x, y) => y.s - x.s)
  const victims = new Set(mode === 'top1' ? [ranked[0].i] : ranked.slice(-2).map(x => x.i))
  let f = 0
  return header + blocks.map((b, i) => (victims.has(i) ? fillerBlock(f++) : b)).join('\n\n')
}

type Contradiction = { match: string; find: string; replace: string; cite: string }
const CONTRADICTIONS: Contradiction[] = (() => {
  try {
    return JSON.parse(readFileSync('fixtures/contradictions.json', 'utf8')).contradictions
  } catch { return [] }
})()

function contradictionFor(ctx: string): Contradiction | null {
  return CONTRADICTIONS.find(c => ctx.includes(c.match) && ctx.includes(c.find)) ?? null
}

/** Did this answer actually rely on the fact we are about to break?
 *  Decided offline from the frozen answer, so the cited/uncited split is not a
 *  judgement call made after seeing scores. */
function cites(a: Frozen): boolean {
  const c = contradictionFor(a.context)
  return !!c && a.answer.includes(c.cite)
}

function contradict(a: Frozen): string | null {
  const c = contradictionFor(a.context)
  return c ? a.context.replace(c.find, c.replace) : null
}

/** Same kind of edit, same rough size, on material no answer relies on. */
function perturbUnused(a: Frozen): string | null {
  const m = a.context.match(/常見追問：[^\n]+/)
  return m ? a.context.replace(m[0], '常見追問：可以用支付宝付款吗？ / 客服电话是多少？') : null
}

/** Positive control for stage 4. Token overlap cannot see a single swapped
 *  value, so it cannot validate this rung; this can. Fraction of the answer's
 *  fact tokens still present in the context. */
function factMatch(a: Frozen, ctx: string | null): number {
  if (ctx === null) return 0
  const facts = (s: string) => s.match(/\d+(?:\.\d+)?%?|[A-Za-z][A-Za-z0-9.-]{2,}/g) ?? []
  const inCtx = new Set(facts(ctx))
  const ans = facts(a.answer)
  return ans.length ? ans.filter(f => inCtx.has(f)).length / ans.length : 1
}

function shuffleSentences(ctx: string, r: () => number): string {
  const parts = ctx.split(/(?<=[。！？\n])/).filter(s => s.trim())
  for (let i = parts.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
      ;[parts[i], parts[j]] = [parts[j], parts[i]]
  }
  return parts.join('')
}

function buildContext(a: Frozen, rung: Rung, others: string[], r: () => number): string | null {
  switch (rung) {
    case 'intact': return a.context
    case 'empty': return null
    case 'shuffled': return shuffleSentences(a.context, r)
    case 'other': {
      const pool = others.filter(c => c !== a.context)
      return pool[Math.floor(r() * pool.length)]
    }
    case 'identity_free': return identityFree(a.context.length, r)
    case 'swap_top1': return swapBlocks(a, 'top1')
    case 'swap_bot2': return swapBlocks(a, 'bot2')
    case 'contradict': return contradict(a)
    case 'perturb_unused': return perturbUnused(a)
  }
}

function userMessage(a: Frozen, ctx: string | null): string {
  return ctx === null
    ? `Answer:\n${a.answer}\n\n${TAIL}`
    : `Context:\n${ctx}\n\nAnswer:\n${a.answer}\n\n${TAIL}`
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
 *  Deliberately NOT lib/assay/mentions.ts — that file's header explains why
 *  token matching is a bad judge, which is exactly what makes it a good control. */
function tokenOverlap(a: Frozen, ctx: string | null): number {
  if (ctx === null) return 0
  const set = new Set(words(ctx))
  const ans = words(a.answer)
  return ans.length ? ans.filter(w => set.has(w)).length / ans.length : 0
}

const constantScorer = () => 0.7

function runControls(cells: Cell[], others: string[]): { ok: boolean; lines: string[] } {
  const lines: string[] = []
  if (cells.length < 2) return { ok: false, lines: ['no frozen answers on disk'] }
  const r = rng(99)

  // The positive control must fall as the ladder degrades, or the ladder is not
  // a ladder. This is the rung ordering asserted offline, before any judge runs.
  const rungs = STAGE4 ? STAGE4_RUNGS : STAGE3 ? STAGE3_RUNGS : STAGE2 ? STAGE2_RUNGS : STAGE1_RUNGS
  const means = rungs.map(rung => {
    const v = cells.map(c => tokenOverlap(c.a, buildContext(c.a, rung, others, r)))
    return [rung, v.reduce((s, x) => s + x, 0) / v.length] as const
  })
  lines.push('  positive · token overlap by rung: ' +
    means.map(([k, m]) => `${k} ${m.toFixed(3)}`).join('  '))
  const intactM = means.find(([k]) => k === 'intact')![1]
  const idfM = means.find(([k]) => k === 'identity_free')?.[1] ?? 0
  const posOk = intactM > 0.2 && intactM > idfM
  lines.push(`  positive verdict: ${posOk ? 'PASS' : 'FAIL — intact must beat identity_free for a context-only scorer'}`)

  const negOk = constantScorer() - constantScorer() === 0
  lines.push(`  negative · constant scorer  max|diff| 0.000   ${negOk ? 'PASS' : 'FAIL'}`)

  if (STAGE4) {
    const r4 = rng(1)
    const fm = (rg: Rung) => {
      const v = cells.map(c => factMatch(c.a, buildContext(c.a, rg, others, r4)))
      return v.reduce((s, x) => s + x, 0) / v.length
    }
    const [fi, fc, fu] = [fm('intact'), fm('contradict'), fm('perturb_unused')]
    lines.push(`  positive · fact match:  intact ${fi.toFixed(3)}  contradict ${fc.toFixed(3)}  perturb_unused ${fu.toFixed(3)}`)
    const ok4 = fc < fi - 0.005 && Math.abs(fu - fi) < 0.005
    lines.push(`  stage-4 verdict: ${ok4 ? 'PASS' : 'FAIL — contradict must lower fact match and perturb_unused must not'}`)
    const nCited = cells.filter(c => cites(c.a)).length
    lines.push(`  secondary split: cited ${nCited}/${cells.length}, uncited ${cells.length - nCited} (underpowered, reported not relied on)`)
    if (!ok4) return { ok: false, lines }
  }
  if (STAGE2 || STAGE3) {
    const r2 = rng(7)
    const leaks = cells.map(c => leakTokens(c.a.answer, identityFree(c.a.context.length, r2)))
    const nLeak = leaks.filter(l => l.length).length
    lines.push(`  identity_free leak check: ${nLeak}/${cells.length} cells share a fact token` +
      (nLeak ? `  e.g. ${[...new Set(leaks.flat())].slice(0, 6).join(', ')}` : ''))
    if (nLeak) lines.push('    ⚠️ non-zero leak — report it, do not silently proceed as if clean')
  }
  return { ok: posOk && negOk, lines }
}

// ── judge ───────────────────────────────────────────────────────────────────

async function score(j: Judge, a: Frozen, ctx: string | null): Promise<number | null> {
  const client = new OpenAI({ apiKey: j.apiKey, baseURL: j.baseURL })
  try {
    const res = await client.chat.completions.create({
      model: j.id,
      messages: [
        { role: 'system', content: JUDGE_SYSTEM },
        { role: 'user', content: userMessage(a, ctx) },
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

// ── claim-level mode (--claims) ─────────────────────────────────────────────
//
// FINDINGS #22 closed on this gap: every rung reads one number, so "the judge
// located the contradiction" and "the judge felt something was off" are the
// same datum. The fix is a different reply, not another rung — see
// lib/assay/claims.ts for the three levels and why the whitepaper's
// session/trajectory/step vocabulary does not transfer to a single-turn probe.
//
// The rung set is stage 4's, because that is where the ground truth lives:
// fixtures/contradictions.json names the block carrying the rewritten fact, so
// a claim-level reply can be checked against it rather than believed.
//
// ⚠️ `contradict` alone proves nothing. A judge that names the fee block on
// every context would score 100% located and be measuring nothing. `intact` and
// `perturb_unused` are run as the false-alarm control: same cells, same
// question, nothing broken in the block under test. Localisation is only
// readable as the gap between them. The whitepaper's three-level attribution
// ships with no such control — it assumes the attribution is right.

const CLAIM_RUNGS: Rung[] = ['intact', 'contradict', 'perturb_unused']

/** Why a cell produced nothing. FINDINGS #23 ran without this distinction and
 *  could not say whether GLM's 16 losses were malformed JSON or a router
 *  timeout — which is the difference between "this judge cannot hold the output
 *  format" (a result) and "the network was busy" (noise). */
type ClaimOutcome =
  | { ok: true; report: ClaimReport }
  | { ok: false; why: 'transport' | 'unparseable'; detail: string }

async function scoreClaims(j: Judge, a: Frozen, ctx: string | null): Promise<ClaimOutcome> {
  const client = new OpenAI({ apiKey: j.apiKey, baseURL: j.baseURL })
  let raw: string
  try {
    const res = await client.chat.completions.create({
      model: j.id,
      messages: [
        { role: 'system', content: CLAIM_JUDGE_SYSTEM },
        { role: 'user', content: claimUserMessage(ctx, a.answer) },
      ],
      // A structured reply needs more room than a bare decimal; a truncated
      // object parses as nothing, which is the correct outcome but wastes the call.
      max_tokens: Math.max(j.maxTokens, 1200),
      temperature: 0,
    })
    raw = res.choices[0]?.message?.content ?? ''
  } catch (e) {
    process.stdout.write('T')
    return { ok: false, why: 'transport', detail: e instanceof Error ? e.message : String(e) }
  }
  try {
    // unparseable ≠ "everything supported" — FINDINGS #4
    return { ok: true, report: parseClaimReport(raw, blockTitles(ctx ?? '')) }
  } catch (e) {
    process.stdout.write('P')
    return { ok: false, why: 'unparseable', detail: e instanceof Error ? e.message : String(e) }
  }
}

async function claimsMain() {
  console.log('assay · substitution --claims — did the judge find it, or only feel it?')
  console.log('═'.repeat(78))

  const all = loadCells()
  // Only cells whose context has a registered contradiction: without ground
  // truth there is nothing to check a localisation against.
  const cells = all.filter(c => contradictionFor(c.a.context))
  console.log(`\n${cells.length}/${all.length} frozen answers have a registered contradiction`)
  if (cells.length < 3) { console.log('too few to read anything'); process.exit(1) }

  const judges = STAGE2_JUDGES.filter(j => j.apiKey)
  console.log(`── judges reachable: ${judges.length}/${STAGE2_JUDGES.length}`)
  if (!judges.length) { console.log('\nNo judge credential. Nothing ran.'); process.exit(2) }

  const rows: Record<string, unknown>[] = []
  for (const j of judges) {
    console.log(`\n── ${j.id}`)
    const jobs = cells.flatMap(c => CLAIM_RUNGS.map(rg => ({ c, rg })))
    process.stdout.write(`   ${jobs.length} calls  `)
    const got = await pool(jobs, 6, async ({ c, rg }) =>
      scoreClaims(j, c.a, buildContext(c.a, rg, [], rng(c.idx * 31 + rg.length * 7))))

    type Row = {
      cell: string; rung: Rung; loc: Localisation | null
      derived: number | null; claims: number | null
      lost: 'transport' | 'unparseable' | null
    }
    const out: Row[] = jobs.map(({ c, rg }, k) => {
      const r = got[k]
      // The block under test is the same one in every rung — on `intact` and
      // `perturb_unused` it is intact, which is exactly what makes them the control.
      const target = contradictionFor(c.a.context)!.match.replace(/[【】]/g, '')
      return {
        cell: `${c.gen}#${c.idx}`,
        rung: rg,
        loc: r.ok ? localisation(r.report, target) : null,
        derived: r.ok ? derivedScore(r.report) : null,
        claims: r.ok ? r.report.findings.length : null,
        lost: r.ok ? null : r.why,
      }
    })

    const nTransport = out.filter(r => r.lost === 'transport').length
    const nUnparseable = out.filter(r => r.lost === 'unparseable').length
    const unreadable = nTransport + nUnparseable
    console.log(`   lost: ${unreadable}/${out.length} — ${nTransport} transport, ${nUnparseable} unparseable ` +
      `(dropped, never counted as supported)`)
    if (nUnparseable > 0) {
      // A judge that cannot hold the output format is a result about that judge,
      // not noise, so the first example is printed rather than buried in the JSON.
      const eg = got.find(r => !r.ok && r.why === 'unparseable')
      if (eg && !eg.ok) console.log(`      e.g. ${eg.detail.slice(0, 160)}`)
    }

    console.log(`\n   ${'rung'.padEnd(17)}${'located'.padStart(9)}${'felt'.padStart(8)}${'missed'.padStart(8)}` +
      `${'derived'.padStart(10)}${'claims/ans'.padStart(12)}`)
    for (const rg of CLAIM_RUNGS) {
      const xs = out.filter(r => r.rung === rg && r.loc !== null)
      if (!xs.length) { console.log(`   ${rg.padEnd(17)}   (no readable replies)`); continue }
      const share = (l: Localisation) => xs.filter(r => r.loc === l).length / xs.length
      console.log(`   ${rg.padEnd(17)}${share('located').toFixed(3).padStart(9)}${share('felt').toFixed(3).padStart(8)}` +
        `${share('missed').toFixed(3).padStart(8)}${mean(xs.map(r => r.derived!)).toFixed(3).padStart(10)}` +
        `${mean(xs.map(r => r.claims!)).toFixed(1).padStart(12)}`)
    }

    const rate = (rg: Rung) => {
      const xs = out.filter(r => r.rung === rg && r.loc !== null)
      return xs.length ? xs.filter(r => r.loc === 'located').length / xs.length : NaN
    }
    const lift = rate('contradict') - Math.max(rate('intact'), rate('perturb_unused'))
    console.log(`\n   ⭐ localisation lift = ${lift.toFixed(3)}  ` +
      `(contradict ${rate('contradict').toFixed(3)} − worst control ${Math.max(rate('intact'), rate('perturb_unused')).toFixed(3)})`)
    console.log(`      A judge that names this block regardless scores 0 here, however high its raw located rate.`)

    rows.push({
      judge: j.id, mode: 'claims', n: cells.length,
      lost: { transport: nTransport, unparseable: nUnparseable }, lift, perCell: out,
    })
  }

  if (!existsSync('fixtures/runs')) mkdirSync('fixtures/runs', { recursive: true })
  const out = `fixtures/runs/substitution-claims${TAG}.json`
  writeFileSync(out, JSON.stringify(rows, null, 2))
  console.log(`\n${'═'.repeat(78)}\nraw → ${out}`)
}

async function main() {
  if (CLAIMS) return claimsMain()
  const stage = STAGE4 ? 4 : STAGE3 ? 3 : STAGE2 ? 2 : 1
  const rungs = STAGE4 ? STAGE4_RUNGS : STAGE3 ? STAGE3_RUNGS : STAGE2 ? STAGE2_RUNGS : STAGE1_RUNGS
  const judgesAll = STAGE2 || STAGE3 || STAGE4 ? STAGE2_JUDGES : STAGE1_JUDGES

  console.log(`assay · substitution stage ${stage} — is the score a function of the context?`)
  console.log('═'.repeat(78))

  const cells = loadCells()
  const contexts = [...new Set(cells.map(c => c.a.context))]
  console.log(`\n${cells.length} frozen answers · ${contexts.length} distinct contexts · rungs: ${rungs.join(' / ')}`)

  console.log('\n── controls (offline, before any judge call)')
  const ctrl = runControls(cells, contexts)
  ctrl.lines.forEach(l => console.log(l))
  if (!ctrl.ok) { console.log('\nA control failed. Not calling any judge.'); process.exit(1) }

  const judges = judgesAll.filter(j => j.apiKey)
  const missing = judgesAll.filter(j => !j.apiKey).map(j => j.id)
  console.log(`\n── judges reachable: ${judges.length}/${judgesAll.length}`)
  if (missing.length) console.log(`   unreachable: ${missing.join(', ')}`)
  if (!judges.length) { console.log('\nNo judge credential. Controls passed but nothing ran.'); process.exit(2) }

  const rows: Record<string, unknown>[] = []
  for (const j of judges) {
    console.log(`\n── ${j.id}`)
    const jobs = cells.flatMap(c =>
      rungs.flatMap(rg =>
        Array.from({ length: STAGE2 || STAGE3 || STAGE4 ? REPEATS[rg] : 2 }, (_, k) => ({ c, rg, rep: k + 1 }))))
    process.stdout.write(`   ${jobs.length} calls  `)
    // Seeded per cell+rung so a rerun swaps in the same substitute.
    const got = await pool(jobs, 8, async ({ c, rg, rep }) =>
      score(j, c.a, buildContext(c.a, rg, contexts, rng(c.idx * 31 + rg.length * 7 + rep))))

    const by = new Map<string, Record<string, number | null>>()
    jobs.forEach((job, k) => {
      const key = `${job.c.gen}#${job.c.idx}`
      const e = by.get(key) ?? {}
      e[`${job.rg}${job.rep}`] = got[k]
      by.set(key, e)
    })

    const avg = (v: Record<string, number | null>, rg: Rung) => {
      const xs = Object.entries(v).filter(([k, x]) => k.startsWith(rg) && typeof x === 'number').map(([, x]) => x as number)
      return xs.length ? mean(xs) : null
    }
    const usable = [...by.entries()].filter(([, v]) => rungs.every(rg => avg(v, rg) !== null))
    console.log(`   usable ${usable.length}/${by.size}`)
    if (usable.length < 3) { console.log('   too few usable cells'); continue }

    console.log(`\n   ${'rung'.padEnd(15)}${'mean'.padStart(8)}${'sd'.padStart(9)}${'Δ vs intact'.padStart(14)}`)
    const intactV = usable.map(([, v]) => avg(v, 'intact')!)
    for (const rg of rungs) {
      const xs = usable.map(([, v]) => avg(v, rg)!)
      const d = usable.map(([, v]) => avg(v, 'intact')! - avg(v, rg)!)
      console.log(`   ${rg.padEnd(15)}${mean(xs).toFixed(3).padStart(8)}${sd(xs).toFixed(3).padStart(9)}` +
        (rg === 'intact' ? '—'.padStart(14) : `${mean(d).toFixed(3).padStart(9)} ±${(1.96 * sd(d) / Math.sqrt(d.length)).toFixed(3)}`))
    }

    const dIdf = usable.map(([, v]) => avg(v, 'intact')! - avg(v, 'identity_free')!)
    if (STAGE2 || STAGE3) {
      const m = mean(dIdf), s = sd(dIdf), n = dIdf.length
      const half = 1.96 * s / Math.sqrt(n)
      console.log(`\n   ⭐ Δ(intact − identity_free) = ${m.toFixed(4)}  95% CI [${(m - half).toFixed(3)}, ${(m + half).toFixed(3)}]  n=${n}`)
      console.log(`      share of intact retained by unrelated filler: ${(1 - m / mean(intactV)).toFixed(3)}`)
      console.log(`      cells where filler scored >= intact: ${dIdf.filter(x => x <= 0).length}/${n}`)
    }

    rows.push({
      judge: j.id, stage, n: usable.length,
      perRung: Object.fromEntries(rungs.map(rg => [rg, {
        mean: mean(usable.map(([, v]) => avg(v, rg)!)),
        sd: sd(usable.map(([, v]) => avg(v, rg)!)),
      }])),
      deltaIdentityFree: STAGE2 || STAGE3 ? { mean: mean(dIdf), sd: sd(dIdf), n: dIdf.length } : null,
      perCell: usable.map(([k, v]) => ({ cell: k, ...v })),
    })
  }

  if (!existsSync('fixtures/runs')) mkdirSync('fixtures/runs', { recursive: true })
  const out = `fixtures/runs/substitution-stage${stage}.json`
  writeFileSync(out, JSON.stringify(rows, null, 2))
  console.log(`\n${'═'.repeat(78)}\nraw → ${out}`)
}

main().catch(e => { console.error(e); process.exit(1) })
