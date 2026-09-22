// Release gates — thresholds frozen before the first run decides them.
//
// The shape (redline / gate / observe, frozen ahead of the first evaluation)
// is borrowed from AWS's Agent DLC whitepaper, which states the discipline
// plainly: freeze the three tiers *before* you run anything, or you end up
// picking the bar after seeing the score. That part is right and costs nothing.
//
// Three things are changed on the way in, because the version in the paper
// cannot be expressed in this codebase without breaking its central rule:
//
//   1. A gate names a CONSTRUCT. "quality ≥ 0.8" is not a threshold here; 0.8
//      faithfulness and 0.8 correctness are different objects (constructs.ts).
//
//   2. A gate names a METHOD. A deterministic 0.8 and a judged 0.8 are not the
//      same 0.8. A gate frozen against one ruler is not evaluated against the
//      other; it reports `unevaluable` instead of quietly using what is there.
//
//   3. 🔴 A gate is only as trustworthy as the score under it. If the report
//      flags the observations feeding a gate — the grader shares a family with
//      the graded, or faithfulness is high while correctness is low — then a
//      PASS is not a pass. It becomes `unevaluable`. This is the whole point of
//      this repo applied to its own release mechanism: a harness that lets an
//      untrusted number open a gate is worse than no gate, because it converts
//      a known unknown into a green build.
//
// And one default is inverted. Absent is unknown, not safe (constructs.ts:120,
// report.ts:124). A gate with no observations does NOT pass. Every CI system in
// existence treats a missing test as a green build; that default is the reason
// a criterion important enough to gate on can go unmeasured for months. If a
// gate is too strict to be evaluable, demote it to `observe` — a conscious,
// diffable act — rather than letting absence read as compliance.

import type { Construct, Method, Observation } from './constructs'
import { isSelfGraded } from './constructs'
import type { Flag } from './report'

export type Tier =
  | 'redline'   // every single observation must clear the bar; one failure blocks
  | 'gate'      // the mean must clear the bar
  | 'observe'   // no bar; recorded so a later run has something to compare against

export type GateOutcome = 'pass' | 'fail' | 'unevaluable'

export type Gate = {
  id: string
  tier: Tier
  construct: Construct
  method: Method
  /** Required score. `null` only for `observe`, which has no bar. */
  min: number | null
  /** Why this bar, in a sentence. Frozen with the number, so a later reader can
   *  tell whether the threshold was reasoned or inherited. */
  rationale: string
}

export type GateSet = {
  /** ISO date the thresholds were fixed. Before the first evaluation, or the
   *  tiers are a post-hoc description of a result. */
  frozenAt: string
  /** Content hash of `gates`, recomputed on load. See `gateSetHash`. */
  hash: string
  gates: Gate[]
}

export type GateResult = {
  gate: Gate
  outcome: GateOutcome
  /** Worst observation for a redline, mean for a gate, mean for observe. */
  observed: number | null
  n: number
  reason: string
}

export type GateReport = {
  /** `unevaluable` is deliberately not folded into `block`: "we measured it and
   *  it is bad" and "we do not know" are different states and lead to different
   *  work. Neither is a release. */
  verdict: 'release' | 'block' | 'unevaluable'
  results: GateResult[]
  frozen: { ok: boolean; detail: string }
}

// ─── freezing ────────────────────────────────────────────────────────────────
//
// "Freeze the tiers before the first run" is worth nothing as a sentence in a
// README; someone edits a threshold at 2am and no artefact records it. So the
// gate set carries a hash of its own contents, checked on load: change a bar
// and the file fails to load until the hash is re-stamped, and the re-stamp is
// a line in the diff. That is the enforcement — making the edit *visible*, not
// making it impossible.
//
// FNV-1a rather than a crypto hash, on purpose: this guards against accidental
// drift, not against an adversary who also controls the repo, and keeping the
// module import-free means it behaves the same in a script and in a bundle.

function fnv1a64(s: string): string {
  // 64-bit FNV-1a in two 32-bit halves, since JS bitwise ops are 32-bit.
  let h1 = 0x811c9dc5, h2 = 0xcbf29ce4
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 ^= c & 0xff
    h2 ^= (c >>> 8) & 0xff
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 = Math.imul(h2, 0x01000193) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

/** Stable over key order and gate order, sensitive to every field that changes
 *  what the gate means — including `rationale`, because a bar whose stated
 *  reason changed is a different bar. */
export function gateSetHash(gates: Gate[]): string {
  const canonical = [...gates]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(g => [g.id, g.tier, g.construct, g.method, g.min ?? 'null', g.rationale].join('\u0001'))
    .join('\u0002')
  return fnv1a64(canonical)
}

export class GateSetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GateSetError'
  }
}

/** Validates a gate set and verifies it has not drifted since it was frozen.
 *  Throws rather than warning: a run against silently-edited thresholds
 *  produces a release decision that cannot be audited afterwards. */
export function loadGateSet(raw: unknown): GateSet {
  const o = raw as Partial<GateSet>
  if (!o || typeof o !== 'object') throw new GateSetError('gate set is not an object')
  if (!Array.isArray(o.gates) || o.gates.length === 0) {
    throw new GateSetError('gate set has no gates — an empty gate set would release everything')
  }
  if (typeof o.frozenAt !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(o.frozenAt)) {
    throw new GateSetError('gate set has no `frozenAt` date; a tier list with no freeze date is a description, not a commitment')
  }

  const seen = new Set<string>()
  for (const g of o.gates) {
    if (!g.id) throw new GateSetError('a gate has no id')
    if (seen.has(g.id)) throw new GateSetError(`duplicate gate id: ${g.id}`)
    seen.add(g.id)
    if (g.tier !== 'redline' && g.tier !== 'gate' && g.tier !== 'observe') {
      throw new GateSetError(`${g.id}: tier must be redline | gate | observe`)
    }
    if (g.tier === 'observe') {
      if (g.min !== null) throw new GateSetError(`${g.id}: an \`observe\` gate has no bar; set min to null`)
    } else {
      if (typeof g.min !== 'number' || g.min < 0 || g.min > 1) {
        throw new GateSetError(`${g.id}: min must be a number in 0..1 for a ${g.tier}`)
      }
    }
    if (!g.rationale?.trim()) {
      throw new GateSetError(`${g.id}: a threshold with no stated reason cannot be reviewed later`)
    }
  }

  const actual = gateSetHash(o.gates)
  if (o.hash !== actual) {
    throw new GateSetError(
      `gate set was edited after it was frozen on ${o.frozenAt}: hash ${o.hash} but contents hash ${actual}. ` +
      `Re-stamping is allowed and intended to be visible — set "hash": "${actual}" and update "frozenAt" ` +
      `in the same commit, so the diff records that a bar moved.`,
    )
  }
  return o as GateSet
}

// ─── evaluation ──────────────────────────────────────────────────────────────

/** Flags that make a score unfit to open a gate, and which constructs they
 *  poison. `self_graded` is checked per-observation rather than per-report,
 *  because a run can contain both self-graded and cross-graded cells. */
function trustProblem(gate: Gate, obs: Observation[], flags: Flag[]): string | null {
  if (gate.method === 'llm_judge') {
    const tainted = obs.filter(isSelfGraded)
    if (tainted.length > 0) {
      return `${tainted.length}/${obs.length} of these observations were graded by the family that produced them; ` +
             `a PASS here would rest on a score with a known upward bias`
    }
  }
  // The Correctness/Faithfulness swap, caught mechanically: when the report has
  // already concluded that answers are loyal to a wrong corpus, a faithfulness
  // bar passing is the *symptom*, not the clearance.
  if (gate.construct === 'faithfulness' && flags.some(f => f.code === 'grounded_falsehood')) {
    return 'the report flags grounded_falsehood — faithfulness is high because the corpus is wrong, ' +
           'so clearing a faithfulness bar says nothing about the release'
  }
  return null
}

export function evaluateGates(
  gateSet: GateSet,
  observations: Observation[],
  flags: Flag[] = [],
): GateReport {
  const results: GateResult[] = gateSet.gates.map(gate => {
    const obs = observations.filter(o => o.construct === gate.construct && o.method === gate.method)
    const scores = obs.map(o => o.score)

    if (scores.length === 0) {
      const otherMethods = [...new Set(
        observations.filter(o => o.construct === gate.construct).map(o => o.method),
      )]
      return {
        gate,
        outcome: 'unevaluable',
        observed: null,
        n: 0,
        reason: otherMethods.length
          ? `nothing measured "${gate.construct}" by ${gate.method} (present: ${otherMethods.join(', ')}) — ` +
            `a different ruler is not a substitute`
          : `nothing in this run measured "${gate.construct}"`,
      }
    }

    const problem = trustProblem(gate, obs, flags)
    if (problem) {
      return { gate, outcome: 'unevaluable', observed: null, n: scores.length, reason: problem }
    }

    const meanScore = scores.reduce((s, x) => s + x, 0) / scores.length

    if (gate.tier === 'observe') {
      return {
        gate, outcome: 'pass', observed: meanScore, n: scores.length,
        reason: `baseline ${meanScore.toFixed(3)} recorded over n=${scores.length}; no bar, never blocks`,
      }
    }

    if (gate.tier === 'redline') {
      // The mean is the wrong statistic for a redline: nine 1.00s hide one 0.00,
      // and the one 0.00 is the customer who was told the wrong thing.
      const worst = Math.min(...scores)
      const nFail = scores.filter(s => s < gate.min!).length
      return {
        gate,
        outcome: nFail === 0 ? 'pass' : 'fail',
        observed: worst,
        n: scores.length,
        reason: nFail === 0
          ? `all ${scores.length} observations ≥ ${gate.min} (worst ${worst.toFixed(3)})`
          : `${nFail}/${scores.length} observations below ${gate.min} (worst ${worst.toFixed(3)}); ` +
            `a redline is per-observation, so the mean ${meanScore.toFixed(3)} does not clear it`,
      }
    }

    return {
      gate,
      outcome: meanScore >= gate.min! ? 'pass' : 'fail',
      observed: meanScore,
      n: scores.length,
      reason: `mean ${meanScore.toFixed(3)} over n=${scores.length} vs bar ${gate.min}`,
    }
  })

  const blocking = results.filter(r => r.gate.tier !== 'observe')
  const verdict: GateReport['verdict'] =
    blocking.some(r => r.outcome === 'fail') ? 'block'
    : blocking.some(r => r.outcome === 'unevaluable') ? 'unevaluable'
    : 'release'

  return {
    verdict,
    results,
    frozen: {
      ok: true,
      detail: `gate set frozen ${gateSet.frozenAt}, hash ${gateSet.hash} (verified on load)`,
    },
  }
}

export function formatGateReport(r: GateReport): string {
  const lines: string[] = []
  const gloss =
    r.verdict === 'release' ? 'every blocking bar was measured and cleared'
    : r.verdict === 'block' ? 'at least one bar was measured and missed'
    : 'at least one blocking bar could not be evaluated — this is NOT a release'
  lines.push(`gate verdict: ${r.verdict}   (${gloss})`)
  lines.push(`  ${r.frozen.detail}`)
  lines.push('')

  for (const tier of ['redline', 'gate', 'observe'] as Tier[]) {
    const inTier = r.results.filter(x => x.gate.tier === tier)
    if (inTier.length === 0) continue
    lines.push(`  ── ${tier} ──`)
    for (const x of inTier) {
      const mark = x.outcome === 'pass' ? 'PASS' : x.outcome === 'fail' ? 'FAIL' : '????'
      lines.push(`  [${mark}] ${x.gate.id}  (${x.gate.construct} / ${x.gate.method})`)
      lines.push(`         ${x.reason}`)
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}
