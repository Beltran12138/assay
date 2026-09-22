# Substitution control: does the judge use what it reads?

> Written 2026-09-21. **Stages 1–4 have all run** — see [Stage 1 result](#stage-1-result-2026-09-21--and-what-it-invalidates). Each stage changed the next one's design; two of my own stated conclusions were reversed by the following stage, and both corrections are kept in place rather than edited away.
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

## Stage 1 result (2026-09-21) — and what it invalidates

Run: `npm run substitution`, `scripts/assay-substitution.ts`, raw in
`fixtures/runs/substitution-stage1.json`. **One judge only** — `.env.local` is
absent in this clone, so `ASSAY_JUDGE_*` is unset and Kimi / MiniMax were
unreachable. Everything below is `deepseek-chat`.

| | |
|---|---:|
| usable cells | 39 / 39 |
| mean `intact` | 0.772 |
| mean `empty` | **0.000** |
| benefit mean | 0.7718 |
| **benefit sd** | **0.2322** |
| noise floor, mean \|repeat diff\| | 0.0103 |
| identical repeats | 73 / 78 |

**Power, now measured instead of guessed.** sd = 0.232 sits just above the 0.20
threshold this doc predicted. At n=39 the design resolves a paired shift of
**0.092**; δ=0.10 needs n=34 (have it), δ=0.05 needs n=134 (do not). So the
ladder is worth running, and 0.05-scale effects are out of reach on this corpus.

Noise is a non-issue: ~1pt against an sd of 23pt, and 73/78 repeats byte-identical
at temperature 0. The five that moved are all on the `intact` side.

### 🔴 `empty` is a degenerate rung, and `benefit` as defined is not a quantity

> ⛔⛔ **CORRECTED the same day, once the other two judges ran.** Everything in
> this subsection is true of `deepseek-chat` and **false as a general claim**. The
> original text is kept below unchanged; the correction is in the next subsection.
> I wrote "degenerate rung" from a single judge — `feedback_single_source_overconfidence`
> in one move: one source, high-confidence negative.

**All 78 `empty` calls returned exactly 0.** Zero variance, no exceptions.

That is not a bug and arguably not even wrong: the judge is told
`0.0 = contains claims absent from the context`, and with no context every claim
is absent. It is the logically forced answer.

The consequence is structural:

```
J(empty) ≡ 0   ⟹   benefit = J(intact) − J(empty) = J(intact)
```

**`benefit` is not measuring what the context is worth. It is the intact score
under another name**, and its sd is just the sd of the intact scores. What the
`empty` rung actually tests is whether the judge notices the Context block is
missing — a trivial capability, and one it has.

### Consequences for stage 2, decided before running it

1. **`identity_free` becomes the primary contrast, not `empty`.** Only a rung that
   *keeps* a context block while emptying it of relevant content can separate
   "needs something there" from "needs that thing".
2. **Drop the ratio.** `specificity = Δ / benefit` inherits a denominator that is
   now known to be degenerate. Report the raw paired difference
   **`Δ = J(intact) − J(identity_free)`** against the measured sd and noise floor.
   A ratio whose denominator is a different measurement of the numerator's own
   input is not a normalisation, it is a reparametrisation.
3. **`empty` stays, demoted to a sanity check.** If a future judge does *not*
   return 0 on `empty`, it is not reading the Context block at all, and its whole
   column is suspect before any rung is interpreted.

⚠️ This is stage 1 doing its job. Had the six rungs been written and run at once,
`benefit` would have gone into the denominator of every reported number and the
degeneracy would have been invisible in the output.

### ⭐⭐ Then two more judges ran, and the answer changed

`.env.local` was restored mid-session, so `MiniMaxAI/MiniMax-M2.7` and
`zai-org/GLM-5.3-Flash` became reachable. (`moonshotai/Kimi-K2.6` did **not** —
it is no longer served by the router, which means the −0.373 self-preference in
FINDINGS #5 is currently not reproducible at all. The raw matrix survives in
`fixtures/runs/selfpref-matrix.json`, so that result is auditable but not
re-runnable.)

| judge | usable | intact | **empty** | sd | noise mean\|diff\| | identical |
|---|---|---:|---:|---:|---:|---|
| deepseek-chat | 39/39 | 0.783 | **0.000** | 0.230 | 0.0064 | 74/78 |
| MiniMax-M2.7 | **29/39** | 0.876 | **0.187** | 0.374 | **0.1671** | 38/58 |
| GLM-5.3-Flash | 38/39 | 0.689 | **0.067** | 0.393 | 0.0526 | 61/76 |

**Score distribution with no context at all:**

```
deepseek-chat     nonzero  0/78   {0: 78}
MiniMax-M2.7      nonzero 15/58   {0:43, 0.2:1, 0.22:1, 0.5:5, 0.9:1, 1:7}
GLM-5.3-Flash     nonzero  6/76   {0:70, 0.5:1, 0.8:1, 0.9:2, 1:2}
```

🔴 **MiniMax returned a perfect 1.0 seven times on a prompt containing no context.**
"Every claim is supported by the context" cannot be true when there is no context;
the statement has no truth-maker. GLM did it twice. **These judges are not checking
whether the context block exists.**

So `empty` is not degenerate — it is **the most discriminating rung of the six**,
and it discriminates between judges rather than between answers. The three
revisions in the previous subsection still stand for a different reason: `empty` is
too informative to be a denominator, because for deepseek it is a constant and for
MiniMax it is noise.

**What this already establishes, before any further rung runs:**

The three judges differ at the most basic level available — *whether the score is
conditioned on the presence of the source document at all*. `assay-selfpref.ts`
puts their scores in one matrix and decomposes them into leniency + quality +
self-preference. That decomposition assumes the three are measuring the same
thing. On this evidence they are not, and the residual attributed to
"self-preference" is sitting on top of a difference in what is being read.

This is [[project_decision_confidence]]'s question — *are these sources answering
the same question?* — arriving inside `assay` from the other direction.

### ⚠️ MiniMax is not usable for stage 2

Its noise floor (0.1671) is essentially equal to the smallest paired shift its n
and sd can resolve (0.173). There is no effect it could detect that its own
repeat-to-repeat variation would not manufacture. Worst cells are full flips at
temperature 0:

```
deepseek-chat#6    intact 1 / 0        (same input, twice)
deepseek-chat#12   empty  1 / 0
Kimi-K2.6#10       empty  1 / 0
```

Also **26% of its cells dropped** (10/39) against 0/39 and 1/39 for the others —
the reasoning-model token exhaustion already logged in FINDINGS #16. The drops are
not evenly spread across generators (5 MiniMax / 4 deepseek / 1 Kimi), which is the
shape of a stratum rather than a sample, but n is far too small to call it —
`FINDINGS.md` #7 made exactly this mistake's mirror and had to check it properly.

**Stage 2 runs on deepseek-chat and GLM.** MiniMax is reported, not used.

## Stage 2 result (2026-09-21) — the rung that nearly got cut is the one that mattered

`npm run substitution -- --stage2` · raw in `fixtures/runs/substitution-stage2.json` ·
written up as FINDINGS #20.

Two corpus limits hit on implementation, both recorded rather than worked around:

- **`sibling` and `distant` merged into `other`.** 13 queries over 11 intents means
  only `fee` and `withdraw` have same-intent pairs — 4 queries, 12 cells, which at
  the measured sd resolves 0.17. The graded-dependence probe is **dropped, not run
  underpowered**.
- **11 distinct contexts, not 39.** All three generators answer the same queries,
  so the 39 cells share 11 contexts. Pairing is unaffected; the effective variety
  of substitutes is not 39.

| rung | deepseek | Δ | GLM | Δ |
|---|---:|---:|---:|---:|
| intact | 0.787 | — | 0.661 | — |
| identity_free | 0.000 | 0.787 ±0.071 | 0.000 | 0.661 ±0.110 |
| **shuffled** | **0.579** | **0.208 ±0.074** | **0.631** | **0.030 ±0.065** |
| other | 0.000 | 0.787 ±0.071 | 0.014 | 0.647 ±0.107 |
| empty | 0.000 | 0.787 ±0.071 | 0.051 | 0.609 ±0.133 |

**The primary contrast came back at ceiling for both judges.** Unrelated filler
scores 0; a different real context scores 0. Specificity is 1.00 on both. Had this
doc's own plan been followed — `intact` vs `identity_free` as *the* result — the
conclusion would have been "both judges read the context, both fine", and it would
have been true and useless.

**`shuffled` separated them:** deepseek loses 0.208 (resolvable floor 0.094 →
detected), GLM loses 0.030 (floor 0.083 → **not detected, which is not zero**).
One judge grades prose, the other grades a bag of facts, and the prompt does not
say which to be.

### What this changes in the design

1. **Demote `identity_free` from "the result" to "the precondition".** It answers a
   yes/no question (is the score conditioned on content?) and both judges answered
   yes. Ceiling effects carry no information about *how* they use it.
2. **`shuffled` is promoted.** It is the only rung here that produced a difference
   between judges, and it was originally justified in one sentence as a
   nice-to-have.
3. **The next rung to build is a partial one.** Everything except `shuffled` is
   all-or-nothing, and both judges are at the floor on all of them. A rung that
   removes *half* the relevant facts, or replaces one number, would sit where the
   variance actually is. `other` at 0.000/0.014 shows the current ladder has no
   middle.

## Stage 3 result (2026-09-21) — the middle, and a prediction of mine that failed

`npm run substitution -- --stage3` · raw in `fixtures/runs/substitution-stage3.json` ·
written up as FINDINGS #21.

`one_number` was the first choice for this rung and was dropped before running:
only 4 of 13 queries share a numeric token between answer and context — 12 cells,
resolving 0.17. Same underpowering that killed `sibling`. **It remains the sharpest
untried test in this design** and is recorded as such rather than quietly forgotten.

Built instead: two block-swap rungs whose predictions **oppose** each other.

| | intact | swap_top1 (1/3 swapped) | swap_bot2 (2/3 swapped) | identity_free |
|---|---:|---:|---:|---:|
| token overlap (objective) | 0.770 | 0.589 | 0.660 | 0.290 |
| deepseek | 0.794 | **0.141** | 0.536 | 0.000 |
| GLM | 0.717 | **0.153** | 0.428 | 0.000 |

| ratio top1 : bot2 | |
|---|---:|
| objective content loss | 1.65× |
| deepseek | **2.53×** |
| GLM | **1.95×** |

**Both judges lose more from one relevant block than from two irrelevant ones, and
both lose more than the token accounting says they should.** They locate the
supporting block; they are not counting matches.

### ⛔ It also falsified my own prediction, and narrowed #20

Having watched GLM shrug at `shuffled` in stage 2, I wrote that it "grades a bag of
facts" and predicted it would be the judge that penalises *volume* — i.e. that its
`swap_bot2` would hurt more. It did not; GLM tracks block relevance nearly as hard
as deepseek.

The real difference between the two judges is **narrower than stage 2 suggested**:
both locate the relevant block, only deepseek also penalises scrambled sentence
order. #20's wording is corrected in place.

**Three times this session a single-condition reading was over-generalised and the
next condition reversed it** — aggregator dispersion in the TRV audit, `empty` as a
degenerate rung, and this. The pattern is not carelessness about any one of them;
it is that each was stated at full confidence from one arm. The cheap fix is
already in this design and keeps working: **run the next condition before writing
the sentence.**

### The ladder finally has a scale

```
intact         0.794 / 0.717
swap_bot2      0.536 / 0.428
swap_top1      0.141 / 0.153
identity_free  0.000 / 0.000
```

Four populated points instead of two. Anything measured against this ladder from
here — a prompt variant, a new judge, an added policy line — has somewhere to land
other than the floor.

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

## Stage 4 result (2026-09-21) — the ladder is complete, and the topic-matching explanation is dead

`npm run substitution -- --stage4` · raw in `fixtures/runs/substitution-stage4.json` ·
written up as FINDINGS #22.

**The `one_number` rejection in stage 3 was wrong, and reversing it cost nothing.**
It was rejected because only 4 of 13 queries share a numeric token between answer
and context. But the rung was never about numbers — it is about making the context
*contradict* the answer, and a contradiction can be an entity, a direction or a
condition. All 11 distinct contexts support one. `fixtures/contradictions.json`
holds them, one per context, each altering exactly one fact.

This matters because **every earlier rung is compatible with "the judge recognises
the topic"**: whole blocks swapped, whole contexts swapped, every sentence
reordered. This rung holds the topic perfectly and makes one fact false.

| | intact | contradict | Δ | perturb_unused | Δ |
|---|---:|---:|---:|---:|---:|
| token overlap | 0.770 | 0.760 | — | 0.769 | — |
| fact match | 0.715 | 0.640 | — | 0.715 | — |
| deepseek | 0.794 | **0.217** | **0.577 ±0.089** | 0.768 | 0.026 ±0.036 |
| GLM | 0.863 | **0.146** | **0.717 ±0.112** | 0.902 | −0.039 ±0.075 |

Both judges locate the contradiction; both ignore an identically-sized edit on the
`常見追問` line that no answer uses (CI spans zero on both). **Pre-registered
reading one.** The topic-matching explanation for #19–#21 is ruled out.

### The complete ladder

```
                deepseek   GLM      what is destroyed
intact            0.794    0.863    —
perturb_unused    0.768    0.902    an unused line
shuffled          0.579      —      sentence order (tokens all kept)
swap_bot2         0.536    0.428    2/3 of the text, the irrelevant part
contradict        0.217    0.146    ONE fact, everything else intact
swap_top1         0.141    0.153    1/3 of the text, the relevant block
other             0.000    0.014    the whole context, replaced with a real one
identity_free     0.000    0.000    the whole context, replaced with filler
empty             0.000    0.051    the context block itself
```

**One contradicted fact sits almost exactly where "delete the block that carried
the answer" sits.** For these judges, a source that says the wrong thing is worth
about as little as no source at all — which is the correct behaviour for a
faithfulness metric and was not knowable from any earlier rung.

### Design status

All rungs originally specified are now run or explicitly dropped with a reason:

| rung | status |
|---|---|
| `intact` `empty` | stage 1 |
| `identity_free` `shuffled` `other` | stage 2 |
| `swap_top1` `swap_bot2` | stage 3 |
| `contradict` `perturb_unused` | stage 4 |
| `sibling` / `distant` | **dropped** — 13 queries over 11 intents leaves 4 same-intent pairs, resolving 0.17 |
| `one_number` | **superseded** by `contradict`, which is the same idea without the numeric constraint |

What is not built: nothing asks the judge *which* claim failed. Every rung reads a
single number, so "found the contradiction" and "sensed an inconsistency" remain
indistinguishable. That is the next question, and it needs a different output
format rather than a new rung.

---

## Claim-level attribution (`--claims`) — pre-registered 2026-09-22, run the same day

> **Status: run.** Results in FINDINGS #23. Prediction 1 (lift > 0 for both judges)
> held at 0.487 / 0.438. Prediction 2 (GLM ≥ deepseek) **did not hold**, and the
> gap is below resolution, so it is recorded as not-detected rather than reversed.
> Prediction 3 held hard and turned into the run's main result: the holistic
> scalar falls four times further than the claim count justifies.
> The text below is the pre-registration, unedited.

The gap above, answered with a different output format rather than another rung.
`lib/assay/claims.ts` asks the judge to split the answer into claims and return,
per claim, `supported | contradicted | unsupported` plus the block title it rests
on. The block label space is closed to the titles present in the context, for the
same reason `ARGUMENT_FALLACIES` is closed: a judge free to invent a label
produces a result nobody can reproduce, and here an invented block would be
counted as a successful localisation.

The three-level shape is taken from the session / trajectory / step attribution in
AWS's *Agent DLC* whitepaper. The vocabulary does not transfer — a single-turn
faithfulness probe has no session and no tool trajectory — so it maps onto what is
actually graded here: **answer → claim → span**.

### The measure

`localisation()` returns one of three values against the block that
`fixtures/contradictions.json` says was rewritten:

| value | meaning |
|---|---|
| `located` | flagged a claim and named the tampered block |
| `felt` | flagged something, but not there |
| `missed` | called every claim supported |

**Primary statistic: localisation lift** = P(`located` \| `contradict`) − max over the
two controls. `contradict` alone is uninterpretable: a judge that names the fee
block on every context scores 100% `located` and is measuring nothing. `intact`
and `perturb_unused` run the identical cells with that block untouched, so the
lift is the only readable quantity. The whitepaper's three-level attribution ships
with no such control; it assumes the attribution is right.

### Predictions, fixed before the first call

1. **Lift > 0 for both judges.** If lift ≈ 0 while the scalar ladder showed
   Δ 0.577 (deepseek) and 0.717 (GLM) on the same rung, then these judges detect
   without localising — "felt", not "found" — and FINDINGS #22's reading of that
   Δ as *fact-checking rather than topic-matching* is weakened. It would not be
   overturned: #22 rests on `perturb_unused` being null, which stands either way.
2. **GLM ≥ deepseek on lift**, since GLM had the larger scalar Δ on `contradict`.
   If deepseek localises better despite the smaller Δ, the scalar and the
   claim-level reply are not two views of one quantity, and neither can be used
   to interpret the other.
3. `derivedScore` is **not** predicted to track the scalar score. Its denominator
   is a judge output — the answer's decomposition — so two answers graded alike
   can differ because one was split into three claims and the other into seven.
   Comparing the two is a separate experiment, not a validation.

### Power, stated before seeing anything

n = 39 cells per rung per judge, but **39 cells share only 11 distinct contexts**
(three generators answer the same queries). Cluster size ≈ 3.5, so for anything
driven by the context rather than the answer the effective n is well below 39:
at ρ̄ = 0.5 the design effect is 2.25 and n_eff ≈ 17.

Unpaired, two proportions near 0.5 at n = 39 resolve a difference of about 0.22;
at n_eff = 17 that becomes about 0.33. The rungs are paired on the same cells, so
a paired analysis does better than this, but the honest statement is: **a lift
below roughly 0.2 is not readable at this corpus size, and should be reported as
not-detected rather than as zero.**

### Known holes, listed now rather than found later

- **The decomposition is not checked for stability.** Nothing measures whether a
  judge splits the same answer into the same claims across two runs. If it does
  not, `derivedScore` has a moving denominator and every mean over it is suspect.
  This needs a repeat run before `derivedScore` is used for anything.
- **`unsupported` on the tampered block counts as `located`.** Silence and
  conflict are both reactions to the edit, and the judge may reasonably read a
  rewritten fact as "the context no longer backs this". Splitting them is a
  finer question than the corpus can support.
- Unparseable replies are dropped and reported as a count, never counted as
  supported (FINDINGS #4).
