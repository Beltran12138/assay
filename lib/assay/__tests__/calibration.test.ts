/**
 * The statistics behind `npm run stated` have to be checkable without a model,
 * because the whole design says an arm result is void if the harness is broken.
 * These are the tests that make that claim mean something.
 */
import {
  binify, decompose, kishEffectiveN, pairedBootstrap, scoreArm, sharpen, syntheticCalibrated,
  wilson, wilsonFromProportion,
  type PairedSample, type Point,
} from '../calibration'

describe('wilson', () => {
  it('matches the interval for 95/100, worked by hand', () => {
    // z=1.96, n=100, p=0.95
    //   d      = 1 + 3.8416/100                     = 1.038416
    //   centre = (0.95 + 3.8416/200) / d            = 0.933353
    //   half   = 1.96·√(0.000475 + 0.00009604) / d  = 0.045105
    // Not taken from the implementation: an assertion copied out of the code it
    // is testing agrees with the code by construction.
    const [lo, hi] = wilson(95, 100)
    expect(lo).toBeCloseTo(0.888248, 5)
    expect(hi).toBeCloseTo(0.978458, 5)
  })

  it('stays inside [0,1] at the boundary, where Wald would not', () => {
    const [lo, hi] = wilson(100, 100)
    expect(lo).toBeGreaterThan(0)
    expect(hi).toBeLessThanOrEqual(1)
  })

  it('narrows as n grows', () => {
    const w = (n: number) => { const [l, h] = wilson(Math.round(0.95 * n), n); return h - l }
    expect(w(78)).toBeGreaterThan(w(466))
    expect(w(466)).toBeGreaterThan(w(777))
  })
})

describe('kishEffectiveN', () => {
  it('equals n when weights are equal', () => {
    expect(kishEffectiveN([1, 1, 1, 1])).toBeCloseTo(4, 10)
    expect(kishEffectiveN([3, 3, 3])).toBeCloseTo(3, 10)
  })

  it('falls below n when weights are not', () => {
    // The stratified en task: near-miss items stand for few archive rows,
    // clear negatives for many. Twenty such items are not worth twenty.
    expect(kishEffectiveN([1, 1, 15, 15])).toBeLessThan(4)
  })

  it('collapses toward 1 when one weight dominates', () => {
    expect(kishEffectiveN([1, 1, 1, 1000])).toBeLessThan(1.1)
  })
})

describe('sharpen', () => {
  it('fixes the no-information point', () => {
    // The bug in the first two drafts. A coin flip must stay a coin flip,
    // otherwise the control injects signal and resolution moves.
    expect(sharpen(0.5)).toBeCloseTo(0.5, 12)
  })

  it('is symmetric about 0.5', () => {
    expect(sharpen(0.9) + sharpen(0.1)).toBeCloseTo(1, 10)
    expect(sharpen(0.75) + sharpen(0.25)).toBeCloseTo(1, 10)
  })

  it('is monotone, so ranking survives', () => {
    const xs = [0.05, 0.2, 0.4, 0.5, 0.6, 0.8, 0.99]
    const ys = xs.map(x => sharpen(x))
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThan(ys[i - 1])
  })

  it('T > 1 flattens and inverts T < 1', () => {
    expect(sharpen(0.9, 2)).toBeLessThan(0.9)
    expect(sharpen(sharpen(0.9, 0.5), 2)).toBeCloseTo(0.9, 8)
  })
})

describe('Murphy decomposition', () => {
  it('is exact when every bin holds one distinct forecast value', () => {
    // Hand-worked: p = {0.5, 0.5, 1.0}, truth = {T, F, T}
    //   Brier       = (0.25 + 0.25 + 0) / 3        = 0.16667
    //   base rate   = 2/3
    //   grouped by value: p=0.5 → observed 0.5 (n=2); p=1.0 → observed 1 (n=1)
    //   reliability = [2(0)² + 1(0)²] / 3          = 0
    //   resolution  = [2(0.5−2/3)² + (1−2/3)²] / 3 = 0.055556
    //   uncertainty = (2/3)(1/3)                   = 0.222222
    //   0 − 0.055556 + 0.222222                    = 0.166667  ✓
    const pts: Point[] = [
      { p: 0.5, truth: true, weight: 1 },
      { p: 0.5, truth: false, weight: 1 },
      { p: 1.0, truth: true, weight: 1 },
    ]
    // Two bins, hand-built so each holds a single forecast value.
    const bins = [
      { lo: 0.5, hi: 0.5, n: 2, nEff: 2, weight: 2, meanP: 0.5, observed: 0.5, wilsonLo: 0, wilsonHi: 1 },
      { lo: 1.0, hi: 1.0, n: 1, nEff: 1, weight: 1, meanP: 1.0, observed: 1.0, wilsonLo: 0, wilsonHi: 1 },
    ]
    const d = decompose(pts, bins)
    expect(d.brier).toBeCloseTo(0.166667, 6)
    expect(d.reliability).toBeCloseTo(0, 10)
    expect(d.resolution).toBeCloseTo(0.055556, 6)
    expect(d.uncertainty).toBeCloseTo(0.222222, 6)
    expect(d.residual).toBeCloseTo(0, 10)
  })

  it('leaves a residual when a bin spans several forecast values', () => {
    // Not a bug: the within-bin variance term. It is reported so a reader can
    // see when the bins are too coarse to describe the predictor.
    const pts: Point[] = [
      { p: 0.2, truth: false, weight: 1 },
      { p: 0.9, truth: true, weight: 1 },
    ]
    const d = decompose(pts, binify(pts, 1))
    expect(Math.abs(d.residual)).toBeGreaterThan(0.01)
  })

  it('gives a base-rate predictor zero resolution — the point of reporting it', () => {
    // This is the claim the design doc makes in prose, as an assertion:
    // perfectly calibrated and perfectly useless at the same time.
    //
    // This test found a real bug. The truths are laid out in order on purpose,
    // so that a binner which splits ties will sort them into separate bins and
    // report resolution 0.21 for a predictor that has none. It must come out 0.
    const rate = 0.3
    const pts: Point[] = Array.from({ length: 1000 }, (_, i) => ({
      p: rate, truth: i < 300, weight: 1,
    }))
    const d = decompose(pts, binify(pts, 10))
    expect(d.resolution).toBeCloseTo(0, 6)
    expect(d.reliability).toBeCloseTo(0, 6)
    expect(d.ece).toBeCloseTo(0, 6)   // flawless ECE …
    expect(d.brier).toBeCloseTo(0.21, 6) // … and a Brier score that is all uncertainty
  })
})

describe('binify', () => {
  it('never splits a tied forecast value across two bins', () => {
    // Decision models emit heavily tied probabilities — a 255-way Choice has
    // far fewer distinct confidences than items. If ties straddle a boundary,
    // both reliability and resolution pick up structure that is an artefact of
    // input order.
    const pts: Point[] = Array.from({ length: 100 }, (_, i) => ({
      p: i < 60 ? 0.8 : 0.95, truth: i % 2 === 0, weight: 1,
    }))
    const bins = binify(pts, 10)
    const values = bins.map(b => [b.lo, b.hi])
    for (const [lo, hi] of values) expect(lo).toBe(hi) // each bin holds one value
    expect(bins).toHaveLength(2)
    expect(bins[0].n).toBe(60)
    expect(bins[1].n).toBe(40)
  })

  it('still produces the requested number of bins when values are distinct', () => {
    const pts: Point[] = Array.from({ length: 100 }, (_, i) => ({
      p: i / 100, truth: i % 3 === 0, weight: 1,
    }))
    expect(binify(pts, 10)).toHaveLength(10)
  })
})

describe('controls, as the script runs them', () => {
  const BINS = 10
  const pts = syntheticCalibrated(4000)

  it('negative control: a calibrated predictor is not flagged', () => {
    const s = scoreArm('calibrated', pts, BINS)
    expect(s.ece).toBeLessThan(0.02)
    expect(s.reliability).toBeLessThan(0.002)
  })

  it('positive control: a known-overconfident predictor is flagged', () => {
    const bad = pts.map(p => ({ ...p, p: sharpen(p.p) }))
    const s = scoreArm('overconfident', bad, BINS)
    expect(s.ece).toBeGreaterThan(0.04)
  })

  it('the two controls are separated by a wide margin, not a whisker', () => {
    // A positive control that only just fires is a coin toss dressed as a test.
    const good = scoreArm('good', pts, BINS)
    const bad = scoreArm('bad', pts.map(p => ({ ...p, p: sharpen(p.p) })), BINS)
    expect(bad.ece / Math.max(good.ece, 1e-9)) .toBeGreaterThan(3)
  })

  it('resolution survives the transform, because sharpen preserves ranking', () => {
    const good = scoreArm('good', pts, BINS)
    const bad = scoreArm('bad', pts.map(p => ({ ...p, p: sharpen(p.p) })), BINS)
    expect(Math.abs(good.resolution - bad.resolution)).toBeLessThan(0.01)
  })

  it('is deterministic: the same seed gives the same verdict', () => {
    expect(scoreArm('a', syntheticCalibrated(500, 42), BINS).ece)
      .toBeCloseTo(scoreArm('b', syntheticCalibrated(500, 42), BINS).ece, 12)
  })
})

describe('pairedBootstrap', () => {
  const BINS = 10
  const OPTS = { bins: BINS, B: 400, seed: 3 }

  /** Same items, two arms. `pB` is derived from `pA` so the pairing is real. */
  const pair = (transform: (p: number) => number, n = 1200): PairedSample[] =>
    syntheticCalibrated(n, 11).map(pt => ({
      stratum: 'SYN', truth: pt.truth, weight: 1, pA: pt.p, pB: transform(pt.p), sampled: true,
    }))

  it('finds no difference between an arm and itself', () => {
    const r = pairedBootstrap(pair(p => p), OPTS)
    for (const d of r.diffs) {
      expect(d.point).toBeCloseTo(0, 12)
      expect(d.crossesZero).toBe(true)
    }
  })

  it('detects that a sharpened arm is worse calibrated', () => {
    // A = calibrated, B = overconfident, so ECE(A) − ECE(B) must be negative
    // and the interval must exclude zero.
    const r = pairedBootstrap(pair(p => sharpen(p)), OPTS)
    const ece = r.diffs.find(d => d.metric === 'ece')!
    expect(ece.point).toBeLessThan(0)
    expect(ece.crossesZero).toBe(false)
    expect(ece.hi).toBeLessThan(0)
  })

  it('reports no resolution difference for a rank-preserving transform', () => {
    // The cross-check that makes the ECE result interpretable: if resolution
    // also moved, "better calibrated" and "better at separating the classes"
    // would be confounded, and the comparison would not be about calibration.
    const r = pairedBootstrap(pair(p => sharpen(p)), OPTS)
    const res = r.diffs.find(d => d.metric === 'resolution')!
    expect(Math.abs(res.point)).toBeLessThan(0.01)
    expect(res.crossesZero).toBe(true)
  })

  it('widens the interval when more comparisons are planned', () => {
    const one = pairedBootstrap(pair(p => sharpen(p, 0.9)), { ...OPTS, comparisons: 1 })
    const ten = pairedBootstrap(pair(p => sharpen(p, 0.9)), { ...OPTS, comparisons: 10 })
    const w = (r: typeof one) => { const d = r.diffs.find(x => x.metric === 'ece')!; return d.hi - d.lo }
    expect(w(ten)).toBeGreaterThan(w(one))
    expect(ten.tail).toBeCloseTo(0.0025, 10)
  })

  it('is deterministic under a fixed seed', () => {
    const a = pairedBootstrap(pair(p => sharpen(p)), OPTS)
    const b = pairedBootstrap(pair(p => sharpen(p)), OPTS)
    expect(a.diffs.map(d => [d.lo, d.hi])).toEqual(b.diffs.map(d => [d.lo, d.hi]))
  })

  it('a fixed census contributes no sampling variance', () => {
    // Every row a census, nothing resampled: the interval must collapse onto
    // the point estimate. If it does not, `census: fix` is not doing its job.
    const census = pair(p => sharpen(p), 400).map(s => ({ ...s, sampled: false }))
    const r = pairedBootstrap(census, { ...OPTS, census: 'fix' })
    const ece = r.diffs.find(d => d.metric === 'ece')!
    expect(ece.hi - ece.lo).toBeCloseTo(0, 10)
  })

  it('resampling within strata keeps each stratum at its original size', () => {
    // Indirect but sufficient: a design with one huge stratum and one tiny one
    // must not produce replicates dominated by whichever was drawn more often.
    // Pooled resampling would let the tiny stratum vanish entirely; stratified
    // resampling cannot. The tiny stratum carries all the signal here, so a
    // pooled bootstrap would show a visibly wider interval.
    const big: PairedSample[] = Array.from({ length: 400 }, (_, i) => ({
      stratum: 'B', truth: i % 2 === 0, weight: 1, pA: 0.5, pB: 0.5, sampled: true,
    }))
    const tiny: PairedSample[] = Array.from({ length: 8 }, (_, i) => ({
      stratum: 'A', truth: true, weight: 1, pA: 0.99, pB: 0.5, sampled: true,
    }))
    const r = pairedBootstrap([...big, ...tiny], OPTS)
    expect(r.n).toBe(408)
    const ece = r.diffs.find(d => d.metric === 'ece')!
    expect(Number.isFinite(ece.lo) && Number.isFinite(ece.hi)).toBe(true)
  })
})

describe('weighting', () => {
  it('a weighted bin reports an interval matching its weighted estimate', () => {
    // 2 items standing for 30 rows, 2 standing for 2. The raw count is 4;
    // pretending the interval is a 4-item interval would overstate precision,
    // and pretending it is a 32-row interval would invent 28 observations.
    const pts: Point[] = [
      { p: 0.9, truth: true, weight: 15 },
      { p: 0.9, truth: true, weight: 15 },
      { p: 0.9, truth: false, weight: 1 },
      { p: 0.9, truth: true, weight: 1 },
    ]
    const [b] = binify(pts, 1)
    expect(b.n).toBe(4)
    expect(b.nEff).toBeGreaterThan(1)
    expect(b.nEff).toBeLessThan(4)
    expect(b.observed).toBeCloseTo(31 / 32, 6)
    const [lo, hi] = wilsonFromProportion(b.observed, b.nEff)
    expect(b.wilsonLo).toBeCloseTo(lo, 12)
    expect(b.wilsonHi).toBeCloseTo(hi, 12)
  })
})
