import { readFileSync } from 'node:fs'
import {
  evaluateGates, gateSetHash, loadGateSet, GateSetError,
  type Gate, type GateSet,
} from '../gates'
import type { Observation } from '../constructs'
import type { Flag } from '../report'

// Assertions are anchored to what a gate should MEAN for a release decision,
// not to a second copy of the arithmetic.

function obs(o: Partial<Observation> & Pick<Observation, 'construct' | 'score'>): Observation {
  return { method: 'llm_judge', generator: 'deepseek-chat', judge: 'gpt-4o', source: 'test', ...o }
}

function gate(g: Partial<Gate> & Pick<Gate, 'id' | 'tier'>): Gate {
  return { construct: 'faithfulness', method: 'llm_judge', min: 0.7, rationale: 'test', ...g }
}

function set(gates: Gate[]): GateSet {
  return { frozenAt: '2026-09-22', hash: gateSetHash(gates), gates }
}

const only = (gates: Gate[], observations: Observation[], flags: Flag[] = []) =>
  evaluateGates(set(gates), observations, flags).results[0]

describe('a redline is per-observation, because the mean hides the one that mattered', () => {
  test('nine perfect answers do not carry one catastrophic answer', () => {
    const nineGood = Array.from({ length: 9 }, () => obs({ construct: 'correctness', score: 1 }))
    const oneBad = obs({ construct: 'correctness', score: 0 })
    const g = gate({ id: 'r', tier: 'redline', construct: 'correctness', min: 0.9 })

    // The mean is 0.9 and clears the bar exactly. The redline still fails.
    const r = only([g], [...nineGood, oneBad])
    expect(r.outcome).toBe('fail')
    expect(r.observed).toBe(0) // reports the worst, not the average
    expect(r.reason).toMatch(/1\/10 observations below 0\.9/)
  })

  test('the same data under a `gate` tier passes on the mean', () => {
    const nineGood = Array.from({ length: 9 }, () => obs({ construct: 'correctness', score: 1 }))
    const oneBad = obs({ construct: 'correctness', score: 0 })
    const g = gate({ id: 'g', tier: 'gate', construct: 'correctness', min: 0.9 })

    const r = only([g], [...nineGood, oneBad])
    expect(r.outcome).toBe('pass')
    expect(r.observed).toBeCloseTo(0.9, 5)
  })
})

describe('absent is unknown, not safe', () => {
  test('a gate with no observations does not pass — it blocks the release', () => {
    const report = evaluateGates(
      set([gate({ id: 'never-measured', tier: 'redline', construct: 'correctness', method: 'human', min: 1 })]),
      [obs({ construct: 'faithfulness', score: 0.95 })],
    )
    expect(report.results[0].outcome).toBe('unevaluable')
    expect(report.verdict).toBe('unevaluable')
    expect(report.verdict).not.toBe('release')
  })

  test('`unevaluable` is kept distinct from `block` — not knowing and knowing-it-is-bad differ', () => {
    const unmeasured = evaluateGates(
      set([gate({ id: 'a', tier: 'gate', construct: 'correctness' })]),
      [],
    )
    const measuredBad = evaluateGates(
      set([gate({ id: 'a', tier: 'gate', construct: 'correctness', min: 0.9 })]),
      [obs({ construct: 'correctness', score: 0.1 })],
    )
    expect(unmeasured.verdict).toBe('unevaluable')
    expect(measuredBad.verdict).toBe('block')
  })

  test('a score from a different ruler is not a substitute', () => {
    const r = only(
      [gate({ id: 'det', tier: 'gate', construct: 'faithfulness', method: 'deterministic' })],
      [obs({ construct: 'faithfulness', method: 'llm_judge', score: 1 })],
    )
    expect(r.outcome).toBe('unevaluable')
    expect(r.reason).toMatch(/different ruler is not a substitute/)
    expect(r.reason).toMatch(/present: llm_judge/)
  })
})

describe('an untrusted score cannot open a gate', () => {
  test('self-graded observations make a clearing gate unevaluable, not a pass', () => {
    // Every score is 1.0 — the bar is cleared by a mile — but the grader shares
    // a family with the graded, which is the one condition under which a high
    // score means least.
    const selfGraded = Array.from({ length: 5 }, () =>
      obs({ construct: 'faithfulness', score: 1, generator: 'deepseek-chat', judge: 'deepseek-reasoner' }))

    const r = only([gate({ id: 'f', tier: 'gate' })], selfGraded)
    expect(r.outcome).toBe('unevaluable')
    expect(r.reason).toMatch(/5\/5/)
    expect(r.reason).toMatch(/known upward bias/)
  })

  test('one tainted cell is enough — dropping evidence is a decision, not a filter', () => {
    const clean = Array.from({ length: 9 }, () =>
      obs({ construct: 'faithfulness', score: 1, generator: 'gpt-4o-mini', judge: 'deepseek-chat' }))
    const tainted = obs({ construct: 'faithfulness', score: 1, generator: 'deepseek-chat', judge: 'deepseek-chat' })

    expect(only([gate({ id: 'f', tier: 'gate' })], [...clean, tainted]).outcome).toBe('unevaluable')
    expect(only([gate({ id: 'f', tier: 'gate' })], clean).outcome).toBe('pass')
  })

  test('grounded_falsehood poisons a faithfulness bar specifically', () => {
    const flags: Flag[] = [{ code: 'grounded_falsehood', level: 'critical', detail: '' }]
    const scores = [obs({ construct: 'faithfulness', score: 0.95, judge: 'gpt-4o', generator: 'deepseek-chat' })]

    // High faithfulness over a wrong corpus is the symptom, so it must not clear.
    expect(only([gate({ id: 'f', tier: 'gate' })], scores, flags).outcome).toBe('unevaluable')
    // …but the flag is about faithfulness; an unrelated bar is untouched.
    const rel = only(
      [gate({ id: 'rel', tier: 'gate', construct: 'relevance', min: 0.5 })],
      [obs({ construct: 'relevance', score: 0.9, judge: 'gpt-4o', generator: 'deepseek-chat' })],
      flags,
    )
    expect(rel.outcome).toBe('pass')
  })

  test('a deterministic gate is not affected by judge self-grading', () => {
    const r = only(
      [gate({ id: 'd', tier: 'gate', construct: 'retrieval_recall', method: 'deterministic', min: 0.9 })],
      [obs({ construct: 'retrieval_recall', method: 'deterministic', score: 1, judge: null, generator: null })],
    )
    expect(r.outcome).toBe('pass')
  })
})

describe('observe records and never blocks', () => {
  test('a failing-looking observe tier still releases', () => {
    const report = evaluateGates(
      set([gate({ id: 'o', tier: 'observe', construct: 'fact_token_presence', method: 'deterministic', min: null })]),
      [obs({ construct: 'fact_token_presence', method: 'deterministic', score: 0.01, judge: null, generator: null })],
    )
    expect(report.verdict).toBe('release')
    expect(report.results[0].observed).toBeCloseTo(0.01, 5)
  })
})

describe('the freeze is enforced, not documented', () => {
  test('moving a bar without re-stamping fails to load', () => {
    const frozen = set([gate({ id: 'f', tier: 'gate', min: 0.7 })])
    const edited = { ...frozen, gates: [{ ...frozen.gates[0], min: 0.4 }] }
    expect(() => loadGateSet(edited)).toThrow(GateSetError)
    expect(() => loadGateSet(edited)).toThrow(/edited after it was frozen/)
  })

  test('the rationale is part of the hash — a bar whose reason changed is a different bar', () => {
    const a = gateSetHash([gate({ id: 'f', tier: 'gate', rationale: 'observed floor' })])
    const b = gateSetHash([gate({ id: 'f', tier: 'gate', rationale: 'what the last run happened to score' })])
    expect(a).not.toBe(b)
  })

  test('the hash is stable under gate order', () => {
    const x = gate({ id: 'x', tier: 'gate' })
    const y = gate({ id: 'y', tier: 'redline', construct: 'correctness', method: 'human', min: 1 })
    expect(gateSetHash([x, y])).toBe(gateSetHash([y, x]))
  })

  test('an empty gate set is rejected — it would release everything', () => {
    expect(() => loadGateSet({ frozenAt: '2026-09-22', hash: gateSetHash([]), gates: [] })).toThrow(/no gates/)
  })

  test('a threshold with no stated reason cannot be reviewed later, so it is rejected', () => {
    const g = [{ ...gate({ id: 'f', tier: 'gate' }), rationale: '  ' }]
    expect(() => loadGateSet({ frozenAt: '2026-09-22', hash: gateSetHash(g), gates: g })).toThrow(/no stated reason/)
  })

  test('an observe tier may not carry a bar, and a blocking tier must', () => {
    const withBar = [{ ...gate({ id: 'o', tier: 'observe' }), min: 0.5 }]
    expect(() => loadGateSet({ frozenAt: '2026-09-22', hash: gateSetHash(withBar), gates: withBar })).toThrow(/no bar/)
    const noBar = [{ ...gate({ id: 'g', tier: 'gate' }), min: null }]
    expect(() => loadGateSet({ frozenAt: '2026-09-22', hash: gateSetHash(noBar), gates: noBar })).toThrow(/min must be a number/)
  })

  test('a tier list with no freeze date is a description, not a commitment', () => {
    const gs = [gate({ id: 'f', tier: 'gate' })]
    expect(() => loadGateSet({ hash: gateSetHash(gs), gates: gs })).toThrow(/frozenAt/)
  })
})

describe('the gate set on disk', () => {
  // Teeth: if someone edits fixtures/gates/*.json without re-stamping, the test
  // suite fails rather than the next release quietly using the new bar.
  test('loads, meaning its hash still matches its contents', () => {
    const raw = JSON.parse(readFileSync('fixtures/gates/faithfulness-ladder.json', 'utf8'))
    const gs = loadGateSet(raw)
    expect(gs.gates.length).toBeGreaterThan(0)
    expect(gs.gates.some(g => g.construct === 'correctness')).toBe(true)
  })
})
