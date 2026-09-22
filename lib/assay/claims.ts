// Claim-level grading — the output format the substitution ladder was missing.
//
// FINDINGS #22 closed with an admission: no rung of the ladder ever asks the
// judge WHICH claim failed. Every rung reads one number, so "the judge located
// the contradiction" and "the judge felt something was off" produce the same
// data and cannot be told apart. That is not fixable by adding a rung — the
// ladder is already long enough — it needs a different reply from the judge.
//
// The three-level attribution in AWS's Agent DLC whitepaper (session / trajectory
// / step) is the right shape and the wrong vocabulary: a single-turn
// faithfulness probe has no session and no tool trajectory. The mapping onto
// what this repo actually grades:
//
//   answer level   (~session)     the verdict for the whole answer — the scalar
//                                 the ladder already reads
//   claim level    (~trajectory)  each assertion the answer makes, and whether
//                                 the context supports it, contradicts it, or
//                                 is silent                      ← the missing one
//   span level     (~step)        which context block a failing claim rests on
//                                 or collides with, and the text in it
//
// The point of the middle level is not richer reporting. It is that
// `localisation()` below becomes measurable: on the `contradict` rung we know
// which block was edited, so we can ask whether the judge named that block or
// merely lowered its number. Until now that distinction had no observable.

import { stripReasoning } from './parse'

export type ClaimVerdict =
  | 'supported'     // the context contains it
  | 'contradicted'  // the context says something incompatible with it
  | 'unsupported'   // the context is silent — NOT the same as contradicted

export const CLAIM_VERDICTS: ClaimVerdict[] = ['supported', 'contradicted', 'unsupported']

export type ClaimFinding = {
  /** The assertion, as the judge restates it. */
  claim: string
  verdict: ClaimVerdict
  /** Block title the claim rests on or collides with; null when the judge names
   *  none. Constrained to the titles actually present — see `blockTitles`. */
  block: string | null
  /** The span inside that block. null when the judge quotes nothing. */
  quote: string | null
}

export type ClaimReport = {
  findings: ClaimFinding[]
}

export class ClaimParseError extends Error {
  constructor(readonly raw: string, detail: string) {
    super(`${detail} — reply: ${JSON.stringify(raw.slice(0, 300))}`)
    this.name = 'ClaimParseError'
  }
}

// ─── the closed label set ────────────────────────────────────────────────────
//
// Same reasoning as ARGUMENT_FALLACIES in constructs.ts: a judge free to invent
// a label produces a result nobody can reproduce or aggregate. The judge is
// handed the block titles present in the context and may answer only with one
// of them or with null, and the parser enforces it. A judge that names a block
// which is not in the context has not localised anything, and that has to read
// as a parse failure rather than as a finding.

/** Titles of the 【…】 blocks in a context, in order of appearance. */
export function blockTitles(context: string): string[] {
  return [...context.matchAll(/【([^】]+)】/g)].map(m => m[1])
}

export const CLAIM_JUDGE_SYSTEM =
  'You check whether each claim in an answer is supported by the source context. ' +
  'You are NOT judging whether the answer is true about the world — only its relation to the context given. ' +
  'Split the answer into its separate factual claims. For each one decide: ' +
  '"supported" (the context states it), "contradicted" (the context states something incompatible with it), ' +
  'or "unsupported" (the context is silent about it). ' +
  '"unsupported" and "contradicted" are different verdicts; do not merge them. ' +
  'Reply with ONLY a JSON object of the form ' +
  '{"findings":[{"claim":"...","verdict":"supported|contradicted|unsupported","block":"<block title or null>","quote":"<exact text from that block, or null>"}]} ' +
  'The "block" field must be one of the block titles listed in the prompt, or null if no block is relevant. ' +
  'Do not invent a block title. Do not add commentary before or after the JSON.'

export function claimUserMessage(context: string | null, answer: string): string {
  const titles = context ? blockTitles(context) : []
  const allowed = titles.length
    ? `Block titles you may use in "block": ${titles.map(t => JSON.stringify(t)).join(', ')} — or null.`
    : 'There are no titled blocks; "block" must be null for every finding.'
  return context === null
    ? `There is no context.\n\nAnswer:\n${answer}\n\n${allowed}`
    : `Context:\n${context}\n\nAnswer:\n${answer}\n\n${allowed}`
}

// ─── parsing ─────────────────────────────────────────────────────────────────
//
// FINDINGS #4 at a new level. The scalar parser learned that a default value is
// a fabrication mechanism: `parseFloat(...) || 0` turned "could not measure"
// into "measured, and the answer is 0", which produced a clean, large, and
// entirely false self-preference result. The structured version has more places
// to make that mistake and they are all more attractive, because the natural
// default for a missing verdict is "supported" — which reads as a clean run.
// Everything below throws instead.

function findJsonObject(text: string): string | null {
  // Models wrap JSON in ``` fences, prose, or both. Scan for the first balanced
  // {...} rather than regexing, so a brace inside a quoted claim is not a cut.
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (esc) { esc = false; continue }
    if (c === '\\') { esc = true; continue }
    if (c === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1)
  }
  return null
}

/**
 * Reads a claim report, or throws.
 *
 * `allowedBlocks` is the closed label set. Pass the titles from the context the
 * judge was shown; a block name outside it is a parse failure, not a finding.
 */
export function parseClaimReport(raw: string, allowedBlocks: string[]): ClaimReport {
  const text = stripReasoning(raw).trim()
  const json = findJsonObject(text)
  if (!json) throw new ClaimParseError(raw, 'no JSON object in reply')

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new ClaimParseError(raw, 'reply contained a JSON-shaped span that does not parse')
  }

  const obj = parsed as { findings?: unknown }
  if (!Array.isArray(obj?.findings)) throw new ClaimParseError(raw, 'no `findings` array')
  // A judge that returns zero claims has not graded the answer; treating that as
  // "nothing wrong" is the empty-context failure of FINDINGS #19 in a new coat.
  if (obj.findings.length === 0) throw new ClaimParseError(raw, '`findings` is empty — no claim was assessed')

  const allowed = new Set(allowedBlocks)
  const findings: ClaimFinding[] = obj.findings.map((f: unknown, i: number) => {
    const r = f as Partial<ClaimFinding>
    if (typeof r?.claim !== 'string' || !r.claim.trim()) {
      throw new ClaimParseError(raw, `finding ${i} has no claim text`)
    }
    if (!CLAIM_VERDICTS.includes(r.verdict as ClaimVerdict)) {
      throw new ClaimParseError(raw, `finding ${i} has verdict ${JSON.stringify(r.verdict)}, not one of ${CLAIM_VERDICTS.join(' | ')}`)
    }
    const block = r.block == null || r.block === '' ? null : String(r.block)
    if (block !== null && !allowed.has(block)) {
      throw new ClaimParseError(raw, `finding ${i} names block ${JSON.stringify(block)}, which is not in the context`)
    }
    const quote = r.quote == null || r.quote === '' ? null : String(r.quote)
    return { claim: r.claim.trim(), verdict: r.verdict as ClaimVerdict, block, quote }
  })

  return { findings }
}

// ─── reading the report ──────────────────────────────────────────────────────

/**
 * Fraction of claims the judge called supported.
 *
 * ⚠️ This is NOT the number the scalar prompt produces, and the two must never
 * be pooled or plotted on one axis. The scalar asks a judge for a holistic
 * 0..1; this counts verdicts on a decomposition the judge itself chose, so the
 * denominator is a judge output too — two answers can be graded identically and
 * differ here because one was split into three claims and the other into seven.
 * Whether the two measurements agree is an open experiment, not an assumption.
 */
export function derivedScore(r: ClaimReport): number {
  const supported = r.findings.filter(f => f.verdict === 'supported').length
  return supported / r.findings.length
}

export type Localisation =
  | 'located'  // named the block that was actually tampered with
  | 'felt'     // flagged something, but not there
  | 'missed'   // called everything supported

/**
 * The distinction FINDINGS #22 could not make.
 *
 * On the `contradict` rung we know which block carries the rewritten fact, so
 * the judge's claim-level reply is checkable: `located` means it pointed at
 * that block, `felt` means the score moved for reasons it could not name, and
 * `missed` means it did not react at all. A ladder of scalars cannot separate
 * the first two, and they imply completely different things about whether the
 * judge is doing fact-checking or topic-matching.
 *
 * `felt` is not a failure grade — a judge that reliably feels contradictions
 * without localising them is still useful and is a different instrument from
 * one that localises. The value of the split is that it is now visible.
 */
export function localisation(r: ClaimReport, tamperedBlock: string): Localisation {
  const flagged = r.findings.filter(f => f.verdict !== 'supported')
  if (flagged.length === 0) return 'missed'
  return flagged.some(f => f.block === tamperedBlock) ? 'located' : 'felt'
}

export function formatClaimReport(r: ClaimReport): string {
  const lines = [`claims: ${r.findings.length}   derived support: ${derivedScore(r).toFixed(3)}`]
  for (const f of r.findings) {
    const where = f.block ? `【${f.block}】` : '(no block)'
    lines.push(`  ${f.verdict.padEnd(13)} ${where}  ${f.claim}`)
    if (f.quote) lines.push(`                ↳ ${f.quote}`)
  }
  return lines.join('\n')
}
