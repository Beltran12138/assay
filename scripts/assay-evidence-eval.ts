#!/usr/bin/env tsx
/**
 * argument_evidence eval — does the judge's evidence score agree with a human-checked label?
 *
 *   npm run evidence-eval -- --variant baseline --reps 3
 *   npm run evidence-eval -- --variant pilot --ids cardio-02,kaoyan-03 --reps 1
 *   npm run evidence-eval -- --variant oracle-check --fake oracle   # no network
 *   npm run evidence-eval -- --variant null-check --fake null       # no network
 *
 * Cases, labels and the labeling policy live in .claude/hillclimb/argument-evidence/
 * (built with /claude-api build-eval). The prompt under test is `scorePrompt` from
 * lib/assay/argument-prompt.ts, the same one the rebuttal probe uses.
 *
 * Grading: the judge returns s in 0..1; it is compared to a 0..3 anchor label as
 * |3s - label| (the headline, lower is better), plus exact and within-one agreement
 * on round(3s). Labels carry their own noise: two raters reached MAE 0.25 against
 * each other (ROUND1-AGREEMENT.md), so this eval is DIRECTIONAL — differences under
 * ~0.5 are not evidence of anything.
 *
 * Contract: results.jsonl (one row per scored case×rep, written as it lands),
 * traces/<id>_rep<k>.json, errors.jsonl for attempts that produced no score.
 * A parse failure or API error is never written as a zero.
 */

import { config as loadEnv } from 'dotenv'
import OpenAI from 'openai'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

loadEnv({ path: '.env.local' })
loadEnv()

import { parseScore, ScoreParseError } from '../lib/assay/parse'
import { scorePrompt } from '../lib/assay/argument-prompt'

const FLOW = '.claude/hillclimb/argument-evidence'
const JUDGE_MODEL = process.env.ASSAY_JUDGE_MODEL ?? 'deepseek-chat'
const JUDGE_KEY = process.env.ASSAY_JUDGE_API_KEY ?? process.env.DEEPSEEK_API_KEY
const JUDGE_BASE_URL = process.env.ASSAY_JUDGE_BASE_URL ?? 'https://api.deepseek.com'
const JUDGE_MAX_TOKENS = Number(process.env.ASSAY_JUDGE_MAX_TOKENS ?? 1600)
// DeepSeek-specific: deepseek-flash thinks by default; 'disabled' reproduces the legacy
// deepseek-chat behaviour. Unset = send nothing (provider default).
const JUDGE_THINKING = process.env.ASSAY_JUDGE_THINKING as 'enabled' | 'disabled' | undefined

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 ? process.argv[i + 1] : dflt
}
const VARIANT = arg('variant', 'baseline')!
const REPS = Number(arg('reps', '1'))
const IDS = arg('ids')?.split(',')
const FAKE = arg('fake') as 'oracle' | 'null' | undefined
const TIMEOUT_S = Number(arg('timeout-s', '120'))
const CONCURRENCY = Number(arg('concurrency', '4'))
const MAX_ATTEMPTS = 4

if (!/^(baseline|v\d+|pilot\d*|oracle-check|null-check)$/.test(VARIANT)) {
  console.error(`bad --variant ${VARIANT}`)
  process.exit(2)
}

type Case = { prompt_id: string; topic: string; prompt: string; tags: string[] }
type Label = { prompt_id: string; label: number }

const readJsonl = <T>(p: string): T[] =>
  readFileSync(p, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T)

const cases = readJsonl<Case>(join(FLOW, 'cases.jsonl')).filter((c) => !IDS || IDS.includes(c.prompt_id))
const labels = new Map(readJsonl<Label>(join(FLOW, 'labels.claude.jsonl')).map((l) => [l.prompt_id, l.label]))
if (IDS && cases.length !== IDS.length) {
  console.error(`--ids named ${IDS.length} cases, found ${cases.length}`)
  process.exit(2)
}

const out = join(FLOW, VARIANT)
mkdirSync(join(out, 'traces'), { recursive: true })
const resultsPath = join(out, 'results.jsonl')
const errorsPath = join(out, 'errors.jsonl')
const done = new Set(
  existsSync(resultsPath) ? readJsonl<{ prompt_id: string; rep: number }>(resultsPath).map((r) => `${r.prompt_id}#${r.rep}`) : [],
)

if (!FAKE && !JUDGE_KEY) {
  console.error('no judge key (ASSAY_JUDGE_API_KEY or DEEPSEEK_API_KEY)')
  process.exit(2)
}
const judge = new OpenAI({ apiKey: JUDGE_KEY ?? 'unused', baseURL: JUDGE_BASE_URL, maxRetries: 0 })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function grade(s: number, label: number) {
  const anchor = Math.round(3 * s)
  return {
    mae: Math.abs(3 * s - label),
    exact: anchor === label ? 1 : 0,
    within1: Math.abs(anchor - label) <= 1 ? 1 : 0,
  }
}

async function callJudge(prompt: string) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_S * 1000)
  const t0 = Date.now()
  try {
    const res = await judge.chat.completions.create(
      {
        model: JUDGE_MODEL,
        max_tokens: JUDGE_MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
        ...(JUDGE_THINKING ? { thinking: { type: JUDGE_THINKING } } : {}),
      } as OpenAI.ChatCompletionCreateParamsNonStreaming,
      { signal: ac.signal },
    )
    return { res, latency_s: (Date.now() - t0) / 1000 }
  } finally {
    clearTimeout(timer)
  }
}

async function runOne(c: Case, rep: number): Promise<void> {
  const key = `${c.prompt_id}#${rep}`
  if (done.has(key)) return
  const label = labels.get(c.prompt_id)
  if (label === undefined) throw new Error(`no label for ${c.prompt_id}`)
  const prompt = scorePrompt('argument_evidence', c.prompt)

  if (FAKE) {
    const s = FAKE === 'oracle' ? label / 3 : 0.5
    appendFileSync(resultsPath, JSON.stringify({
      prompt_id: c.prompt_id, rep, prompt: c.prompt, tags: c.tags, status: 'ok', stop_reason: 'fake',
      model: `fake-${FAKE}`, score: s, label, grade: grade(s, label), usage: { input_tokens: 0, output_tokens: 0 }, latency_s: 0,
    }) + '\n')
    return
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { res, latency_s } = await callJudge(prompt)
      const raw = res.choices[0]?.message?.content ?? ''
      const finish = res.choices[0]?.finish_reason ?? 'unknown'
      const usage = { input_tokens: res.usage?.prompt_tokens ?? 0, output_tokens: res.usage?.completion_tokens ?? 0 }
      if (!res.model || !res.model.startsWith(JUDGE_MODEL)) {
        appendFileSync(errorsPath, JSON.stringify({ prompt_id: c.prompt_id, rep, attempt, failure: 'served-model-mismatch', model: res.model, usage }) + '\n')
        return
      }
      writeFileSync(join(out, 'traces', `${c.prompt_id}_rep${rep}.json`), JSON.stringify([
        { role: 'user', content: prompt },
        { role: 'assistant', content: raw },
      ], null, 2))
      if (finish === 'length') {
        appendFileSync(resultsPath, JSON.stringify({
          prompt_id: c.prompt_id, rep, prompt: c.prompt, tags: c.tags, status: 'truncated', stop_reason: finish,
          model: res.model, label, usage, latency_s, attempts: attempt,
        }) + '\n')
        return
      }
      let s: number
      try {
        s = parseScore(raw)
      } catch (e) {
        if (!(e instanceof ScoreParseError)) throw e
        appendFileSync(errorsPath, JSON.stringify({ prompt_id: c.prompt_id, rep, attempt, failure: 'unparseable', raw: raw.slice(0, 300), model: res.model, usage }) + '\n')
        return
      }
      appendFileSync(resultsPath, JSON.stringify({
        prompt_id: c.prompt_id, rep, prompt: c.prompt, tags: c.tags, status: 'ok', stop_reason: finish,
        model: res.model, judge_thinking: JUDGE_THINKING ?? 'default', score: s, label, grade: grade(s, label), usage, latency_s, attempts: attempt,
      }) + '\n')
      return
    } catch (e) {
      const err = e as { status?: number; name?: string; message?: string }
      const retryable = err.name === 'AbortError' || err.status === 429 || (err.status ?? 0) >= 500 || err.status === undefined
      if (!retryable || attempt === MAX_ATTEMPTS) {
        appendFileSync(errorsPath, JSON.stringify({
          prompt_id: c.prompt_id, rep, attempt,
          failure: err.name === 'AbortError' ? 'timeout' : 'api-error', status: err.status, message: String(err.message).slice(0, 300),
        }) + '\n')
        return
      }
      await sleep(Math.min(30_000, 1000 * 2 ** attempt) * (0.5 + Math.random()))
    }
  }
}

async function main() {
  const jobs: [Case, number][] = []
  for (const c of cases) for (let r = 0; r < REPS; r++) jobs.push([c, r])
  console.log(`argument_evidence · variant=${VARIANT} · ${cases.length} cases × ${REPS} reps · judge=${FAKE ? `fake-${FAKE}` : JUDGE_MODEL} · thinking=${JUDGE_THINKING ?? 'default'}`)
  let next = 0
  const t0 = Date.now()
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < jobs.length) {
      const [c, r] = jobs[next++]
      await runOne(c, r)
    }
  }))
  const rows = existsSync(resultsPath)
    ? readJsonl<{ status: string; grade?: { mae: number; exact: number; within1: number } }>(resultsPath).filter((r) => r.status === 'ok')
    : []
  const n = rows.length
  const mean = (k: 'mae' | 'exact' | 'within1') => rows.reduce((a, r) => a + r.grade![k], 0) / Math.max(1, n)
  const sd = Math.sqrt(rows.reduce((a, r) => a + (r.grade!.mae - mean('mae')) ** 2, 0) / Math.max(1, n - 1))
  const errs = existsSync(errorsPath) ? readFileSync(errorsPath, 'utf-8').split('\n').filter(Boolean).length : 0
  console.log(`scored rows ${n} · errors ${errs} · wall ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  console.log(`MAE ${mean('mae').toFixed(3)} (±${(1.96 * sd / Math.sqrt(Math.max(1, n))).toFixed(3)} naive 95% CI, rows not independent across reps) · exact ${mean('exact').toFixed(3)} · within1 ${mean('within1').toFixed(3)}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
