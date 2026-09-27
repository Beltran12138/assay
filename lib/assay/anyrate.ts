/**
 * Two ways a judge-reliability number can look better, or worse, than the judge.
 *
 * Pure functions, no IO.
 *
 * 1. "At least one" aggregation. A trajectory, reply or document is flagged if
 *    ANY of its k checked items is flagged. Even an honest per-item false
 *    positive rate compounds: 5% per item over ten items flags 40% of perfectly
 *    clean replies. So an any-rate is uninterpretable without k, and two any-rates
 *    over different k are not comparable at all — the difference can be pure
 *    arithmetic. `anyRate` and `impliedPerItemRate` move between the two scales.
 *
 * 2. Raw agreement. "The judge agrees with humans 87% of the time" does not fix
 *    how often it catches a real failure (TPR) or clears a clean item (TNR); at a
 *    skewed base rate a judge that always says the majority label agrees a lot.
 *    `agreementStats` reports the four numbers that raw agreement collapses, and
 *    `tnrBoundsFromAgreement` shows how wide the TNR range left open by a raw
 *    agreement figure is.
 *
 * Motivating case: LexAgentHallu (arXiv 2609.09754) reports "≥1 hallucination"
 * trajectory rates from a rubric-anchored LLM judge whose validation is raw
 * judge–human agreement only. See RELATED-WORK.md.
 */

/**
 * P(at least one flag among k items) when each item is flagged independently
 * with probability `perItem`. With `perItem` = the judge's false positive rate
 * and a clean reply, this is the floor an any-rate cannot go below.
 *
 * Independence is an assumption. Positively correlated false positives (one
 * confusing reply trips several items) give a LOWER any-rate than this, so the
 * formula is the worst case for a clean reply, not an estimate.
 */
export function anyRate(perItem: number, k: number): number {
  if (!(perItem >= 0 && perItem <= 1)) throw new Error(`perItem must be in [0,1], got ${perItem}`)
  if (!(Number.isInteger(k) && k >= 0)) throw new Error(`k must be a non-negative integer, got ${k}`)
  return 1 - Math.pow(1 - perItem, k)
}

/**
 * The single per-item rate that, applied to every item, reproduces an observed
 * any-rate over replies with item counts `ks` (one entry per reply; replies
 * differ in how many claims they make).
 *
 * This is what lets two rungs, arms or systems be compared when their replies
 * have different lengths: compare the implied per-item rates, not the any-rates.
 * It is a normalisation under the independence model above, not a measured
 * per-item rate — only item-level labels give that.
 *
 * Solved by bisection: mean(1 − (1−p)^k_i) is increasing in p, so the root is
 * unique. Returns NaN when no reply has any items (nothing could be flagged).
 */
export function impliedPerItemRate(ks: number[], observedAny: number): number {
  if (!(observedAny >= 0 && observedAny <= 1)) throw new Error(`observedAny must be in [0,1], got ${observedAny}`)
  if (ks.some(k => !(Number.isInteger(k) && k >= 0))) throw new Error('ks must be non-negative integers')
  const withItems = ks.filter(k => k > 0).length
  if (!ks.length || withItems === 0) return NaN
  // A reply with zero items can never be flagged, so the achievable ceiling is
  // the share of replies that have at least one item.
  const ceiling = withItems / ks.length
  if (observedAny > ceiling + 1e-12) return NaN
  const f = (p: number) => ks.reduce((s, k) => s + anyRate(p, k), 0) / ks.length
  let lo = 0
  let hi = 1
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (f(mid) < observedAny) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

export type AgreementStats = {
  n: number
  /** Share of items the human labelled positive (failure present). */
  baseRate: number
  rawAgreement: number
  /** Of human-positive items, share the judge also flagged. NaN if none. */
  tpr: number
  /** Of human-negative items, share the judge also cleared. NaN if none. */
  tnr: number
  /** Cohen's kappa: agreement beyond what the two marginals give by chance. */
  kappa: number
}

/**
 * Judge vs human on binary items. Positive = "failure present".
 *
 *     tp: human +, judge +     fp: human −, judge +
 *     fn: human +, judge −     tn: human −, judge −
 */
export function agreementStats(tp: number, fp: number, fn: number, tn: number): AgreementStats {
  if ([tp, fp, fn, tn].some(x => !Number.isInteger(x) || x < 0)) {
    throw new Error(`agreementStats expects non-negative integers, got ${[tp, fp, fn, tn].join(', ')}`)
  }
  const n = tp + fp + fn + tn
  if (n === 0) throw new Error('agreementStats: empty table')
  const po = (tp + tn) / n
  const pe = ((tp + fp) * (tp + fn) + (fn + tn) * (fp + tn)) / (n * n)
  return {
    n,
    baseRate: (tp + fn) / n,
    rawAgreement: po,
    tpr: tp + fn ? tp / (tp + fn) : NaN,
    tnr: fp + tn ? tn / (fp + tn) : NaN,
    // pe = 1 only when both raters used a single label throughout; agreement
    // beyond chance is then undefined, not perfect.
    kappa: pe === 1 ? NaN : (po - pe) / (1 - pe),
  }
}

/**
 * Given only a raw agreement figure and the human base rate, the range of TNR
 * that is consistent with it (TPR allowed anywhere in [0,1]).
 *
 * agreement = b·TPR + (1−b)·TNR, so TNR = (agreement − b·TPR) / (1−b).
 * The width of this interval is what a paper leaves open when it reports raw
 * agreement and nothing else.
 */
export function tnrBoundsFromAgreement(agreement: number, baseRate: number): [number, number] {
  if (!(agreement >= 0 && agreement <= 1)) throw new Error(`agreement must be in [0,1], got ${agreement}`)
  if (!(baseRate >= 0 && baseRate < 1)) throw new Error(`baseRate must be in [0,1), got ${baseRate}`)
  const lo = (agreement - baseRate) / (1 - baseRate)
  const hi = agreement / (1 - baseRate)
  return [Math.max(0, lo), Math.min(1, hi)]
}
