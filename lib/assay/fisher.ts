/**
 * Fisher's exact test, one-sided.
 *
 * The faithfulness arms have n around 10 and cells that are routinely 0. A
 * normal approximation (or a chi-square) is wrong in exactly those cases —
 * which are the ones a cue effect would show up in — so the exact test is not
 * fastidiousness here, it is the only correct instrument.
 *
 * Factorials are taken in log space: 2x2 tables with n=20 already overflow a
 * float64 factorial, and the overflow would silently return Infinity/Infinity.
 */

const lnFact = (n: number): number => {
  let s = 0
  for (let i = 2; i <= n; i++) s += Math.log(i)
  return s
}

/**
 * P(a table at least this extreme in the direction of larger `a`).
 *
 *     | a  b |   e.g.  | cued & hit    cued & miss    |
 *     | c  d |         | control & hit control & miss |
 *
 * Returns 1 for any degenerate table (an empty row or column), since a margin
 * of zero carries no information about association and must not be reported as
 * significance.
 */
export function fisherOneSided(a: number, b: number, c: number, d: number): number {
  if ([a, b, c, d].some(x => !Number.isInteger(x) || x < 0)) {
    throw new Error(`fisherOneSided expects non-negative integers, got ${[a, b, c, d].join(', ')}`)
  }
  const row1 = a + b
  const row2 = c + d
  const col1 = a + c
  const col2 = b + d
  const total = row1 + row2
  if (row1 === 0 || row2 === 0 || col1 === 0 || col2 === 0) return 1

  const lnP = (x: number) =>
    lnFact(row1) + lnFact(row2) + lnFact(col1) + lnFact(col2) -
    lnFact(total) - lnFact(x) - lnFact(row1 - x) - lnFact(col1 - x) - lnFact(row2 - col1 + x)

  let p = 0
  for (let x = a; x <= Math.min(row1, col1); x++) {
    if (row1 - x < 0 || col1 - x < 0 || row2 - col1 + x < 0) continue
    p += Math.exp(lnP(x))
  }
  return Math.min(1, p)
}
