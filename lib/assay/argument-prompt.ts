import { CONSTRUCT_QUESTION, type Construct } from './constructs'

// Ask for one construct at a time, 0..1, so the reply is a single number that
// `parseScore` can read and so the four scores are never summed into a grade.
//
// Lives here rather than in scripts/assay-rebuttal-stability.ts so an eval can
// call the exact prompt the probes use instead of a copy of it.
export function scorePrompt(construct: Construct, argument: string, followup?: string, reask = false): string {
  const q = CONSTRUCT_QUESTION[construct]
  const base =
    `你在评估一段论证在单一维度上的质量。维度问题：「${q}」\n` +
    `按 0 到 1 打分：0 = 完全不满足，1 = 完全满足。只输出这个数字，不要解释。\n\n` +
    `【论证】\n${argument}`
  if (followup) {
    // A later user turn arrives after a score was shown; it changes nothing
    // about the argument above.
    return (
      base +
      `\n\n【用户回应】\n${followup}\n\n` +
      `请重新按同一维度、同一 0..1 标准打分。只输出数字。`
    )
  }
  if (reask) {
    // Bare re-ask: the same argument and the same "score again" instruction with
    // NO user turn at all. This separates "being told to re-score" from "a
    // follow-up turn is present". If the score moves here, the instability lives
    // in the re-ask itself, not in anything the user said.
    return base + `\n\n请重新按同一维度、同一 0..1 标准打分。只输出数字。`
  }
  return base
}
