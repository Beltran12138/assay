// Ablation control — is the fact under test only in the block under test?
//
// Two things live here, and they answer different questions.
//
// ─── 1. The fixture audit ───────────────────────────────────────────────────
//
// `fixtures/contradictions.json` asserts three properties in prose and tests
// none of them: that `match` picks out one context, that `find` occurs once in
// it, and that breaking `find` removes the support for `cite`. The `contradict`
// rung is built on all three. `String.prototype.replace` with a string pattern
// rewrites only the FIRST occurrence, so a `find` that appears twice produces a
// context that contradicts the answer in one place and still supports it in
// another — a rung that silently measures nothing on that cell.
//
// The check is transplanted from Bespoke Labs' `nimble`, an open reproduction of
// TypeSafe's Jev released 2026-09-20. Their contrastive curation builds the same
// primitive this ladder uses — two contexts differing in one fact, with the
// label flipped — and adds a step this repo did not have:
//
//   "Then we remove each evidence sentence in turn. With either sentence
//    removed, the focus fact must become unknown, even with all of the other
//    text present. This way, we know that no other text gives away the answer."
//                          — nimble README, "Contrastive data curation", step 3
//
// They run it with model calls at dataset-construction time. Here it is
// deterministic and offline, because this repo's rule is that controls run
// before any judge is called, and because a model call to validate a fixture is
// a judge grading its own exam paper.
//
// ⚠️ Coverage, stated with the result rather than discovered later: this is a
// SUBSTRING check. It catches a fact restated verbatim elsewhere and nothing
// else. A paraphrase — "最高 100 倍杠杆" against "最高支持100x杠杆" — passes it
// and is still a leak. A clean audit therefore means "no verbatim duplicate",
// not "no leak", and no claim stronger than that may be made from it.
//
// ─── 2. The `ablate_target` rung ────────────────────────────────────────────
//
// `docs/SUBSTITUTION-CONTROL.md` listed this as a known hole on 2026-09-22:
//
//   "`unsupported` on the tampered block counts as `located`. Silence and
//    conflict are both reactions to the edit … Splitting them is a finer
//    question than the corpus can support."
//
// With a third rung the corpus does support it. `intact` leaves the fact present
// and agreeing, `contradict` leaves it present and disagreeing, and
// `ablate_target` removes the block that carries it. That is ground truth for
// all three values of `ClaimVerdict`, one rung each:
//
//   intact          →  supported
//   contradict      →  contradicted
//   ablate_target   →  unsupported
//
// `CLAIM_JUDGE_SYSTEM` instructs the judge that "unsupported" and "contradicted"
// are different verdicts and must not be merged. Until now that instruction had
// no observable. A judge that answers `contradicted` when the fact is simply
// absent is inventing a conflict out of a silence, which is the failure this
// repo's "absent is unknown, not safe" rule exists to catch — and it has never
// been visible at the claim level.
//
// The block is REPLACED with filler rather than deleted, so block count and
// rough length are held the way `swap_top1` holds them. The difference from
// `swap_top1` is the point: that rung picks its victim by character-set overlap
// with the answer, a heuristic, while this one takes the block named by
// `fixtures/contradictions.json`, which is ground truth.
//
// Note there are now two block splitters: `splitBlocks` in
// scripts/assay-substitution.ts, which returns raw strings and serves the swap
// rungs, and `parseBlocks` here, which returns titles because the audit and the
// ablation both need to name a block. The old one is left alone rather than
// widened, because the swap rungs are frozen behind published results.

export type Block = {
  /** Text inside 【…】. */
  title: string
  /** The whole block including its title line. */
  raw: string
}

/** Split a context into its leading header and its 【】-titled blocks. */
export function parseBlocks(context: string): { header: string; blocks: Block[] } {
  const i = context.indexOf('【')
  if (i < 0) return { header: context, blocks: [] }
  const raws = context.slice(i).split(/\n\n(?=【)/).filter(b => b.trim())
  return {
    header: context.slice(0, i),
    blocks: raws.map(raw => ({ title: raw.match(/^【([^】]+)】/)?.[1] ?? '', raw })),
  }
}

/** The block whose text contains `needle`, or null. */
export function findTargetBlock(context: string, needle: string): Block | null {
  return parseBlocks(context).blocks.find(b => b.raw.includes(needle)) ?? null
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let n = 0
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length)) n++
  return n
}

/**
 * Replace the block carrying `needle` with `filler`.
 *
 * Returns null when the context has no such block, which is the same shape the
 * other rung builders use for "this rung does not apply to this cell".
 */
export function ablateTarget(context: string, needle: string, filler: string): string | null {
  const { header, blocks } = parseBlocks(context)
  const hit = blocks.findIndex(b => b.raw.includes(needle))
  if (hit < 0) return null
  return header + blocks.map((b, i) => (i === hit ? filler : b.raw)).join('\n\n')
}

// ─── the audit ───────────────────────────────────────────────────────────────

export type IssueCode =
  /** `match` selects no context, or more than one. The ground truth for every
   *  other context it hits is then whichever entry happens to come first. */
  | 'match_not_unique'
  /** `find` is absent — the rung silently returns the context unchanged. */
  | 'find_absent'
  /** `find` occurs more than once. `.replace(string, …)` rewrites the first and
   *  leaves the rest, so the context contradicts and supports the answer at once. */
  | 'find_not_unique'
  /** `cite` is not inside `find`. Breaking `find` then does not break the token
   *  the cited/uncited split is built on. */
  | 'cite_outside_find'
  /** `cite` appears somewhere other than the target block. Support for the claim
   *  survives the edit, so a judge that keeps calling it supported is right and
   *  is scored as having missed. */
  | 'cite_leaks'

export type FixtureIssue = {
  code: IssueCode
  /** The `match` string of the offending entry. */
  entry: string
  detail: string
}

export type ContradictionEntry = {
  match: string
  find: string
  replace: string
  cite: string
}

/**
 * Check every contradiction against every distinct context.
 *
 * Returns the issues, empty when clean. It does not throw and does not decide
 * what to do about them: a leak is a reason to read a cell differently, not
 * always a reason to drop it, and that call belongs to the caller who knows
 * which rung is running.
 */
export function auditContradictions(
  contexts: string[],
  entries: ContradictionEntry[],
): FixtureIssue[] {
  const issues: FixtureIssue[] = []
  for (const e of entries) {
    const hits = contexts.filter(c => c.includes(e.match))
    if (hits.length !== 1) {
      issues.push({
        code: 'match_not_unique',
        entry: e.match,
        detail: `matches ${hits.length} of ${contexts.length} distinct contexts, expected 1`,
      })
      if (hits.length === 0) continue
    }
    for (const ctx of hits) {
      const nFind = countOccurrences(ctx, e.find)
      if (nFind === 0) {
        issues.push({ code: 'find_absent', entry: e.match, detail: `find not present in the matched context` })
        continue
      }
      if (nFind > 1) {
        issues.push({
          code: 'find_not_unique',
          entry: e.match,
          detail: `find occurs ${nFind}× — .replace() rewrites only the first, leaving ${nFind - 1} intact`,
        })
      }
      if (!e.find.includes(e.cite)) {
        issues.push({
          code: 'cite_outside_find',
          entry: e.match,
          detail: `cite ${JSON.stringify(e.cite)} is not inside find ${JSON.stringify(e.find)}`,
        })
      }
      const target = findTargetBlock(ctx, e.find)
      if (!target) continue
      const inCtx = countOccurrences(ctx, e.cite)
      const inBlock = countOccurrences(target.raw, e.cite)
      if (inCtx > inBlock) {
        issues.push({
          code: 'cite_leaks',
          entry: e.match,
          detail: `cite ${JSON.stringify(e.cite)} occurs ${inCtx}× in the context but only ${inBlock}× in 【${target.title}】 — ${inCtx - inBlock} outside it`,
        })
      }
    }
  }
  return issues
}

// ─── reading the three-rung verdict matrix ───────────────────────────────────

/**
 * What each rung's ground truth says the target claim's verdict should be.
 *
 * Only the rungs with a registered edit appear. `perturb_unused` is deliberately
 * absent: it touches the 常見追問 line, which no answer draws on, so it has no
 * target claim and its expected verdict is a property of the answer, not of the
 * edit. It stays in the run as a false-alarm control and out of this table.
 */
export const EXPECTED_VERDICT = {
  intact: 'supported',
  contradict: 'contradicted',
  ablate_target: 'unsupported',
} as const
