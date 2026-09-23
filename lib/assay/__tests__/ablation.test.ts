import { readFileSync, readdirSync, existsSync } from 'fs'
import {
  ablateTarget, auditContradictions, findTargetBlock, parseBlocks,
  EXPECTED_VERDICT, type ContradictionEntry,
} from '../ablation'
import { blockTitles, CLAIM_VERDICTS } from '../claims'

const CTX =
  '\n\nRelevant knowledge base context:\n' +
  '【现货交易手续费】\nmaker = taker = 0.1%\n常見追問：有折扣吗？\n\n' +
  '【提币操作步骤】\n在资产页点击提币，选择网络后提交。\n常見追問：要多久？\n\n' +
  '【提币到账时间】\n提币处理时间通常为1–2个工作日。\n常見追問：能加急吗？'

const FILLER = '【春季播种】\n番茄适宜在土温稳定在12度以上时移栽。\n常見追問：什么时候搭架？'

describe('block parsing', () => {
  test('header and titled blocks come apart', () => {
    const { header, blocks } = parseBlocks(CTX)
    expect(header).toContain('Relevant knowledge base context')
    expect(header).not.toContain('【')
    expect(blocks.map(b => b.title)).toEqual(['现货交易手续费', '提币操作步骤', '提币到账时间'])
  })

  test('titles agree with the closed label set the judge is handed', () => {
    // If these two disagreed, a judge could name a block the parser accepts and
    // the ablation cannot find, or the reverse.
    expect(parseBlocks(CTX).blocks.map(b => b.title)).toEqual(blockTitles(CTX))
  })

  test('a context with no blocks is all header, not an empty context', () => {
    const { header, blocks } = parseBlocks('just prose, no brackets')
    expect(header).toBe('just prose, no brackets')
    expect(blocks).toEqual([])
  })
})

describe('the target block is where the edit lands, not where `match` points', () => {
  // The bug this module exists to make impossible. `match` identifies the
  // context; `find` identifies the fact. In the withdrawal context they are in
  // different blocks, and FINDINGS #23 scored localisation against the former.
  test('find in a different block than the matcher resolves to the block holding find', () => {
    expect(findTargetBlock(CTX, '提币处理时间通常为1–2个工作日')!.title).toBe('提币到账时间')
    expect(findTargetBlock(CTX, '【提币操作步骤】')!.title).toBe('提币操作步骤')
  })

  test('a needle in no block is null, not the first block', () => {
    expect(findTargetBlock(CTX, '这段文字不存在')).toBeNull()
  })
})

describe('ablateTarget', () => {
  test('removes the block carrying the fact and keeps the rest verbatim', () => {
    const out = ablateTarget(CTX, '提币处理时间通常为1–2个工作日', FILLER)!
    expect(out).not.toContain('1–2个工作日')
    expect(out).not.toContain('提币到账时间')
    expect(out).toContain('maker = taker = 0.1%')
    expect(out).toContain('在资产页点击提币')
  })

  test('block count and the header are held, so length is not the variable', () => {
    const out = ablateTarget(CTX, '提币处理时间通常为1–2个工作日', FILLER)!
    expect(blockTitles(out)).toHaveLength(blockTitles(CTX).length)
    expect(out.startsWith(parseBlocks(CTX).header)).toBe(true)
  })

  test('the removed title leaves the closed label set, so naming it is a parse failure', () => {
    // This is what makes `located` undefined on the rung, and it has to be true
    // for the run to be readable rather than quietly scored as a miss.
    const out = ablateTarget(CTX, '提币处理时间通常为1–2个工作日', FILLER)!
    expect(blockTitles(out)).not.toContain('提币到账时间')
    expect(blockTitles(out)).toContain('春季播种')
  })

  test('a fact the context does not contain ablates nothing', () => {
    expect(ablateTarget(CTX, '不存在的事实', FILLER)).toBeNull()
  })
})

describe('the fixture audit catches what prose asserted and nothing tested', () => {
  const clean: ContradictionEntry = {
    match: '【提币操作步骤】', find: '提币处理时间通常为1–2个工作日',
    replace: '提币处理时间通常为7–10个工作日', cite: '1–2',
  }

  test('a fixture that satisfies all five properties reports nothing', () => {
    expect(auditContradictions([CTX], [clean])).toEqual([])
  })

  test('a `find` that occurs twice is caught, because .replace() only rewrites the first', () => {
    const doubled = CTX + '\n\n【重复】\n提币处理时间通常为1–2个工作日。\n常見追問：真的吗？'
    const codes = auditContradictions([doubled], [clean]).map(i => i.code)
    expect(codes).toContain('find_not_unique')
  })

  test('a `match` hitting two contexts is caught, because the ground truth then goes to whichever is first', () => {
    const codes = auditContradictions([CTX, CTX + '\n'], [clean]).map(i => i.code)
    expect(codes).toContain('match_not_unique')
  })

  test('a `match` hitting nothing is caught and does not go on to report phantom find errors', () => {
    const orphan = { ...clean, match: '【不存在的块】' }
    const issues = auditContradictions([CTX], [orphan])
    expect(issues.map(i => i.code)).toEqual(['match_not_unique'])
  })

  test('a `cite` outside `find` is caught, because breaking find then leaves the cited token alone', () => {
    const codes = auditContradictions([CTX], [{ ...clean, cite: '在资产页' }]).map(i => i.code)
    expect(codes).toContain('cite_outside_find')
  })

  test('a `cite` duplicated outside the target block is caught — the leak the rung would not survive', () => {
    // 1–2 now also appears in an untouched block, so contradicting the target
    // leaves the claim supported and a judge that says so is right.
    const leaky = CTX + '\n\n【费率说明】\n阶梯为1–2档。\n常見追問：怎么升档？'
    const issues = auditContradictions([leaky], [clean])
    expect(issues.map(i => i.code)).toContain('cite_leaks')
    expect(issues.find(i => i.code === 'cite_leaks')!.detail).toContain('outside')
  })

  test('mutation check: a substring audit cannot see a paraphrase, and the header says so', () => {
    // Guards the documented coverage limit. If someone strengthens the check to
    // semantic matching this test should be rewritten, not deleted — silently
    // passing here while claiming paraphrase coverage is the failure mode.
    const paraphrased = CTX + '\n\n【另一说法】\n提币一般一到两个工作日到账。\n常見追問：节假日呢？'
    expect(auditContradictions([paraphrased], [clean])).toEqual([])
  })
})

describe('the three rungs cover the three verdicts', () => {
  test('every ClaimVerdict is the ground truth of exactly one rung', () => {
    // The whole justification for the rung. If a verdict had no rung, the
    // instruction "do not merge these" would still have no observable.
    expect(new Set(Object.values(EXPECTED_VERDICT))).toEqual(new Set(CLAIM_VERDICTS))
    expect(Object.values(EXPECTED_VERDICT)).toHaveLength(CLAIM_VERDICTS.length)
  })
})

// ─── against the real fixture, not a hand-written one ────────────────────────
//
// The unit tests above prove the audit can fire. This proves the shipped fixture
// passes it — which is the claim FINDINGS relies on, and it has to be checked
// against the file on disk rather than a copy that can drift from it.

const FIXTURE = 'fixtures/contradictions.json'
const ANSWERS = 'fixtures/answers'
const haveFixture = existsSync(FIXTURE) && existsSync(ANSWERS)
const maybe = haveFixture ? describe : describe.skip

maybe('the shipped fixture', () => {
  const entries: ContradictionEntry[] = JSON.parse(readFileSync(FIXTURE, 'utf8')).contradictions
  const contexts = [...new Set(
    readdirSync(ANSWERS).filter(f => f.endsWith('.json')).flatMap(f =>
      (JSON.parse(readFileSync(`${ANSWERS}/${f}`, 'utf8')).answers as { context: string; answer: string }[])
        .filter(a => a.answer).map(a => a.context)),
  )]

  test('passes the audit', () => {
    expect(auditContradictions(contexts, entries)).toEqual([])
  })

  test('every entry has a resolvable target block', () => {
    for (const e of entries) {
      const ctx = contexts.find(c => c.includes(e.match))!
      expect(findTargetBlock(ctx, e.find)).not.toBeNull()
    }
  })

  test('🔴 one entry edits a block other than the one `match` names', () => {
    // Not a defect to fix in the fixture — `match` only has to identify the
    // context. It is pinned here because FINDINGS #23 derived its ground truth
    // from `match`, and this is the case that made that wrong. If a future edit
    // makes every entry self-consistent, this test should be updated with a
    // note, not quietly relaxed: the point is that the two fields are allowed to
    // differ and the code must not assume otherwise.
    const differing = entries.filter(e => {
      const ctx = contexts.find(c => c.includes(e.match))!
      return findTargetBlock(ctx, e.find)!.title !== e.match.replace(/[【】]/g, '')
    })
    expect(differing.map(e => e.match)).toEqual(['【提币操作步骤】'])
  })

  test('every context can be ablated, and loses its target fact when it is', () => {
    for (const e of entries) {
      const ctx = contexts.find(c => c.includes(e.match))!
      const out = ablateTarget(ctx, e.find, FILLER)
      expect(out).not.toBeNull()
      expect(out).not.toContain(e.find)
      // The audit proved `cite` lives only in the target block, so ablation must
      // take it with the block. This is the assertion that makes the rung's
      // ground truth — "unsupported" — true rather than assumed.
      expect(out).not.toContain(e.cite)
    }
  })
})
