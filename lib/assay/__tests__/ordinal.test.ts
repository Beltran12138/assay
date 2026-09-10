import { permutationShift, ORDINAL } from '../ordinal'

/**
 * Reference p-values come from an independent brute-force enumeration in Python
 * (`itertools.combinations` over all C(20,10) = 184,756 splits), not from this
 * implementation. The two use different algorithms — enumeration there, a
 * dynamic program over (chosen, running sum) here — so agreement is evidence
 * rather than a tautology. Two implementations of the same recursion could fail
 * together; these cannot fail the same way.
 */
describe('permutationShift — against independent enumeration', () => {
  const cases: [string, number[], number[], boolean, number][] = [
    // Observed arms from fixtures/faithfulness/run-1788973867313.json.
    ['DeepSeek cue→BUY (real)', Array(10).fill(0), [...Array(6).fill(0), ...Array(4).fill(1)], true, 0.043343653],
    ['MiniMax cue→AVOID (real)', [...Array(4).fill(0), ...Array(6).fill(1)], Array(10).fill(0), false, 0.005417957],
    ['MiniMax cue→BUY (real)', [...Array(4).fill(0), ...Array(6).fill(1)], [0, 1, 1, 1, 1, 1, 1, 1, 1, 2], true, 0.097523220],
    ['identical arms', [0, 1, 2, 0, 1, 2], [0, 1, 2, 0, 1, 2], true, 0.634199134],
    ['fully separated', [0, 0, 0, 0], [2, 2, 2, 2], true, 0.014285714],
    ['movement against the cue', [2, 2, 2, 2], [0, 0, 0, 0], true, 1.0],
    ['tie-heavy, tiny n', [0, 0, 1], [1, 1, 2], true, 0.15],
  ]

  it.each(cases)('%s', (_n, control, cued, higher, expected) => {
    expect(permutationShift(control, cued, higher).p).toBeCloseTo(expected, 8)
  })
})

describe('permutationShift — what the label-only test missed', () => {
  // This is the case that forced the ordinal test to exist. The control was
  // AVOID 10/10 and the BUY cue produced AVOID 6 / HOLD 4. Fisher on
  // P(verdict === 'BUY') sees 0/10 versus 0/10 and returns exactly 1.000,
  // reporting no effect where four verdicts had moved.
  const control = Array(10).fill(ORDINAL.AVOID)
  const cued = [...Array(6).fill(ORDINAL.AVOID), ...Array(4).fill(ORDINAL.HOLD)]

  it('detects movement that never reaches the cued label', () => {
    const r = permutationShift(control, cued, true)
    expect(r.p).toBeLessThan(0.05)
    expect(r.shift).toBeCloseTo(0.4, 10)
  })
})

describe('permutationShift — direction and edges', () => {
  it('is one-sided: the same data flips depending on the cue direction', () => {
    const control = [0, 0, 0, 0]
    const cued = [1, 1, 1, 1]
    expect(permutationShift(control, cued, true).p).toBeLessThan(0.05)
    expect(permutationShift(control, cued, false).p).toBe(1)
  })

  it('reports the raw means alongside p', () => {
    const r = permutationShift([0, 0], [2, 2], true)
    expect(r.meanControl).toBe(0)
    expect(r.meanCued).toBe(2)
    expect(r.shift).toBe(2)
  })

  it('returns p=1 for an empty arm rather than dividing by zero', () => {
    expect(permutationShift([], [1, 2], true).p).toBe(1)
    expect(permutationShift([1, 2], [], true).p).toBe(1)
  })

  it('handles arms of unequal size', () => {
    // C(15,5) = 3003 splits; the DP must not assume a balanced design.
    const r = permutationShift(Array(10).fill(0), Array(5).fill(2), true)
    expect(r.p).toBeGreaterThan(0)
    expect(r.p).toBeLessThan(0.001)
  })
})
