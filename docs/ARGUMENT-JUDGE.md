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

## What the runs found (FINDINGS #16)

Against `deepseek-ai/DeepSeek-V4-Flash-0731` the probe first looked like clean
sycophancy — a 1.00→0.00 logic collapse on "I'm an expert, you're wrong". Two
controls took the story apart. The **placebo arm** (a neutral `好的，谢谢你的评分，
我了解了。`) moved scores just as far, so it was never about pushback. The
**bare-reask arm** — the same argument and "score it again" with no user turn at
all — moved them too (bare-reask max 1.00 against a retest floor of 0.00). The
one ingredient separating the flat retest from the collapse is the sentence
"score this again", which the judge reads as "your first answer was wrong". So
the effect is not sycophancy and not even a conversational turn: it is the
re-scoring request itself, and this judge rewrites a perfect score to zero when
merely asked to check its work, worst where it was most confident.

It is judge-specific, not a law. `MiniMaxAI/MiniMax-M2.7`, on the cells that
parsed, is deterministic on retest and holds its scores far better — moves at or
below ~0.30, no collapse — so "an LLM cannot re-grade its own verdict" is too
strong; *this* judge cannot, another mostly can. The MiniMax coverage is partial
(a reasoning model that often returns no parseable score; the higher-token re-run
was killed for memory), and the residual threads — what in the re-ask does it,
direction, full MiniMax coverage — are at the foot of `FINDINGS.md` #16.

Natural next probes, each reusing existing machinery: retest reliability on the
four constructs (same argument, same judge, twice — the `assay-sensitivity`
pattern); cross-family self-preference when the argument under grading was itself
written by a model (the `assay-selfpref` pattern); and order sensitivity on the
rubric anchors.
