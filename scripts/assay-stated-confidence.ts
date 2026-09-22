#!/usr/bin/env tsx
/**
 * Stated confidence — does a probability mean what its label says?
 *
 *   npm run stated
 *
 * Design and pre-registration: `docs/STATED-CONFIDENCE.md`.
 * Power — run this first: `python scripts/stated_power.py`.
 * The arithmetic lives in `lib/assay/calibration.ts` and is unit-tested there;
 * this file is IO, arms, and the exit code.
 *
 * ─── Not the other calibration ──────────────────────────────────────────────
 *
 * `npm run calibrate*` fits a *detector* to human labels. This measures a
 * *probability*: among the decisions a system stamps 0.90, are about 90%
 * correct? Same word, unrelated arithmetic. That collision is why this entry
 * point is `stated` and not `calibrate`, and it is itself a finding — see the
 * closing section of the design doc.
 *
 * ─── The one rule that decides whether this is worth running ────────────────
 *
 * Ground truth is the HUMAN label in `label-task*.md`. It is never the
 * detector's answer in `label-key*.json`, even though that field is sitting
 * right there and is free.
 *
 * Not fussiness. The vendor under test scores models against "the predictions
 * of the largest, smartest, and most expensive external models as reference
 * probabilities", so their eval cannot separate "less accurate" from "less like
 * GPT". Substituting a regex for a human here reproduces that error one level
 * down: it would measure how closely an arm imitates `lib/assay/mentions.ts`.
 *
 * ─── Layers, and why this still has a job with zero arms wired ──────────────
 *
 *   0  controls      offline, no key    synthetic predictors, known verdicts
 *   1  arms          needs credentials  real predictors on frozen items
 *   2  comparison    offline            paired differences between arms
 *
 * Layer 0 runs always. If it fails, nothing from layer 1 may be quoted, because
 * the statistics are then the thing that failed. Same posture as
 * `npm run sensitivity`, for the same reason.
 *
 * Exit codes: 0 pass · 1 a control failed · 2 a control could not run.
 * A control that did not run is not a control that passed.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  pairedBootstrap, scoreArm, sharpen, syntheticCalibrated,
  type PairedResult, type PairedSample, type Point, type Scored,
} from '../lib/assay/calibration'

const OUT = 'fixtures/calibration'

/**
 * Bin count, declared before any data exists.
 *
 * ⚠ If this changes after a run, it is a second trial and must be counted as
 * one — `selection_penalty(k, t_base)` in the decision-confidence repo prices
 * exactly this. Silently retuning it is the researcher-degrees-of-freedom
 * version of the benchmaxxing the vendor's own essay complains about.
 */
const BIN_COUNT = 10

/**
 * One judgment per query.
 *
 * Batching fields into one call is the efficient path and is how the product is
 * meant to be used, but those answers share a single prefilled KV-cache: they
 * are not independent trials and n over-counts. A batched mode must discount
 * the effective n (Kish — `kishEffectiveN` is already in the lib) before
 * anything is aggregated, and print the discount.
 */
const ONE_PER_QUERY = true

// ─── Items ───────────────────────────────────────────────────────────────────

type Item = Point & {
  id: string
  input: string
  locale: 'en' | 'zh'
  stratum: string
}

type Arm = {
  name: string
  note: string
  /** Null when the arm cannot run (no key, no access). Null is skipped, not failed. */
  run: (items: Item[]) => Promise<Map<string, number> | null>
}

type KeyRow = { id: number; stratum: 'A' | 'B' | 'P' | 'C'; cue: string; locale: string; detector: boolean }

/** `## <id>` … `label: <value>` — same reader as assay-detector-score.ts.
 *  Split on \r?\n: a CRLF save otherwise leaves every line unmatched and the
 *  task reads as unlabelled, silently, as a zero. */
function readLabels(file: string): Map<number, string> {
  const labels = new Map<number, string>()
  if (!existsSync(join(OUT, file))) return labels
  let current: number | null = null
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

/**
 * Items whose truth is the human label.
 *
 * `?` is dropped. It is a finding about the rubric, not a ground truth, and
 * folding it either way would invent one.
 *
 * `weight` is the inverse sampling fraction. The en task is a stratified sample
 * that deliberately over-samples near-misses, so an unweighted aggregate would
 * describe the sample rather than the archive. zh is a census and weighs 1.
 * Per-bin frequencies survive stratification — calibration is conditional on
 * the stated probability — but ECE and Brier average across bins and do not.
 *
 * TODO: `input` is empty until reply text is threaded through from the
 * calibration run. Layer 1 cannot call an arm without it.
 */
function loadItems(): Item[] {
  if (!existsSync(join(OUT, 'strata.json'))) return []
  const strata = JSON.parse(readFileSync(join(OUT, 'strata.json'), 'utf8'))
  const items: Item[] = []

  const add = (keyFile: string, taskFile: string, locale: 'en' | 'zh') => {
    if (!existsSync(join(OUT, keyFile))) return
    const key = JSON.parse(readFileSync(join(OUT, keyFile), 'utf8')) as KeyRow[]
    const labels = readLabels(taskFile)
    const usable = key.filter(k => { const v = labels.get(k.id); return v && v !== '?' })

    // Weight from what was actually LABELLED, not from strata.json's planned
    // `sampled` counts. The task is meant to be worked through in batches, so
    // partway through a pass the two differ — and using the plan would inflate
    // every weight by the unlabelled remainder, silently, in the direction that
    // makes the archive estimate look better sourced than it is.
    const labelledPerStratum = new Map<string, number>()
    for (const k of usable) labelledPerStratum.set(k.stratum, (labelledPerStratum.get(k.stratum) ?? 0) + 1)

    for (const k of usable) {
      const v = labels.get(k.id)!
      let weight = 1
      if (locale === 'en') {
        const archive: Record<string, number> = {
          A: strata.en.nearMiss, B: strata.en.clear, P: strata.en.positives,
        }
        const taken = labelledPerStratum.get(k.stratum)
        if (taken && archive[k.stratum]) weight = archive[k.stratum] / taken
      }
      items.push({
        id: `${locale}:${k.id}`, input: '', truth: v === 'yes',
        p: NaN, locale, stratum: k.stratum, weight,
      })
    }
  }

  add('label-key.json', 'label-task.md', 'en')
  add('label-key-zh.json', 'label-task-zh.md', 'zh')
  return items
}

// ─── Layer 0: controls ───────────────────────────────────────────────────────

const failures: string[] = []
const skipped: string[] = []

/**
 * Two controls, and the second is the one people forget.
 *
 *   positive — a known-miscalibrated predictor must be flagged
 *   negative — a known-calibrated predictor must NOT be flagged
 *
 * A harness that fires on everything passes the positive control and is
 * useless. Thresholds are stated here rather than tuned afterwards.
 */
function layer0(): void {
  console.log('── layer 0 · controls (offline)\n')
  const pts = syntheticCalibrated(4000)
  const good = scoreArm('control:calibrated', pts, BIN_COUNT)
  const bad = scoreArm('control:overconfident', pts.map(p => ({ ...p, p: sharpen(p.p) })), BIN_COUNT)

  const CLEAN_MAX = 0.02
  const DIRTY_MIN = 0.04
  const DRIFT_MAX = 0.01

  console.log(`  calibrated     ECE ${good.ece.toFixed(4)}   must be < ${CLEAN_MAX}`)
  console.log(`  overconfident  ECE ${bad.ece.toFixed(4)}   must be > ${DIRTY_MIN}`)

  if (!(good.ece < CLEAN_MAX)) {
    failures.push(`negative control: a calibrated predictor scored ECE ${good.ece.toFixed(4)} — the harness flags everything`)
  }
  if (!(bad.ece > DIRTY_MIN)) {
    failures.push(`positive control: a known-overconfident predictor scored ECE ${bad.ece.toFixed(4)} — the harness is blind to it`)
  }

  // sharpen() is a monotone logit rescale, so it changes calibration and not
  // ranking. If resolution moves, the decomposition is wrong.
  const drift = Math.abs(good.resolution - bad.resolution)
  console.log(`  resolution drift ${drift.toFixed(4)}   must be < ${DRIFT_MAX}  (the transform preserves ranking)`)
  if (!(drift < DRIFT_MAX)) {
    failures.push(`decomposition: resolution moved ${drift.toFixed(4)} under a rank-preserving transform`)
  }
  console.log()
}

// ─── Layer 1: arms ───────────────────────────────────────────────────────────

/**
 * Five arms. Which ones exist decides what the run may claim; the
 * pre-registration table in docs/STATED-CONFIDENCE.md fixes each reading.
 *
 * C carries the result: if one fitted scalar matches RLCD, a new RL objective
 * is not what the finding needs. Note that C's temperature is the same
 * one-parameter family as the positive control's `sharpen`, in the opposite
 * direction — the control injects precisely the defect C exists to remove.
 *
 * D vs E is the comparison the vendor did not make. Their table dismisses
 * *verbalised* confidence, the weakest baseline available; E is the one that
 * matters.
 */
/**
 * Synthetic mode: `ASSAY_STATED_DEMO=1 npm run stated`.
 *
 * Exists because layers 1 and 2 are otherwise unreachable until an arm is
 * wired, and shipping reporting code that has never executed is how a harness
 * arrives already broken. It also doubles as the worked example of what this
 * run produces — the three planned comparisons are rigged to land on three
 * different pre-registered readings.
 *
 * Every number it prints is invented. The banner says so on every run.
 */
const DEMO = process.env.ASSAY_STATED_DEMO === '1'

/** Items shaped like the real design: three en strata plus a zh census. */
function demoItems(): Item[] {
  const rnd = mulberryLite(99)
  const spec: Array<[string, 'en' | 'zh', number, number]> = [
    ['A', 'en', 45, 66 / 45],   // near-miss, over-sampled
    ['B', 'en', 15, 228 / 15],  // clear negatives, under-sampled
    ['P', 'en', 12, 85 / 12],   // detector positives
    ['C', 'zh', 42, 1],         // census
  ]
  const out: Item[] = []
  for (const [stratum, locale, n, weight] of spec) {
    for (let i = 0; i < n; i++) {
      const p = 0.5 + 0.5 * rnd()
      out.push({
        id: `${locale}:${stratum}:${i}`, input: '', truth: rnd() < p,
        p, locale, stratum, weight,
      })
    }
  }
  return out
}

/** A tiny local PRNG so demo item generation does not disturb the control seed. */
function mulberryLite(seed: number): () => number {
  let s = seed
  return () => {
    s |= 0; s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** In demo mode each arm is `truth`-generating probability pushed through a
 *  known temperature, so the right answer is known before the run. */
const demoArm = (T: number) => async (items: Item[]) =>
  new Map(items.map(i => [i.id, T === 1 ? i.p : sharpen(i.p, T)]))

const ARMS: Arm[] = [
  {
    name: 'A jev',
    note: 'Noul — the returned `noul`, not `confidence`',
    // POST https://api.typesafe.ai/v1/systemone, model PINNED to jev-1.13.0 and
    // never the `jev-latest` alias: an alias that moves mid-run turns a version
    // change into an apparent property of the model.
    //
    // ToS cleared 2026-09-20 (design doc, gate 1): no benchmarking or
    // publication prohibition exists. Output must not feed a competing product,
    // and nothing published may imply a vendor relationship.
    //
    // Reads `answers[id].noul`. Do NOT read `confidence` — FINDINGS #17: Noul
    // returns none, and on a two-option Choice it is exactly 2p-1, so scoring it
    // would be this same arm measured twice under another name.
    run: DEMO ? demoArm(1.0) : async () => null,
  },
  {
    name: "A' jev choice",
    note: 'two-option Choice — probabilities["yes"]',
    // FINDINGS #18: this agreed with arm A on 0/29 items while the decision the
    // two imply agreed 29/29, and the per-item sign of the gap reproduced across
    // rounds. So it is not noise and no rescaling reconciles them: at most one of
    // the vendor's two question types can be calibrated on this task.
    //
    // Send both questions in ONE request. The state is billed once and the model
    // evaluates them in parallel, so the second arm is nearly free — and, more
    // importantly, both then see byte-identical state.
    run: DEMO ? demoArm(0.92) : async () => null,
  },
  {
    name: 'B parallel-constrained',
    note: 'small open model, softmax over the candidate slice, no RLCD',
    // TODO: logit slicing over a constrained vocabulary. Note that a softmax
    // over candidates is *normalisation*, not calibration — that conflation is
    // the third sense of the word catalogued in the design doc.
    run: DEMO ? demoArm(0.6) : async () => null,
  },
  {
    name: 'C temperature-scaled',
    note: 'arm B plus one scalar T fitted on a held-out split',
    // TODO: fit T by NLL on the fit split. Never on the eval split — that is
    // the same leak this repo audits elsewhere.
    run: DEMO ? demoArm(0.97) : async () => null,
  },
  {
    name: 'D verbalised',
    note: 'frontier model asked for a number in words',
    // TODO: MUST parse through lib/assay/parse.ts. FINDINGS #4: a bare
    // parseFloat on " 0 </think> 0.7" returned 0 and would have published a
    // ~98-point effect that does not exist. Reasoning traces leak into this
    // arm by construction, so it is the one most exposed to that bug.
    run: DEMO ? demoArm(0.45) : async () => null,
  },
  {
    name: 'E logprob',
    note: 'frontier model, probability from constrained-decoding logprobs',
    run: DEMO ? demoArm(0.88) : async () => null, // TODO: needs a provider that returns logprobs
  },
]

/**
 * The comparisons, fixed in advance.
 *
 * Six arms admit fifteen pairs. Running all fifteen and reporting the
 * interesting one is the multiple-comparison problem in its purest form, and the
 * vendor's own anti-benchmaxxing essay names the mechanism exactly: try enough
 * experimental settings and the benchmark ends up selecting the model, "even if
 * nobody intended to game it".
 *
 * Declaring four is cheaper than correcting for fifteen. The count is passed to
 * the bootstrap as `comparisons`, so adding a fifth here automatically widens
 * every interval — which is the correct price and should be felt.
 *
 * The fourth was added on 2026-09-20, after the instrument work and before any
 * outcome existed. It widened the other three. A comparison admitted before the
 * data is cheap; the same one admitted after is the thing this list prevents.
 */
const PLANNED_COMPARISONS: Array<[string, string, string]> = [
  ['A jev', 'C temperature-scaled', 'does RLCD beat one fitted scalar?  ← the result'],
  ['A jev', 'B parallel-constrained', 'RLCD over the same architecture without it'],
  ['D verbalised', 'E logprob', 'the comparison the vendor did not make'],
  ['A jev', "A' jev choice", "which of the vendor's own two question types is calibrated"],
]

// ─── Reporting ───────────────────────────────────────────────────────────────

function printDiagram(s: Scored): void {
  console.log(`\n  ${s.arm}   n=${s.n}   base rate ${s.baseRate.toFixed(3)}`)
  console.log(
    `  ${'range'.padEnd(15)} ${'n'.padStart(4)} ${'nEff'.padStart(6)}  ` +
    `${'stated'.padStart(7)}  ${'actual'.padStart(7)}   95% interval        gap`,
  )
  for (const b of s.bins) {
    const gap = b.meanP - b.observed
    // The stated value falling outside its own bin's interval is the readable
    // version of "this bin is miscalibrated". Comparing observed to the
    // interval would be circular: the interval is built around observed.
    const flag = b.meanP < b.wilsonLo || b.meanP > b.wilsonHi ? '  ✗' : ''
    console.log(
      `  [${b.lo.toFixed(3)},${b.hi.toFixed(3)}] ${String(b.n).padStart(4)} ${b.nEff.toFixed(1).padStart(6)}  ` +
      `${b.meanP.toFixed(3).padStart(7)}  ${b.observed.toFixed(3).padStart(7)}   ` +
      `[${b.wilsonLo.toFixed(3)}, ${b.wilsonHi.toFixed(3)}]  ${gap >= 0 ? '+' : ''}${gap.toFixed(3)}${flag}`,
    )
  }
  console.log(`\n  ECE ${s.ece.toFixed(4)}  (${BIN_COUNT} equal-frequency bins, ties kept together)`)
  console.log(
    `  Brier ${s.brier.toFixed(4)} = reliability ${s.reliability.toFixed(4)}` +
    ` − resolution ${s.resolution.toFixed(4)} + uncertainty ${s.uncertainty.toFixed(4)}` +
    `   [residual ${s.residual.toFixed(4)}]`,
  )
  if (Math.abs(s.residual) > 0.02) {
    console.log(`  ⚠ large residual — the bins are too coarse to describe this predictor.`)
  }
  if (s.resolution < 0.01) {
    console.log(
      `  ⚠ resolution ≈ 0 — this predictor barely separates the classes. A low ECE here` +
      `\n    means "always near the base rate", not "trustworthy".`,
    )
  }
  console.log(`  ✗ marks a bin whose stated value falls outside its own interval.`)
}

function printPaired(a: string, b: string, why: string, runs: Array<[string, PairedResult]>): void {
  const [, first] = runs[0]
  console.log(`\n  ${a}  vs  ${b}`)
  console.log(`  ${why}`)
  console.log(`  n=${first.n}   ${(100 * (1 - 2 * first.tail)).toFixed(2)}% interval per comparison` +
    ` (Bonferroni over ${PLANNED_COMPARISONS.length} planned)`)

  for (const [reading, r] of runs) {
    console.log(`\n    ── ${reading}`)
    for (const d of r.diffs) {
      const mark = d.crossesZero ? '   crosses zero' : '   ✓ excludes zero'
      console.log(
        `    Δ${d.metric.padEnd(12)} ${d.point >= 0 ? '+' : ''}${d.point.toFixed(4)}` +
        `  [${d.lo >= 0 ? '+' : ''}${d.lo.toFixed(4)}, ${d.hi >= 0 ? '+' : ''}${d.hi.toFixed(4)}]${mark}`,
      )
    }
    const res = r.diffs.find(d => d.metric === 'resolution')!
    if (!res.crossesZero) {
      console.log(
        `    ⚠ resolution differs between these arms. "Better calibrated" and "better at` +
        `\n      separating the classes" are confounded here — this pair is not a clean` +
        `\n      calibration comparison, and the ΔECE above should not be read as one.`,
      )
    }
  }

  // The two readings answer different questions; disagreement is a finding,
  // not an error to be averaged away.
  const [, fix] = runs.find(([k]) => k.startsWith('finite')) ?? runs[0]
  const [, sup] = runs.find(([k]) => k.startsWith('super')) ?? runs[0]
  const e1 = fix.diffs.find(d => d.metric === 'ece')!
  const e2 = sup.diffs.find(d => d.metric === 'ece')!
  if (e1.crossesZero !== e2.crossesZero) {
    console.log(
      `\n    ⚠ the two readings disagree on ΔECE. The verdict depends on whether the zh` +
      `\n      census is treated as a population or as one draw from the model's behaviour.` +
      `\n      Report both; do not pick the one that excludes zero.`,
    )
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═'.repeat(78))
  console.log('assay stated-confidence — does a probability mean what its label says?')
  console.log('═'.repeat(78) + '\n')

  if (DEMO) {
    console.log('⚠  SYNTHETIC MODE — every arm below is a generated predictor with a known')
    console.log('⚠  temperature. No model was called. These numbers describe nothing real;')
    console.log('⚠  they exist so the reporting path executes before an arm is wired.\n')
  }

  layer0()

  const items = DEMO ? demoItems() : loadItems()
  console.log('── layer 1 · arms\n')
  console.log(
    `  ground truth: ${items.length} human-labelled items` +
    (items.length
      ? ` (${items.filter(i => i.locale === 'en').length} en, ${items.filter(i => i.locale === 'zh').length} zh)`
      : ''),
  )

  if (!items.length) {
    skipped.push('no human labels yet — finish label-task.md / label-task-zh.md, then re-run')
  } else {
    // The power gate, printed as a number rather than a feeling. Tables:
    // python scripts/stated_power.py
    const top = Math.ceil(items.length / BIN_COUNT)
    const floor = top >= 500 ? '2.6' : top >= 200 ? '4.3' : top >= 100 ? '6.2' : '9.2'
    console.log(`  top bin will hold ≈ ${top} items → at a stated 0.95 this run can only see`)
    console.log(`  overconfidence of about ${floor} points or more.`)
    console.log(`  ⚠ a null result therefore means "nothing larger than that was visible".`)
    console.log(`    It never means "calibrated". Print n and the floor beside any null.\n`)
  }

  const scored: Scored[] = []
  const predsByArm = new Map<string, Map<string, number>>()
  for (const arm of ARMS) {
    const preds = items.length ? await arm.run(items) : null
    if (!preds) { skipped.push(`arm ${arm.name} — ${arm.note}`); continue }
    if (!ONE_PER_QUERY) console.log(`  ⚠ ${arm.name} ran batched; n is inflated by shared context`)
    predsByArm.set(arm.name, preds)
    const points: Point[] = items
      .filter(i => preds.has(i.id))
      .map(i => ({ p: preds.get(i.id)!, truth: i.truth, weight: i.weight }))
    scored.push(scoreArm(arm.name, points, BIN_COUNT))
  }
  scored.forEach(printDiagram)

  // ── layer 2: paired comparison ─────────────────────────────────────────────
  //
  // Differences with an interval, not two marginal intervals side by side:
  // overlapping marginal intervals do not mean the difference is
  // insignificant, and the pairing is the whole reason this is affordable at n
  // in the hundreds — both arms face the same hard items, so shared difficulty
  // cancels in the difference.
  if (predsByArm.size >= 2) {
    console.log('\n── layer 2 · paired differences')
    let ran = 0
    for (const [a, b, why] of PLANNED_COMPARISONS) {
      const pa = predsByArm.get(a)
      const pb = predsByArm.get(b)
      if (!pa || !pb) { skipped.push(`comparison ${a} vs ${b} — one arm is missing`); continue }

      const samples: PairedSample[] = items
        .filter(i => pa.has(i.id) && pb.has(i.id))
        .map(i => ({
          // Strata are per-locale: en:A, en:B, en:P are the sampling design,
          // zh:C is the census. Pooling them would let a replicate contain a
          // stratum mix the real design could never produce.
          stratum: `${i.locale}:${i.stratum}`,
          truth: i.truth,
          weight: i.weight,
          pA: pa.get(i.id)!,
          pB: pb.get(i.id)!,
          sampled: i.locale === 'en',
        }))
      if (!samples.length) { skipped.push(`comparison ${a} vs ${b} — no overlapping items`); continue }

      const opts = { bins: BIN_COUNT, B: 2000, seed: 1, comparisons: PLANNED_COMPARISONS.length }
      printPaired(a, b, why, [
        ['finite population (zh census held fixed — matches assay-detector-score.ts)',
          pairedBootstrap(samples, { ...opts, census: 'fix' })],
        ['super-population (zh treated as one draw from the model\'s behaviour)',
          pairedBootstrap(samples, { ...opts, census: 'resample' })],
      ])
      ran++
    }
    if (!ran) console.log('\n  no planned comparison had both arms available')
  }

  console.log('\n' + '═'.repeat(78))
  if (failures.length) {
    console.log(`FAIL — ${failures.length} control${failures.length > 1 ? 's' : ''} did not hold:\n`)
    failures.forEach(f => console.log(`  · ${f}`))
    console.log('\nThe statistics are what failed, so no arm number from this run describes an arm.')
    console.log('═'.repeat(78))
    process.exit(1)
  }
  if (skipped.length) {
    console.log('INCOMPLETE — every control that ran held, but some did not run:\n')
    skipped.forEach(s => console.log(`  · ${s}`))
    console.log('\nA control that did not run is not a control that passed.')
    console.log('═'.repeat(78))
    process.exit(2)
  }
  console.log('PASS')
  console.log('═'.repeat(78))
}

main().catch(err => { console.error(err); process.exit(1) })
