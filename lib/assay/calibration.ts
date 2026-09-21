/**
 * Probability calibration: does a stated probability match the frequency it claims?
 *
 * Pure functions, no IO. The entry point is `scripts/assay-stated-confidence.ts`;
 * the design is `docs/STATED-CONFIDENCE.md`.
 *
 * ⚠ Not to be confused with `npm run calibrate*`, which fits a *detector* to
 * human labels. Different question, unrelated arithmetic, unfortunate collision
 * of the same English word — see the closing section of the design doc.
 */

/** One scored item. `p` is P(truth === true), never P(the chosen label). */
export type Point = { p: number; truth: boolean; weight: number }

export type Bin = {
  lo: number
  hi: number
  /** Raw item count. Reported so a reader can see how thin a bin is. */
  n: number
  /** Kish effective count under the weights. Drives the interval. */
  nEff: number
  weight: number
  meanP: number
  observed: number
  wilsonLo: number
  wilsonHi: number
}

export type Decomposition = {
  ece: number
  brier: number
  reliability: number
  resolution: number
  uncertainty: number
  baseRate: number
  /** brier − (reliability − resolution + uncertainty). Binning error; see `decompose`. */
  residual: number
}

/**
 * Kish effective sample size for a weighted mean: (Σw)² / Σw².
 *
 * The same quantity `decision-confidence/tools/neff.py` computes for correlated
 * sources, here doing the other job it is standard for. It matters because the
 * en labelling task is a stratified sample: a near-miss item stands for ~1.5
 * archive rows and a clear-negative for ~15, so twenty items do not buy twenty
 * items' worth of precision. Using the raw count for the interval would
 * overstate it, and overstating precision is the failure this whole file exists
 * to detect in someone else's numbers.
 */
export function kishEffectiveN(weights: number[]): number {
  const sum = weights.reduce((s, w) => s + w, 0)
  const sumSq = weights.reduce((s, w) => s + w * w, 0)
  if (sumSq === 0) return 0
  return (sum * sum) / sumSq
}

/**
 * Wilson score interval around an observed proportion.
 *
 * Takes the proportion and an effective n rather than a raw count, so a
 * weighted estimate gets an interval that matches the estimate. The normal
 * approximation breaks down exactly where calibration matters most — near
 * p = 1 with a small bin — which is why Wilson and not Wald.
 */
export function wilsonFromProportion(p: number, nEff: number, z = 1.96): [number, number] {
  if (nEff <= 0) return [0, 1]
  const d = 1 + (z * z) / nEff
  const centre = (p + (z * z) / (2 * nEff)) / d
  const half = (z * Math.sqrt((p * (1 - p)) / nEff + (z * z) / (4 * nEff * nEff))) / d
  return [Math.max(0, centre - half), Math.min(1, centre + half)]
}

/** Convenience for the unweighted case. */
export const wilson = (k: number, n: number, z = 1.96): [number, number] =>
  n === 0 ? [0, 1] : wilsonFromProportion(k / n, n, z)

/**
 * Equal-frequency bins.
 *
 * Equal-width is the more common choice and is worse here: stated probabilities
 * pile into the top decile, leaving most bins nearly empty and one bin carrying
 * the whole result. Equal-frequency gives every point comparable precision.
 *
 * ⚠ Bin count and scheme are researcher degrees of freedom. Trying several and
 * keeping the flattering one is a multiple-comparison problem — price it with
 * `selection_penalty` from the decision-confidence repo rather than pretending
 * the last scheme was the only one.
 */
export function binify(points: Point[], bins: number): Bin[] {
  const rows = [...points].sort((a, b) => a.p - b.p)
  if (!rows.length) return []
  const out: Bin[] = []
  const size = Math.ceil(rows.length / bins)
  let start = 0
  while (start < rows.length) {
    // Ties must not straddle a boundary. A naive equal-frequency cut splits
    // identical forecasts across bins, and because the sort is stable the split
    // tracks input order — which manufactures resolution out of nothing. Caught
    // by the base-rate test: a constant predictor scored resolution 0.21 when
    // the true value is 0. Decision models emit heavily tied probabilities, so
    // this is the common case here, not an edge case.
    let end = Math.min(start + size, rows.length)
    while (end < rows.length && rows[end].p === rows[end - 1].p) end++
    const slice = rows.slice(start, end)
    start = end
    const weight = slice.reduce((s, r) => s + r.weight, 0)
    const meanP = slice.reduce((s, r) => s + r.p * r.weight, 0) / weight
    const observed = slice.reduce((s, r) => s + (r.truth ? r.weight : 0), 0) / weight
    const nEff = kishEffectiveN(slice.map(r => r.weight))
    const [lo, hi] = wilsonFromProportion(observed, nEff)
    out.push({
      lo: slice[0].p,
      hi: slice[slice.length - 1].p,
      n: slice.length,
      nEff,
      weight,
      meanP,
      observed,
      wilsonLo: lo,
      wilsonHi: hi,
    })
  }
  return out
}

/**
 * Murphy decomposition:  Brier = Reliability − Resolution + Uncertainty
 *
 * This is why ECE is never reported alone here. A predictor that always emits
 * the base rate is perfectly calibrated and perfectly useless: reliability ≈ 0
 * *and* resolution ≈ 0. Reporting calibration without resolution smuggles in a
 * usefulness claim that was not measured — the construct conflation this repo
 * keeps finding, in a new place.
 *
 * ⚠ The identity is exact only when every bin holds a single distinct forecast
 * value. With a spread of p inside a bin, a within-bin variance term is left
 * over. `brier` is therefore computed from the raw points and `residual`
 * reports the gap: a large residual means the bins are too coarse to describe
 * this predictor, not that the arithmetic is wrong.
 */
export function decompose(points: Point[], bins: Bin[]): Decomposition {
  const W = points.reduce((s, r) => s + r.weight, 0)
  if (W === 0) {
    return { ece: 0, brier: 0, reliability: 0, resolution: 0, uncertainty: 0, baseRate: 0, residual: 0 }
  }
  const baseRate = points.reduce((s, r) => s + (r.truth ? r.weight : 0), 0) / W
  const brier = points.reduce((s, r) => s + r.weight * (r.p - (r.truth ? 1 : 0)) ** 2, 0) / W

  let reliability = 0
  let resolution = 0
  let ece = 0
  for (const b of bins) {
    const share = b.weight / W
    reliability += share * (b.meanP - b.observed) ** 2
    resolution += share * (b.observed - baseRate) ** 2
    ece += share * Math.abs(b.meanP - b.observed)
  }
  const uncertainty = baseRate * (1 - baseRate)
  const residual = brier - (reliability - resolution + uncertainty)
  return { ece, brier, reliability, resolution, uncertainty, baseRate, residual }
}

/**
 * Make a predictor overconfident without changing what it ranks first.
 *
 * Two wrong versions were written before this one, and both are instructive:
 *
 *   `p ** 0.5`            raises every p, which sharpens a "yes" and softens a
 *                         "no". That is a shift toward yes, not overconfidence.
 *   `max(p,1−p) ** 0.5`   fixes the asymmetry but maps 0.5 to 0.707: a coin
 *                         flip becomes 70% sure. The no-information point has
 *                         to stay put, or the transform is also injecting
 *                         signal and resolution will move.
 *
 * Temperature scaling on the logit does the job: monotone (so ranking and
 * therefore resolution survive), symmetric about 0.5, and fixes 0.5 exactly.
 * It is also the *inverse* of arm C, so the positive control and the baseline
 * being compared against are the same one-parameter family — the control
 * injects exactly the defect that arm C exists to remove.
 *
 * T < 1 sharpens (overconfident), T > 1 flattens (underconfident).
 */
export function sharpen(p: number, T = 0.5): number {
  const EPS = 1e-9
  const q = Math.min(1 - EPS, Math.max(EPS, p))
  const logit = Math.log(q / (1 - q))
  return 1 / (1 + Math.exp(-logit / T))
}

/** Deterministic PRNG (mulberry32): a control that changes verdict between runs
 *  is not a control. */
export function mulberry32(seed: number): () => number {
  let s = seed
  return () => {
    s |= 0
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Synthetic items drawn *from* their stated probability, so the predictor is
 * calibrated by construction. The negative control: a harness that flags this
 * flags everything.
 */
export function syntheticCalibrated(n: number, seed = 7): Point[] {
  const rnd = mulberry32(seed)
  const out: Point[] = []
  for (let i = 0; i < n; i++) {
    const p = 0.5 + 0.5 * rnd() // [0.5, 1.0] — the live range for a decision model
    out.push({ p, truth: rnd() < p, weight: 1 })
  }
  return out
}

export type Scored = Decomposition & { arm: string; n: number; bins: Bin[] }

export function scoreArm(arm: string, points: Point[], bins: number): Scored {
  const b = binify(points, bins)
  return { arm, n: points.length, bins: b, ...decompose(points, b) }
}

// ─── Paired comparison ───────────────────────────────────────────────────────

/**
 * One item, scored by two arms.
 *
 * `sampled` distinguishes a stratified sample from a census. The en labelling
 * task is a sample and carries sampling error; the zh task is the whole
 * population of 42 and, under a finite-population reading, carries none. Which
 * reading is taken changes the interval, so both are computed — see
 * `pairedBootstrap`.
 */
export type PairedSample = {
  stratum: string
  truth: boolean
  weight: number
  pA: number
  pB: number
  sampled: boolean
}

export type PairedDiff = {
  /**
   * `brier` is the one that works at small n.
   *
   * ECE, reliability and resolution all require binning, so their precision is
   * set by the thinnest bin rather than by the sample. Brier is a plain mean
   * over items: no bins, and under pairing the shared item difficulty cancels,
   * so its interval is far tighter at the same n. When the labelled set is in
   * the low hundreds it is the only one of the four with a realistic chance of
   * excluding zero.
   *
   * The price is that Brier mixes calibration with discrimination. It is
   * interpretable as a calibration comparison only when Δresolution is itself
   * consistent with zero — which is reported alongside, and is exactly why all
   * four travel together.
   */
  metric: 'brier' | 'ece' | 'reliability' | 'resolution'
  /** Observed A − B on the full data. Not the bootstrap mean. */
  point: number
  lo: number
  hi: number
  /** An interval containing zero is not evidence of equality; it is absence of evidence. */
  crossesZero: boolean
}

export type PairedResult = {
  a: string
  b: string
  n: number
  diffs: PairedDiff[]
  /** Percentile used per tail, after any multiplicity adjustment. */
  tail: number
}

function metricsOf(points: Point[], bins: number) {
  const d = decompose(points, binify(points, bins))
  return { brier: d.brier, ece: d.ece, reliability: d.reliability, resolution: d.resolution }
}

/**
 * Paired bootstrap on the difference between two arms.
 *
 * Three decisions, each of which changes the answer:
 *
 * **Resample items, not bins, and resample them once for both arms.** Scoring
 * the arms on independently drawn samples throws away the pairing, which is the
 * entire reason this comparison is affordable at n in the hundreds: both arms
 * face the same hard items, so the shared difficulty cancels in the difference.
 *
 * **Resample within strata.** The bootstrap has to reproduce the sampling
 * design it is standing in for. The en task drew fixed counts from three
 * strata; pooling them and drawing n at random would let a replicate contain
 * eleven near-misses, which the real design could never produce, and the
 * interval would be wrong in a direction that depends on the strata.
 *
 * **The census is a choice, not a fact.** Under `census: 'fix'` the zh rows are
 * held constant — they are the population, there is no sampling error, and this
 * matches how `assay-detector-score.ts` already reports zh recall as exact.
 * Under `census: 'resample'` they are treated as one draw from the replies the
 * model could have produced, which is the question worth asking if the claim is
 * about the model rather than about these 42 rows. Run both: agreement makes
 * the conclusion robust, disagreement is itself the finding.
 *
 * ⚠ Percentile intervals, not BCa. They are slightly biased for skewed
 * statistics, and ECE is bounded below by zero so it is skewed near zero. Read
 * a near-zero lower bound as "consistent with no difference", never as a
 * measurement of how small the difference is.
 */
export function pairedBootstrap(
  samples: PairedSample[],
  opts: {
    bins: number
    B?: number
    alpha?: number
    seed?: number
    /** Number of planned comparisons. Widens the interval by Bonferroni. */
    comparisons?: number
    census?: 'fix' | 'resample'
  },
): PairedResult {
  const { bins, B = 2000, alpha = 0.05, seed = 1, comparisons = 1, census = 'resample' } = opts
  const n = samples.length
  const metrics: PairedDiff['metric'][] = ['brier', 'ece', 'reliability', 'resolution']

  const observed = (() => {
    const A = metricsOf(samples.map(s => ({ p: s.pA, truth: s.truth, weight: s.weight })), bins)
    const Bm = metricsOf(samples.map(s => ({ p: s.pB, truth: s.truth, weight: s.weight })), bins)
    return {
      brier: A.brier - Bm.brier, ece: A.ece - Bm.ece,
      reliability: A.reliability - Bm.reliability, resolution: A.resolution - Bm.resolution,
    }
  })()

  // Group once; the inner loop runs B times.
  const groups = new Map<string, number[]>()
  samples.forEach((s, i) => {
    const key = `${s.stratum}:${s.sampled ? 'S' : 'C'}`
    const g = groups.get(key)
    if (g) g.push(i); else groups.set(key, [i])
  })

  const rnd = mulberry32(seed)
  const draws: Record<PairedDiff['metric'], number[]> = { brier: [], ece: [], reliability: [], resolution: [] }

  for (let b = 0; b < B; b++) {
    const idx: number[] = []
    for (const [key, members] of groups) {
      const isCensus = key.endsWith(':C')
      if (isCensus && census === 'fix') { idx.push(...members); continue }
      for (let i = 0; i < members.length; i++) idx.push(members[Math.floor(rnd() * members.length)])
    }
    const A = metricsOf(idx.map(i => ({ p: samples[i].pA, truth: samples[i].truth, weight: samples[i].weight })), bins)
    const Bm = metricsOf(idx.map(i => ({ p: samples[i].pB, truth: samples[i].truth, weight: samples[i].weight })), bins)
    draws.brier.push(A.brier - Bm.brier)
    draws.ece.push(A.ece - Bm.ece)
    draws.reliability.push(A.reliability - Bm.reliability)
    draws.resolution.push(A.resolution - Bm.resolution)
  }

  // Bonferroni on the planned comparison count. Applied to the percentile
  // directly, which avoids needing a normal quantile at all — and the count
  // must be the number of comparisons *planned*, not the number that looked
  // interesting afterwards.
  const adjusted = alpha / Math.max(1, comparisons)
  const tail = adjusted / 2

  const diffs = metrics.map<PairedDiff>(m => {
    const sorted = [...draws[m]].sort((x, y) => x - y)
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))]
    const lo = at(tail)
    const hi = at(1 - tail)
    return { metric: m, point: observed[m], lo, hi, crossesZero: lo <= 0 && hi >= 0 }
  })

  return { a: 'A', b: 'B', n, diffs, tail }
}
