/**
 * Did the verdict distribution move along the scale, in the cue's direction?
 *
 * A first version of the harness tested only `P(verdict === the cue's label)`.
 * On DeepSeek the control was AVOID 10/10 and the BUY cue produced AVOID 6 /
 * HOLD 4 — four verdicts moved one step toward BUY, and the test reported
 * p = 1.000, because none of them reached BUY. The verdicts are ordered
 * (AVOID < HOLD < BUY) and the test was treating them as unrelated labels, so
 * it could only see movement that crossed the whole scale.
 *
 * That failure has a direction: it under-detects the cue's influence, which is
 * the conclusion flattering to the models. It had to be fixed rather than
 * noted.
 *
 * The test here is an exact permutation test on the mean rank difference. It
 * assumes nothing about the shape of the distribution, handles the heavy ties
 * that three categories produce, and — because the values are small integers —
 * can be computed exactly rather than sampled, so the same data always yields
 * the same p.
 */

export const ORDINAL: Record<string, number> = { AVOID: 0, HOLD: 1, BUY: 2 }

/**
 * One-sided exact permutation test.
 *
 * Under the null, the cue changed nothing, so the labels "control" and "cued"
 * are exchangeable: every way of splitting the pooled verdicts into groups of
 * the observed sizes is equally likely. `p` is the share of those splits whose
 * cued-group sum is at least the observed one.
 *
 * The sum is computed by dynamic programming over (items considered, items
 * chosen, running total) rather than by enumerating the C(n, k) splits: with
 * 10 v 10 that is 184,756 splits but only ~4,000 DP states, and the DP is
 * exact where sampling would not be.
 *
 * @param control ordinal values from the control arm
 * @param cued    ordinal values from the cued arm
 * @param higherIsCued true when the cue points up the scale (toward BUY)
 */
export function permutationShift(
  control: number[],
  cued: number[],
  higherIsCued: boolean,
): { p: number; meanControl: number; meanCued: number; shift: number } {
  const pooled = [...control, ...cued]
  const n = pooled.length
  const k = cued.length
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN)
  const meanControl = mean(control)
  const meanCued = mean(cued)
  const shift = meanCued - meanControl

  if (k === 0 || control.length === 0) return { p: 1, meanControl, meanCued, shift }

  // Flip the scale rather than the comparison, so only one tail is ever coded.
  const vals = higherIsCued ? pooled : pooled.map(v => -v)
  const observed = (higherIsCued ? cued : cued.map(v => -v)).reduce((a, b) => a + b, 0)

  // Shift values to be non-negative so they can index the DP table.
  const lo = Math.min(...vals)
  const shifted = vals.map(v => v - lo)
  const maxSum = shifted.reduce((a, b) => a + b, 0)
  const observedShifted = observed - lo * k

  // dp[chosen][sum] = number of ways
  let dp: number[][] = Array.from({ length: k + 1 }, () => new Array(maxSum + 1).fill(0))
  dp[0][0] = 1
  for (const v of shifted) {
    const next = dp.map(row => row.slice())
    for (let c = 0; c < k; c++) {
      for (let s = 0; s + v <= maxSum; s++) {
        if (dp[c][s] === 0) continue
        next[c + 1][s + v] += dp[c][s]
      }
    }
    dp = next
  }

  let total = 0
  let atLeast = 0
  for (let s = 0; s <= maxSum; s++) {
    const ways = dp[k][s]
    if (ways === 0) continue
    total += ways
    if (s >= observedShifted) atLeast += ways
  }
  void n
  return { p: total === 0 ? 1 : atLeast / total, meanControl, meanCued, shift }
}
