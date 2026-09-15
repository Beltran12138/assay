// Constructs — what a score is actually measuring.
//
// The central rule: two scores may only be aggregated when they answer the
// same question. Averaging faithfulness with correctness produces a number
// that answers no question at all.

export type Construct =
  | 'faithfulness'         // did the answer stay inside the retrieved context?
  | 'correctness'          // is the answer true about the world?
  | 'fact_token_presence'  // do the required strings literally appear?
  | 'relevance'            // does the answer address what was asked?
  | 'retrieval_recall'     // did retrieval surface the context needed to answer?
  | 'policy_adherence'     // did the agent obey the operator's written rules?
  | 'argument_claim'       // is the argument's central claim single and bounded?
  | 'argument_evidence'    // is that claim backed by relevant, checkable evidence?
  | 'argument_logic'       // is the reasoning free of the closed-set fallacies?
  | 'argument_steelman'    // does it engage the strongest opposing case, not a straw man?

export const CONSTRUCTS: Construct[] = [
  'faithfulness',
  'correctness',
  'fact_token_presence',
  'relevance',
  'retrieval_recall',
  'policy_adherence',
  'argument_claim',
  'argument_evidence',
  'argument_logic',
  'argument_steelman',
]

// Prose used in reports. Written so that a reader who has never seen this
// codebase can tell why two constructs are not interchangeable.
export const CONSTRUCT_QUESTION: Record<Construct, string> = {
  faithfulness:        'Did the answer stay inside the retrieved context?',
  correctness:         'Is the answer true?',
  fact_token_presence: 'Do the required strings literally appear in the answer?',
  relevance:           'Does the answer address the question that was asked?',
  retrieval_recall:    'Did retrieval surface the context needed to answer?',
  policy_adherence:    'Did the agent obey the written operator policy?',
  argument_claim:      'Is the central claim single, clear, and bounded by its conditions?',
  argument_evidence:   'Is the claim backed by relevant, checkable evidence rather than assertion?',
  argument_logic:      'Is the reasoning free of the nine closed-set fallacies?',
  argument_steelman:   'Does it answer the strongest opposing case rather than a straw man?',
}

// ─── The four argument constructs are not a rubric total ─────────────────────
//
// They arrived together, from a rubric that scored a written argument on claim,
// evidence, logic and steelman — each 0..3 — and then reported their sum as a
// single 0..12 "argument quality". That sum is exactly the move this file's
// central rule forbids: claim clarity, evidence quality, logical validity and
// engagement with the opposition are four different questions, and a number
// that averages them answers none of them. An argument can state one crisp,
// well-bounded claim (claim = 3) on no evidence at all (evidence = 0); the 12-
// point total buries that, and two arguments that fail in opposite ways can
// land on the same total. Report the four separately, or report the weakest of
// the four as a floor — never their sum as a grade.
//
// `argument_logic` has a fixed label space, deliberately closed so a judge
// cannot invent a fallacy name and make the result irreproducible. The nine:
//   滑坡 · 稻草人 · 诉诸情感 · 诉诸权威 · 以偏概全 · 循环论证 · 虚假两难 · 偷换概念 · 因果倒置
// (slippery-slope, straw-man, appeal-to-emotion, appeal-to-authority, hasty-
// generalisation, circular, false-dilemma, equivocation, reversed-causation).
// See fixtures/argument/RUBRIC.md for the anchors and docs/ARGUMENT-JUDGE.md
// for where the constructs came from and what the judge must survive to be
// trusted (a coach that lowers a score because the user pushed back is not
// measuring the argument — see the rebuttal-stability probe).
export const ARGUMENT_CONSTRUCTS: Construct[] = [
  'argument_claim',
  'argument_evidence',
  'argument_logic',
  'argument_steelman',
]

export const ARGUMENT_FALLACIES = [
  '滑坡', '稻草人', '诉诸情感', '诉诸权威',
  '以偏概全', '循环论证', '虚假两难', '偷换概念', '因果倒置',
] as const

export type ArgumentFallacy = (typeof ARGUMENT_FALLACIES)[number]

// `fact_token_presence` is NOT a cheap version of `correctness` — it is a
// different question, and this repo learned that the hard way. Asked for the
// maximum leverage, the reference agent answered "100 倍杠杆"; the required
// token was "100x"; the answer was right and the score was 0.00. Adding
// synonyms narrows the gap but does not close it: a paraphrase can be correct
// with none of the expected strings, and a fabrication can contain all of them.
// Keep the two apart, and never let a token count be reported as accuracy.

// ─── Grading method ──────────────────────────────────────────────────────────
//
// Two scores can share a construct and still not be comparable, because they
// were produced by different procedures. `deterministic` compares against a
// ground truth that does not involve a language model (a database state diff,
// a string assertion). `llm_judge` asks a model. A deterministic 0.8 and a
// judged 0.8 are not the same 0.8.

export type Method = 'deterministic' | 'llm_judge' | 'human'

export type Observation = {
  construct: Construct
  method: Method
  score: number          // 0..1
  /** Model that produced the answer being graded. null for non-LLM output. */
  generator: string | null
  /** Model doing the grading. null when `method` is not `llm_judge`. */
  judge: string | null
  /** Free-text provenance — which script/dataset/case produced this. */
  source: string
  note?: string
}

// ─── Model families ──────────────────────────────────────────────────────────
//
// Self-preference is a family-level effect, not an exact-string effect: a judge
// favours its own lineage, not only its own checkpoint. Unknown models fall
// back to the raw string so that an unrecognised name is never silently
// treated as "a different family" — that would hide the bias we are looking
// for. Absent is unknown, not safe.

const FAMILY_PATTERNS: [RegExp, string][] = [
  [/^deepseek/i,                'deepseek'],
  [/^(gpt|o[134]|text-embedding|davinci)/i, 'openai'],
  [/^claude/i,                  'anthropic'],
  [/^gemini|^gemma/i,           'google'],
  [/^(qwen|qwq)/i,              'alibaba'],
  [/^(llama|codellama)/i,       'meta'],
  [/^mistral|^mixtral/i,        'mistral'],
  [/^glm|^chatglm/i,            'zhipu'],
  [/^grok/i,                    'xai'],
  [/^kimi|^moonshot/i,          'moonshot'],
  [/^minimax|^abab/i,           'minimax'],
]

/**
 * Router and hub ids arrive as `vendor/model` — `moonshotai/Kimi-K2.6`,
 * `MiniMaxAI/MiniMax-M2.7`. Matching the raw string against patterns anchored
 * with `^` silently fails on those and falls through to the identity branch,
 * where two ids from the same lineage read as two families and the
 * self-preference check goes quiet. Both segments are tried.
 */
export function modelFamily(model: string): string {
  const trimmed = model.trim()
  const slash = trimmed.indexOf('/')
  const vendor = slash > 0 ? trimmed.slice(0, slash) : null
  const bare = slash > 0 ? trimmed.slice(slash + 1) : trimmed

  for (const [pattern, family] of FAMILY_PATTERNS) {
    if (pattern.test(bare)) return family
    if (vendor && pattern.test(vendor)) return family
  }
  return bare.toLowerCase()
}

/**
 * True when the grader and the graded share a lineage. This is the condition
 * under which a reported score carries a systematic upward bias that judge
 * ensembling does not remove.
 */
export function isSelfGraded(o: Observation): boolean {
  if (o.method !== 'llm_judge') return false
  if (!o.judge || !o.generator) return false
  return modelFamily(o.judge) === modelFamily(o.generator)
}
