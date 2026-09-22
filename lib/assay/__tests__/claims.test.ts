import {
  blockTitles, claimUserMessage, derivedScore, localisation,
  parseClaimReport, ClaimParseError, type ClaimReport,
} from '../claims'

const BLOCKS = ['现货交易手续费', '合约交易手续费', '提币费用']

const reply = (findings: unknown) => JSON.stringify({ findings })

describe('the closed label set', () => {
  test('block titles are read out of the context, not invented by the caller', () => {
    const ctx = '\n\nRelevant knowledge base context:\n【现货交易手续费】\nmaker = taker = 0.1%\n\n【提币费用】\n固定 0.0005 BTC'
    expect(blockTitles(ctx)).toEqual(['现货交易手续费', '提币费用'])
  })

  test('the prompt hands the judge the allowed titles', () => {
    const msg = claimUserMessage('【提币费用】\n固定 0.0005 BTC', 'withdrawal costs 0.0005 BTC')
    expect(msg).toContain('"提币费用"')
    expect(msg).toContain('or null')
  })

  test('with no context, the prompt says so rather than pretending there is one', () => {
    const msg = claimUserMessage(null, 'anything')
    expect(msg).toContain('There is no context')
    expect(msg).toContain('"block" must be null')
  })

  test('a block the context does not contain is a parse failure, not a finding', () => {
    // A judge that names a block which is not there has localised nothing; if
    // this were accepted it would be counted as `located` by localisation().
    const raw = reply([{ claim: 'fees are 0.1%', verdict: 'contradicted', block: '保证金规则', quote: null }])
    expect(() => parseClaimReport(raw, BLOCKS)).toThrow(/not in the context/)
  })
})

describe('no defaults — FINDINGS #4 at a new level', () => {
  // The scalar parser learned that `|| 0` turns "could not measure" into a
  // confident wrong number. The structured version's tempting default is
  // "supported", which reads as a clean run, so every one of these throws.

  test('a missing verdict does not become `supported`', () => {
    const raw = reply([{ claim: 'fees are 0.1%', block: null, quote: null }])
    expect(() => parseClaimReport(raw, BLOCKS)).toThrow(ClaimParseError)
    expect(() => parseClaimReport(raw, BLOCKS)).toThrow(/verdict undefined/)
  })

  test('a verdict outside the closed set is rejected rather than coerced', () => {
    const raw = reply([{ claim: 'x', verdict: 'partially supported', block: null, quote: null }])
    expect(() => parseClaimReport(raw, BLOCKS)).toThrow(/not one of supported \| contradicted \| unsupported/)
  })

  test('an empty findings list is a failure, not a clean bill of health', () => {
    expect(() => parseClaimReport(reply([]), BLOCKS)).toThrow(/no claim was assessed/)
  })

  test('a claim with no text is rejected', () => {
    expect(() => parseClaimReport(reply([{ claim: '   ', verdict: 'supported', block: null, quote: null }]), BLOCKS))
      .toThrow(/no claim text/)
  })

  test('a reply with no JSON at all throws instead of returning nothing found', () => {
    expect(() => parseClaimReport('The answer looks fine to me.', BLOCKS)).toThrow(/no JSON object/)
  })

  test('a truncated JSON span throws rather than yielding a partial report', () => {
    expect(() => parseClaimReport('{"findings":[{"claim":"x","verdict":', BLOCKS)).toThrow(/no JSON object/)
  })
})

describe('reading the reply models actually send', () => {
  test('fenced JSON with prose around it', () => {
    const raw = 'Here is my assessment:\n```json\n' +
      reply([{ claim: 'spot fee is 0.1%', verdict: 'supported', block: '现货交易手续费', quote: 'maker = taker = 0.1%' }]) +
      '\n```\nLet me know if you need more.'
    const r = parseClaimReport(raw, BLOCKS)
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0].quote).toBe('maker = taker = 0.1%')
  })

  test('reasoning is stripped, and digits inside it cannot leak into the report', () => {
    const raw = '<think>the fee might be 0.3% so maybe contradicted</think>' +
      reply([{ claim: 'spot fee is 0.1%', verdict: 'supported', block: null, quote: null }])
    expect(parseClaimReport(raw, BLOCKS).findings[0].verdict).toBe('supported')
  })

  test('an unclosed <think> is a truncated reply, not a report', () => {
    expect(() => parseClaimReport('<think>{"findings":[{"claim":"x"', BLOCKS)).toThrow(/no JSON object/)
  })

  test('a brace inside a quoted claim does not cut the object short', () => {
    const raw = reply([
      { claim: 'the config {maker:0.1} is stated', verdict: 'supported', block: '现货交易手续费', quote: null },
      { claim: 'withdrawal is free', verdict: 'contradicted', block: '提币费用', quote: '固定 0.0005 BTC' },
    ])
    expect(parseClaimReport(raw, BLOCKS).findings).toHaveLength(2)
  })

  test('empty string and null are the same absence for block and quote', () => {
    const r = parseClaimReport(reply([{ claim: 'x', verdict: 'unsupported', block: '', quote: '' }]), BLOCKS)
    expect(r.findings[0].block).toBeNull()
    expect(r.findings[0].quote).toBeNull()
  })
})

describe('localisation: the distinction FINDINGS #22 could not make', () => {
  const report = (fs: { verdict: string; block: string | null }[]): ClaimReport =>
    parseClaimReport(reply(fs.map((f, i) => ({ claim: `c${i}`, ...f, quote: null }))), BLOCKS)

  test('named the tampered block → located', () => {
    const r = report([
      { verdict: 'supported', block: '提币费用' },
      { verdict: 'contradicted', block: '现货交易手续费' },
    ])
    expect(localisation(r, '现货交易手续费')).toBe('located')
  })

  test('flagged something, but not there → felt', () => {
    // This is the case a ladder of scalars cannot distinguish from `located`:
    // the score drops either way.
    const r = report([
      { verdict: 'contradicted', block: '提币费用' },
      { verdict: 'unsupported', block: null },
    ])
    expect(localisation(r, '现货交易手续费')).toBe('felt')
  })

  test('everything supported → missed', () => {
    const r = report([
      { verdict: 'supported', block: '现货交易手续费' },
      { verdict: 'supported', block: '提币费用' },
    ])
    expect(localisation(r, '现货交易手续费')).toBe('missed')
  })

  test('`unsupported` on the tampered block counts as located — silence and conflict are both reactions to the edit', () => {
    const r = report([{ verdict: 'unsupported', block: '现货交易手续费' }])
    expect(localisation(r, '现货交易手续费')).toBe('located')
  })
})

describe('derivedScore is a different measurement from the scalar prompt', () => {
  test('it counts verdicts over a denominator the judge chose', () => {
    const r = parseClaimReport(reply([
      { claim: 'a', verdict: 'supported', block: null, quote: null },
      { claim: 'b', verdict: 'supported', block: null, quote: null },
      { claim: 'c', verdict: 'contradicted', block: null, quote: null },
      { claim: 'd', verdict: 'unsupported', block: null, quote: null },
    ]), BLOCKS)
    expect(derivedScore(r)).toBeCloseTo(0.5, 5) // 2 of 4, verifiable by hand
  })

  test('the same answer split more finely yields a different number — which is why it is not the scalar', () => {
    const coarse = parseClaimReport(reply([
      { claim: 'fees and limits are as stated', verdict: 'supported', block: null, quote: null },
      { claim: 'withdrawal is free', verdict: 'contradicted', block: null, quote: null },
    ]), BLOCKS)
    const fine = parseClaimReport(reply([
      { claim: 'maker fee is 0.1%', verdict: 'supported', block: null, quote: null },
      { claim: 'taker fee is 0.1%', verdict: 'supported', block: null, quote: null },
      { claim: 'the daily limit is 100 BTC', verdict: 'supported', block: null, quote: null },
      { claim: 'withdrawal is free', verdict: 'contradicted', block: null, quote: null },
    ]), BLOCKS)
    expect(derivedScore(coarse)).toBeCloseTo(0.5, 5)
    expect(derivedScore(fine)).toBeCloseTo(0.75, 5)
    expect(derivedScore(coarse)).not.toBeCloseTo(derivedScore(fine), 2)
  })
})
