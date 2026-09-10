import { fisherOneSided } from '../fisher'

/**
 * Reference values come from scipy 1.x
 * (`scipy.stats.fisher_exact(table, alternative='greater')`), not from this
 * implementation and not from hand arithmetic. An expectation derived from the
 * code it is testing agrees with the code by construction and would pass just
 * as happily if both were wrong.
 */
describe('fisherOneSided — against scipy', () => {
  const cases: [string, [number, number, number, number], number][] = [
    ["Fisher's tea tasting", [3, 1, 1, 3], 0.242857],
    ['clear association', [8, 2, 1, 5], 0.024476],
    ['saturated cued arm', [10, 0, 3, 7], 0.001548],
    ['no association at all', [5, 5, 5, 5], 0.671859],
    ['moderate effect', [7, 3, 2, 8], 0.034889],
  ]

  it.each(cases)('%s', (_name, [a, b, c, d], expected) => {
    expect(fisherOneSided(a, b, c, d)).toBeCloseTo(expected, 6)
  })
})

describe('fisherOneSided — degenerate tables', () => {
  // A margin of zero means one variable never varied. There is no association
  // to detect, and returning a small p here would manufacture significance out
  // of an arm that produced one single outcome.
  it.each([
    ['empty cued arm', [0, 0, 5, 5]],
    ['empty control arm', [5, 5, 0, 0]],
    ['nobody hit', [0, 10, 0, 10]],
    ['everybody hit', [10, 0, 10, 0]],
  ] as [string, [number, number, number, number]][])('%s returns 1', (_n, [a, b, c, d]) => {
    expect(fisherOneSided(a, b, c, d)).toBe(1)
  })

  it('rejects non-integer and negative counts', () => {
    expect(() => fisherOneSided(1.5, 2, 3, 4)).toThrow()
    expect(() => fisherOneSided(-1, 2, 3, 4)).toThrow()
  })
})

describe('fisherOneSided — properties', () => {
  it('is a probability for every small table', () => {
    for (let a = 0; a <= 6; a++)
      for (let b = 0; b <= 6; b++)
        for (let c = 0; c <= 6; c++)
          for (let d = 0; d <= 6; d++) {
            const p = fisherOneSided(a, b, c, d)
            expect(p).toBeGreaterThanOrEqual(0)
            expect(p).toBeLessThanOrEqual(1)
          }
  })

  it('gets smaller as the cued arm pulls further ahead', () => {
    // Same margins, monotonically stronger association.
    const p6 = fisherOneSided(6, 4, 4, 6)
    const p8 = fisherOneSided(8, 2, 2, 8)
    const p10 = fisherOneSided(10, 0, 0, 10)
    expect(p8).toBeLessThan(p6)
    expect(p10).toBeLessThan(p8)
  })
})
