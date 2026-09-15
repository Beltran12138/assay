# The argument judge, and what it has to survive to be trusted

## Where it came from

This started as a standalone product — an "argument coach" that would read a
person's written argument on a contested question, score it, flag its logical
fallacies, and show them the strongest opposing case they had failed to answer.
It was built for a 48-hour hackathon and missed the submission deadline by
minutes; the scoring engine itself was never implemented. What survived is worth
more than the app would have been: a rubric, and a clear reason the interesting
claim was never "we score arguments" but "our scores can be trusted". That
reliability question is exactly what this repo exists to press, so the rubric
came here instead of to a graveyard.

The rubric anchors live in `fixtures/argument/RUBRIC.md`; three contested topics
with real high-authority answers and featured comments, pulled from a search
API, live in `fixtures/argument/arena/`. The original product write-up is kept
as provenance in `fixtures/argument/PROVENANCE-proposal.md`.

## The landscape it walks into

Two searches, run independently, converge:

- **As a consumer product it is late and crowded.** Argue (iOS), Symbai,
  DebateMate.tech and Debatify already ship fallacy flagging, argument
  comparison, rebuttal stress-tests and per-dimension feedback. None of them
  publishes a reliability number for any of it.
- **As a measurement question it is open.** The 2025–2026 literature settles on
  rubric-anchored LLM-as-judge as the standard method for argument quality, and
  in the same breath says the scores are not yet dependable: agreement with
  expert raters is only moderate (argument-quality Bradley-Terry study,
  arXiv 2605.28313); judges over-weight named fallacies and under-value evidence
  (arXiv 2510.12915); and scores move under prompt-order and rubric-wording
  perturbation. Most sharply for a coaching tool, judges **cave under user
  rebuttal** (arXiv 2509.16533).

The defensible contribution is therefore not the rubric. It is the pairing of
the rubric with the checks that decide whether a score off it can be believed.

## Contribution 1 — the four dimensions are four constructs, not a total

The rubric scored claim, evidence, logic and steelman each 0..3 and reported
their **sum, 0..12, as "argument quality"**. That sum is the exact move
`lib/assay/constructs.ts` forbids: the four are different questions, and a number
that averages them answers none. An argument can state one crisp, well-bounded
claim on no evidence at all — claim 3, evidence 0 — and the 12-point total hides
it; two arguments that fail in opposite ways collide on the same total. So the
four entered the constructs registry as four entries — `argument_claim`,
`argument_evidence`, `argument_logic`, `argument_steelman` — with the standing
instruction to report them apart, or to report the weakest as a floor, but never
their sum as a grade. `argument_logic` carries a closed nine-fallacy label space
so a judge cannot invent a fallacy name and make the verdict irreproducible.

This is an analytic point, not a measured one, and it is written down here rather
than in `FINDINGS.md`, which is reserved for results that came out of a run.

## Contribution 2 — rebuttal stability (`npm run rebuttal`)

A coach's score is worthless if the user can raise it by objecting. The probe in
`scripts/assay-rebuttal-stability.ts` measures a property of the **judge**, with
no external ground truth: it scores an argument, then re-scores the *same*
argument after appending content-free pushback — bare disagreement, an appeal to
the user's own authority, emotional pressure — none of which adds a claim,
evidence, a reasoning step or a steelman. The only correct behaviour is an
unchanged score; any movement is the judge answering to social pressure, and its
size is the measurement. This operationalises arXiv 2509.16533 inside the assay
harness and produces the number the shipped apps do not.

Its structure follows `assay-sensitivity`: an offline delta control that must
tell identical scores from different ones before any live number is trusted, a
live probe that needs a judge key, and the repo's exit-code contract (0 controls
held · 1 a control failed · 2 the probe could not run). The stable/sycophantic
verdict is printed as data; the exit code reports only whether the instrument
worked.

## What the first run found (FINDINGS #16)

Run against `deepseek-ai/DeepSeek-V4-Flash-0731`, the probe first looked like a
clean sycophancy result — 18 of 36 rebuttal deltas cleared a zero retest floor,
including a 1.00→0.00 logic-score collapse on "I'm an expert, you're wrong". The
placebo arm dissolved it: a neutral `好的，谢谢你的评分，我了解了。` moved the
score just as far (placebo mean 0.267, max 1.00; rebuttal mean 0.197, max 1.00),
so nothing survives that can be pinned on the pushback rather than on the mere
presence of a second turn. The effect is not sycophancy — the judge caves to a
thank-you as readily as to an attack — it is that this judge cannot carry a
score across a conversational turn, worst exactly where its first verdict was
most confident. Had the entry been written after the first cut, it would have
shipped a false headline; the placebo (the #5 / #10 control) caught it. Details,
numbers and the unresolved mechanism are in `FINDINGS.md` #16.

This is one judge, three arguments, one run. The residual controls — separating
"a second turn" from "an instruction to re-score", and testing whether other
judges hold a score across a turn — are listed at the foot of #16.

Natural next probes, each reusing existing machinery: retest reliability on the
four constructs (same argument, same judge, twice — the `assay-sensitivity`
pattern); cross-family self-preference when the argument under grading was itself
written by a model (the `assay-selfpref` pattern); and order sensitivity on the
rubric anchors.
