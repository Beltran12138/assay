import { agreementStats, anyRate, impliedPerItemRate, tnrBoundsFromAgreement } from '../anyrate'

/**
 * Reference values were computed in Python (plain float arithmetic, and
 * sklearn.metrics.cohen_kappa_score for kappa), not from this implementation.
 */
describe('anyRate — against Python', () => {
  it.each([
    [0.1, 10, 0.6513215599],
    [0.05, 10, 0.4012630608],
    [0.01, 27, 0.2376572857],
  ])('perItem %p over k=%p', (p, k, expected) => {
    expect(anyRate(p, k)).toBeCloseTo(expected, 8)
  })

  it('is 0 with no items and equals perItem with one', () => {
    expect(anyRate(0.3, 0)).toBe(0)
    expect(anyRate(0.3, 1)).toBeCloseTo(0.3, 12)
  })

  it('rejects out-of-range input', () => {
    expect(() => anyRate(1.2, 3)).toThrow()
    expect(() => anyRate(0.1, 2.5)).toThrow()
  })
})

describe('impliedPerItemRate', () => {
  it('inverts anyRate for a constant k', () => {
    expect(impliedPerItemRate([10, 10, 10], 0.6513215599)).toBeCloseTo(0.1, 8)
  })

  it('inverts the mean any-rate over mixed lengths (Python reference)', () => {
    // mean(1 − 0.92^k) over k = 3, 5, 12 is 0.3981880297
    expect(impliedPerItemRate([3, 5, 12], 0.3981880297)).toBeCloseTo(0.08, 8)
  })

  it('separates two arms with equal any-rates but different lengths', () => {
    // The point of the function: the same 40% any-rate means a much noisier
    // judge on short replies than on long ones.
    const short = impliedPerItemRate([2, 2, 2, 2], 0.4)
    const long = impliedPerItemRate([12, 12, 12, 12], 0.4)
    expect(short).toBeGreaterThan(3 * long)
  })

  it('returns NaN when nothing could have been flagged, or the rate is unreachable', () => {
    expect(impliedPerItemRate([], 0.2)).toBeNaN()
    expect(impliedPerItemRate([0, 0], 0)).toBeNaN()
    // Half the replies have no items, so at most half can be flagged.
    expect(impliedPerItemRate([0, 4], 0.8)).toBeNaN()
  })
})

describe('agreementStats — against sklearn', () => {
  it('reports the four numbers raw agreement collapses', () => {
    const s = agreementStats(40, 10, 5, 45)
    expect(s.rawAgreement).toBeCloseTo(0.85, 12)
    expect(s.kappa).toBeCloseTo(0.7, 12)
    expect(s.tpr).toBeCloseTo(0.8888888889, 9)
    expect(s.tnr).toBeCloseTo(0.8181818182, 9)
    expect(s.baseRate).toBeCloseTo(0.45, 12)
  })

  it('a judge that always says "failure" agrees a lot at a high base rate and has TNR 0', () => {
    const s = agreementStats(90, 10, 0, 0)
    expect(s.rawAgreement).toBeCloseTo(0.9, 12)
    expect(s.tnr).toBe(0)
    expect(s.kappa).toBeCloseTo(0, 12)
  })

  it('kappa is undefined, not perfect, when neither rater ever varied', () => {
    expect(agreementStats(0, 0, 0, 20).kappa).toBeNaN()
  })

  it('rejects bad tables', () => {
    expect(() => agreementStats(0, 0, 0, 0)).toThrow()
    expect(() => agreementStats(1.5, 0, 0, 1)).toThrow()
  })
})

describe('tnrBoundsFromAgreement', () => {
  it('matches the closed form and clips to [0,1]', () => {
    const [lo, hi] = tnrBoundsFromAgreement(0.869, 0.5)
    expect(lo).toBeCloseTo(0.738, 12)
    expect(hi).toBe(1)
  })

  it('pins TNR exactly only when there are no positives', () => {
    const [lo, hi] = tnrBoundsFromAgreement(0.869, 0)
    expect(lo).toBeCloseTo(0.869, 12)
    expect(hi).toBeCloseTo(0.869, 12)
  })

  it('leaves TNR almost unconstrained at a high base rate', () => {
    const [lo, hi] = tnrBoundsFromAgreement(0.869, 0.8)
    expect(lo).toBeLessThan(0.4)
    expect(hi).toBe(1)
  })
})
