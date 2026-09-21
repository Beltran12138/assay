# Substitution control: does the judge use what it reads?

> Design only. Nothing here has been run. Written 2026-09-21.
>
> **This one needs no human labels.** Unlike `docs/STATED-CONFIDENCE.md`, which is
> blocked on 421 annotations, every arm below runs against answers already frozen
> on disk. It can start today.

## The question the existing controls do not ask

`npm run sensitivity` asks whether the harness can detect a *known* failure.
`npm run selfpref` asks whether judges disagree, and by how much. Both are
questions about the judge's **output**.

Neither asks the question underneath: **is the score a function of the context at
all?**

The judge prompt is explicit about what it is supposed to do —
`scripts/assay-selfpref.ts:103`:

> "You grade whether an answer stays inside its source context… whether every
> factual claim is supported by the context given."

So `faithfulness` is, by construction, a claim about a *relation between two
inputs*. If the score barely moves when one of those two inputs is replaced, the
number is not measuring that relation, whatever it correlates with.

## Where the method comes from

Borrowed, not invented: **read-time substitution**, from *Does Video Memory Use
What It Retrieves? A Causal Audit of Memory Specificity* (arXiv 2609.12090,
2026-09-10). Their framing is the part worth stealing:

> "Standard memory ablations test whether memory **helps**, but not whether the
> **retrieved content is responsible**. We test this directly with read-time
> memory substitution, which replaces the consumed memory value while leaving the
> rest of the computation unchanged. This separates **memory benefit** from
> **memory specificity**."

Their result is the reason to bother: across frozen video world models,
**identity-free controls containing no evaluation-specific content recovered
essentially the full benefit** on two of three datasets. The memory helped; the
*content* of the memory largely did not.

⚠️ Read from the abstract only, not reproduced. It motivates the design; no number
of theirs is load-bearing here.

The transplant is clean because `assay` already froze the right thing.
`scripts/assay-selfpref.ts:75` defines

```ts
type FrozenAnswer = { query: string; intent: string; context: string; answer: string }
```

and the judge sees exactly `Context:\n${a.context}\n\nAnswer:\n${a.answer}` (:136).
**Swap `a.context`, change nothing else.** The answers are already on disk in
`fixtures/answers/`, so the generator cannot drift underneath the experiment —
which is why they were frozen in the first place, for a different reason.

## Two quantities, and the second is the new one

For a judge `J`, an answer `a`, and a context `c`:

```
benefit      = J(a, c_intact) − J(a, c_empty)
specificity  = [ J(a, c_intact) − J(a, c_identity_free) ] / benefit
```

- **specificity ≈ 1** — the score depends on what the context actually says.
- **specificity ≈ 0** — the judge needed *something* in that slot, not *that*
  thing. The score is then a function of the answer plus a formatting cue.

`benefit` is what every existing ablation measures. `specificity` is the one that
decides whether `faithfulness` means what its name says.

⚠️ The ratio is undefined and unstable when `benefit ≈ 0`. Report `benefit` first;
if its interval crosses zero for a judge, that judge gets no specificity number at
all, and that is a finding, not a gap.

## The dose ladder

One step, six rungs, everything else identical. Ordered by how much of the
original content survives:

| rung | context becomes | what it holds fixed | what it destroys |
|---|---|---|---|
| `intact` | the real context | — | — |
| `shuffled` | same sentences, random order | every token, length, topic | discourse order |
| `sibling` | another query's context, **same intent** | domain, register, format, length band | the specific facts |
| `distant` | a context from a **different intent** | corpus, register, format | domain and facts |
| `identity_free` | length-matched, format-matched filler with no corpus content | "there is a context here" | all content |
| `empty` | no context block | — | everything |

Two rungs are doing specific work:

- **`shuffled` separates "reads the facts" from "reads the prose".** A judge that
  scores on discourse coherence rather than fact coverage drops here while
  `sibling` leaves it flat. Nothing in the existing suite distinguishes these.
- **`sibling` vs `distant` is the graded-dependence probe** the source paper found
  most informative (their WorldMem case: a wrong memory from the *same* trajectory
  recovered 94.1% of the benefit; from a disjoint one, 43.7%). If `sibling` ≈
  `intact` but `distant` ≪ `intact`, the judge is keying on topic, not on claims.

`identity_free` must be built carefully or it silently becomes `distant`: matched
on token count and on the bullet/section shape of real contexts, drawn from
outside the corpus, and **checked to share no content words with the answer**. If
it shares any, it is not identity-free and the run is void.

## Power, before anything runs

`fixtures/answers/` holds **3 models × 13 questions = 39 frozen answers**, and
`selfpref` already grades each with 3 judges → **117 (answer, judge) cells**, but
only 39 independent answers. Pairing is across rungs on the same cell, so the
paired-difference formula in `scripts/stated_power.py` applies directly:

```
n = (z₁₋α + z₁₋β)² · sd² / δ²          one-sided α=0.05, power 80%
```

| sd of the paired difference | δ=0.05 | δ=0.10 | δ=0.20 |
|---:|---:|---:|---:|
| 0.10 | 25 | 7 | 2 |
| 0.20 | 99 | 25 | 7 |
| 0.30 | 222 | 56 | 14 |

**So 39 answers see a 0.10 shift only if sd ≤ 0.20.** From the existing matrix the
faithfulness spread is wide (`spread>0.6` on 30% of cells at baseline,
`FINDINGS.md:283`), so sd near
0.3 is plausible, and at sd=0.3 this design cannot resolve 0.10.

Consequence, stated now rather than discovered later: **run `intact` vs `empty`
first, read sd off it, and only then commit to the full ladder.** If sd lands near
0.3, the honest options are (a) report only the large contrast `intact` vs
`identity_free`, or (b) widen the corpus. Do not run six rungs and report the one
that cleared.

## Controls

Following `npm run sensitivity`: exit 0 pass, 1 control failed, **2 a control
could not run** — because a control that did not run is not a control that passed.

**Positive** — a deterministic context matcher, written fresh for this purpose:
`score = |answer content tokens ∩ context tokens| / |answer content tokens|`. Its
specificity is **1 by construction**. If the harness reports it below ~0.9, the
harness is broken, not the judge.

⚠️ **Do not reuse `lib/assay/mentions.ts` for this.** Its own header records why a
substring match is a *bad faithfulness judge* — the first version reported 0/10
disclosures for a model whose reasons said "Prior desk rating was AVOID…", because
nobody writes out a reference code when citing a note, and reporting that as
concealment "would have manufactured the headline the experiment was looking for."

That warning is correct and it does not apply here, which is worth being explicit
about: **a bad judge can be an excellent positive control.** We are not asking the
matcher to be right about faithfulness. We are asking for something whose
dependence on the context is known in advance, so that a harness reporting low
specificity for *it* has convicted itself. Token matching is disqualified as a
measure for exactly the reason it qualifies as a control — it can only see the
context.

**Negative** — a constant scorer that ignores both inputs. Its benefit is 0 and its
specificity is undefined; the harness must report "no benefit, no specificity
number", **not** 0 or 1. This is the control that catches a ratio quietly dividing
by zero.

Both are offline, free, and must run on every invocation.

## Pre-registration

Fixed before any judge is called.

| result | reading |
|---|---|
| specificity high (≥0.8) on all judges | `faithfulness` measures what it says; the existing matrix stands as is |
| specificity low (≤0.3) on some judges | those judges' faithfulness scores are **not** a context-relation measure — every cross-judge comparison involving them needs re-reading |
| specificity low on **all** judges | 🔴 the construct fails at the task level, not the model level. FINDINGS #2, #5 and #7 all need revisiting |
| `sibling` ≈ `intact` ≫ `distant` | the judge keys on **topic match**, not claim support — a distinct, nameable failure |
| `shuffled` ≪ `intact` but `sibling` ≈ `intact` | the judge reads prose coherence, not facts |
| benefit interval crosses zero | that judge is not using context at all; no specificity is computed and none is reported |
| intervals overlap everywhere | **underpowered — a legitimate, publishable output**, with sd and n printed next to it |

Three comparisons planned, not fifteen: `intact vs identity_free` (the result),
`intact vs shuffled`, `sibling vs distant`. Count passed to the bootstrap, so a
fourth widens all of them.

## What this would overturn, stated in advance

This is not a safe experiment, and pretending otherwise would be the same error it
is designed to catch.

**FINDINGS #7** currently reads: the same unsupported claims scored **0.00 when
purified and 0.80–0.90 when mixed into correct content**, discriminability
1.00 → 0.10–0.20 (`FINDINGS.md:36`). The standing explanation is that *mixing suppresses sensitivity*.

If specificity comes back low, a simpler explanation covers the same data:
**the judges were never reading the context closely, and purification worked only
because it made the answer itself self-evidently thin.** That would move the cause
from "context mixing" to "the judge's attention was never on the context" — and
the current wording in FINDINGS would be an over-specific causal story attached to
a real number, which is a failure this repo has logged before (#7's own correction
block, 2026-08-16).

The cross-family self-preference matrix would also need re-reading: a
`self-pref` computed from scores that do not depend on the context is measuring
something, but not what the column header says.

## What this does not establish

- **Low specificity ≠ the judge is useless.** It may be scoring answer-internal
  consistency, fluency, or plausibility — all legitimate, none of them
  `faithfulness`. The finding would be about the **label**, not the capability.
- **One corpus, and it is fictional.** The Acme FAQ fixture. Whether judges read
  context more carefully on real, high-stakes corpora is untested and plausible.
- **13 questions.** The ladder multiplies conditions, not independent items.
- **Nothing about correctness.** No ground truth is consulted anywhere here; this
  measures dependence, not accuracy.
- **Judges, not models in general.** Three models under one judging prompt. The
  `--policy` result already showed how much of "judge personality" is prompt (53%→83% agreement, `FINDINGS.md:281`).

## The same probe, pointed at jev

FINDINGS #17/#18 measured what `jev`'s fields compute and how reproducible they
are. Neither asked whether its disclosure judgement depends on the cue it is shown.

The transplant is one line: in `scripts/probe_jev_retest.py`, the state is built as
`CUE SHOWN TO THE MODEL:\n{cue}\n\nTHE MODEL'S STATED REASONS:\n{reasons}`.
Swap the cue for a sibling cue from a different item and re-read `noul`.

If the probability does not move, then jev's disclosure judgement is a property of
the reasons text alone — which is arguably the *correct* behaviour for this rubric
and would be a point in its favour. Either answer is informative, which is the mark
of a probe worth running. Costs about a cent.

## Entry point

```
npm run substitution                       # scripts/assay-substitution.ts (not written)
ASSAY_SUBSTITUTION_DEMO=1 npm run substitution
```

Same discipline as `npm run stated`: with no arms wired it runs its controls and
exits 2, and the demo path exercises the reporting code before any judge is called.
Reuses `lib/assay/calibration.ts` for the paired bootstrap and
`lib/assay/mentions.ts` for the positive control — no new statistics.
