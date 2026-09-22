# Stated confidence: does a probability mean what its label says?

> Written 2026-09-19. **Updated 2026-09-20.**
>
> No arm has run and there is still no ground truth. What has run is everything
> that does *not* need labels: the vendor terms, the meaning of the fields the
> arms would read, and the reproducibility floor under any number they produce.
> That work changed the design — see
> [Before the arms](#before-the-arms-calibrating-the-instrument) — and is written
> up as FINDINGS #17 and #18.

## First, a word this repo has already spent

`npm run calibrate`, `calibrate:score` and `calibrate:ablate` already exist and
mean something else: they **calibrate a detector** against human labels
(`fixtures/calibration/RUBRIC.md`). That is standard usage and it is not moving.

This document is about **probability calibration** — the empirical property that
among the decisions a system stamps 0.90, about 90% are correct. Different
question, different arithmetic, and it must not inherit the existing name. The
entry point proposed below is `npm run stated`.

The collision is not an accident of this repo. It is the first finding:
**"calibrated" is doing at least three jobs in this field at once**, and two of
them require no evidence at all. See [The word itself](#the-word-itself).

## The claim under test

TypeSafe AI released Jev on 2026-09-15, a model that emits typed structured
decisions with probabilities instead of text. Quoting the launch post verbatim
(`typesafe.ai/blog/introducing-system-one-models-and-jev`, read 2026-09-19):

- "All answers are accompanied with **calibrated probabilities** and confidence
  scores."
- "**Calibrated**: higher confidence means higher accuracy."
- Training is "Reinforcement Learning for Calibrated Decisions (RLCD)",
  optimising for "answers with **epistemically honest probabilities**".

This is an empirical claim about frequencies. It is measurable, and measuring it
is exactly what this repo is for.

Three things make it worth the trouble rather than merely possible:

1. **The vendor published no calibration metric.** Word-boundary search of the
   launch post: `ECE` 0, `Brier` 0, `reliability diagram` 0, `calibration curve`
   0. Their own "claims you can easily verify" list names three things — speed,
   cost, no type errors — and calibration is not among them; it sits under
   "our bolder claims".
2. **The vendor's own eval cannot establish it, and may penalise it.** Their
   workflow eval uses "the predictions of the largest, smartest, and most
   expensive external models as **reference probabilities**" — the average of
   GPT-6 Astra and Fable 5.1. The same post says LLMs "tend to be
   **overconfident and inconsistent**" when asked for confidence. If the
   reference probabilities are miscalibrated, a genuinely calibrated model sits
   *further* from them and scores *worse*. Their 67.8% is therefore not
   separable into "not smart enough" and "too honest".
3. **They asked for this.** From `typesafe.ai/blog/antibenchmaxxing`: "Put no
   weight on public benchmarks" and "Encourage users to create their own evals
   for their use cases."

None of this is an accusation. Their disclosure density is unusually high —
"Our number is not empirical", "some bias could exist", "We can't prove it isn't
subsidized". The gap is not honesty. It is that **disclosure is not a discount**:
every caveat can be accurate and the conclusion still be unsupported.

## Why this belongs to assay and not to decision-confidence

They look adjacent and are not. Jev **produces** one judgment with a marginal
probability; `decision-confidence` **consumes** a pile of judgments and asks
whether they are independent reads of the same question.

A perfectly calibrated Jev leaves every `decision-confidence` problem intact.
Worse, its architecture creates them: parallel sampling works by prefilling the
context once and broadcasting one KV-cache across all schema fields, so the ten
answers returned by one call are, by construction, ten heavily correlated reads
of one state. They arrive as ten clean independent-looking numbers.

`assay`'s question — *does this metric measure what its name claims?* — is the
one that fits.

## Power first, because the answer may be "don't bother"

Calibration is a frequency property, so precision is set by how many labelled
decisions land **inside each bin**, not by the total. Same formula this stack
already uses for minimum decision counts (one-sided α = 0.05, power 80%);
script: `scripts/stated_power.py`.

**How many samples a bin needs to prove "stated p₀ is really p₀ − δ"**

| bin stated | δ=1pt | δ=2pt | δ=3pt | δ=5pt | δ=10pt |
|---:|---:|---:|---:|---:|---:|
| 0.95 | 3118 | 822 | **383** | 150 | 44 |
| 0.90 | 5728 | 1471 | 670 | 253 | 69 |
| 0.80 | 10015 | 2534 | 1139 | 419 | 109 |

**And the inverse — what a bin of size n can actually catch**

| bin stated | n=50 | n=100 | n=200 | n=500 | n=1000 |
|---:|---:|---:|---:|---:|---:|
| 0.95 | 9.2pt | 6.2pt | 4.3pt | 2.6pt | 1.8pt |
| 0.90 | 11.9pt | 8.2pt | 5.7pt | 3.5pt | 2.4pt |

Two consequences, both of which should be stated before any data exists:

**The public "vibe checks" cannot see the thing they are commenting on.** The
most-cited external test made 777 judgments. Spread over ten bins that is ~78
each, which detects overconfidence only if it exceeds **7.2pt** in the 0.95 bin.
Even if 60% piled into the top bin (n≈466) the floor is 2.7pt. Meanwhile 3pt of
overconfidence at a 0.95 auto-execute threshold takes the error rate from 5.0%
to 8.0% — a **1.6× increase in production failures**, invisible to that test.

**The labels as originally cut were nowhere near enough**, and the row count hid
how far. The first cut was 114 items: 72 en — a stratified *sample*, A=45 /
B=15 / P=12 — plus the 42-item zh census.

🔴 Not 379. `strata.json`'s `en.rows = 379` counts **archive rows**; only 72 were
cut into `label-task.md`. An earlier draft of this document said 421 and was
wrong in the direction that makes the experiment look feasible.

And 114 was itself flattering. The strata were built to measure detector
*recall*, so near-misses are heavily over-sampled and the weights run 1.47 (A)
to **15.20** (B). Precision follows the Kish effective count, not the row count:

> **114 labelled items were worth n_eff = 42.1.**

At ten bins that is ~4 effective per bin. Not a weak experiment — no experiment.

### The sample has since been extended (2026-09-19)

`npx tsx scripts/assay-detector-extend.ts --apply` appended 307 items, taking en
from a 72-row sample to the **full 379-row census**, in six ~21-minute batches.

|  | before | after |
|---|---:|---:|
| labelled items | 114 | 421 |
| **Kish n_eff** | **42.1** | **421.0** |
| stratum weights | 1.47 / 15.20 / 7.08 | 1.00 / 1.00 / 1.00 |

**3× the labelling effort, 10× the effective sample** — because the original
design was self-defeating for this question, not because 307 rows is a lot. The
extension only ever *adds* to existing strata, so recall estimation gets strictly
more data too; nothing was traded.

At a flat weight of 1 the en sample is a census, so stratum weighting and the
finite/super-population split no longer apply to en at all.

⚠️ Ids 1–72 are byte-identical and any label already written still stands. The
extension appends; it never renumbers. Re-running `npm run calibrate` with larger
`TAKE_*` **would** renumber, silently invalidating every existing label — which
is why the extension is a separate script.

Even so: 421 items over ten bins is ~42 per bin, which sees roughly a **10-point**
overconfidence at a stated 0.95. That is enough to falsify a large claim and not
enough to certify a small one. The directional conclusion below is unchanged.

🔴 **And ~42 per bin is optimistic, because it assumes the bins fill.** Measured
on 2026-09-20 (FINDINGS #18): 60 Jev probabilities over 30 fixture items produced
**20 distinct values**, 38 below 0.10 and 13 above 0.90, nine in between. Equal
frequency binning cannot manufacture ten populated bins out of that, and the
mid-range bins — the ones where miscalibration is both most likely and most
costly — are the empty ones. The effective bin count is a property of the arm's
output distribution, not a parameter, and it must be read off the data and
reported next to every binned metric. This makes the case in *The one metric that
survives a small n* stronger, not weaker: **paired Brier needs no bins at all.**

So the conclusion is directional before anything runs:

> **This design can falsify the calibration claim. It cannot confirm it.**
> A null result means "no miscalibration larger than X was detectable at n=Y",
> and X and Y must be printed next to it every time.

That is not a hedge added afterwards. It is the reason to pre-register.

### The one metric that survives a small n

ECE, reliability and resolution all need bins, so their precision tracks
`n / bins` rather than `n`. **Brier does not**: it is a plain mean over items,
and under pairing the shared item difficulty cancels. In the synthetic run its
interval comes out roughly **half the width** of ΔECE's on the same data.

That buys a factor, not an order of magnitude — in the synthetic run at n=114
every interval still crosses zero, ΔBrier included. Two honest ways forward:

1. **Widen the en sample.** 307 archived rows were never cut into a task. Going
   from 72 to ~300 labelled items is the only action that changes the arithmetic.
2. **Restrict the claim to paired Brier** and publish the interval even when it
   crosses zero, with n and the width beside it.

⚠ Brier mixes calibration with discrimination, so it reads as a calibration
comparison **only when Δresolution is itself consistent with zero**. That is why
all four differences are reported together and the script warns when resolution
separates.

## Before the arms: calibrating the instrument

Everything in this section ran **without a single label**, which is why it could
go while the labelling is unfinished — and why it had to go first. An experiment
that reads a field before establishing what the field computes is not measuring
the thing in its title.

Four gates, in the order they were cleared on 2026-09-20.

### Gate 1 — the terms permit it

The 🔴 under *What this does not establish* said: read the ToS before running.
Done, all three documents.

| | |
|---|---|
| benchmarking prohibition | **none** — word search of the Master Customer Agreement returns 0 |
| publication / non-disparagement | **none** — 0 |
| training on input | forbidden by their own Privacy Policy: "We will not train or fine tune any artificial intelligence or machine learning models on your prompts or other Input" |
| MCA §2.3(b) | output may not be used to "develop (or facilitate the development of) a similar or competing product or service" |
| MCA §16.4 | neither party may use the other's name, brand or logo, or announce a relationship |
| MCA §4.1(c)(i) | customer data may be used **in perpetuity** to derive telemetry |

The two that bind: Jev's output goes into measurement write-ups only and **never
into `decision-confidence`'s logic or calibration**; and nothing published may
read as endorsement or as a relationship. Neither is a constraint on running the
experiment. The fixtures are synthetic briefs with no confidential or personal
content, so §4.1(c)(i) is acceptable.

### Gate 2 — cost, which turned out not to be a gate

Published price is \$0.042 per million input tokens, output free. Measured
against the actual fixture text:

| | |
|---|---:|
| 421 states, one pass | ~194,600 input tokens |
| **one full pass** | **\$0.008** |
| ten passes | \$0.082 |
| wall clock at the published 1,200 req/min | ~25 s |

Budget is not a constraint on any version of this experiment, including running
every arm ten times. Note this is *cheaper than the labelling by orders of
magnitude*, which is the correct ordering of what to be careful about.

### Gate 3 — what `confidence` computes (FINDINGS #17)

The field is derived, and the vendor says so. What they do not say is that
**Choice and Score use different statistics under the one name.**

- **Choice** is indistinguishable from `(n·peak − 1)/(n − 1)` at the two-decimal
  precision the API reports — 49 of 50 pairs across two collections, and 58/58 on
  the real fixtures at n=2, where it reduces to `2p − 1`.
- **Score** is order-aware and returned a confidence **above its own peak
  probability** in 4/15 answers. Choice did so in 0/25. No concentration measure
  on an unordered distribution can do that, so they cannot share a definition.

**Three changes to the design follow:**

1. **Arm A reads `noul` / `probabilities`, not `confidence`.** On a binary
   judgment the field is `2p − 1`. Calibrating it and calibrating the probability
   are the same measurement run twice, and reporting both would look like two
   results.
2. **`confidence` is still reported** — as the number the documentation instructs
   users to threshold on (`if confidence < 0.5: route_to_human`). The interesting
   quantity is not whether it is calibrated, which it does not claim to be, but
   what its thresholds actually admit. At `conf ≥ 0.5` that ranges from peak 0.750
   at n=2 to peak 0.525 at n=20 — a 22.5pt spread across a gate presented as one
   number.
3. **`Score` stays out of scope** and the exclusion is now principled rather than
   incidental. *What this does not establish* already said high-cardinality
   calibration is a different measurement; #17 shows it is also a different
   statistic.

### Gate 4 — the reproducibility floor (FINDINGS #18)

Two rounds over the same items, the same Noul twice per request — and the whole
probe run twice, so the floor itself is reproduced rather than asserted:

| | mean \|diff\| | max | decisions flipped |
|---|---:|---:|---:|
| within one request | 0.004 – 0.007 | 0.050 | **0 / 118** |
| between requests | 0.006 – 0.007 | 0.030 | **0 / 59** |

**0.4–0.7pt of noise against a ~10pt statistical floor** — more than an order of
magnitude smaller, so it is not carried into the intervals. The gate passes, and
the bottleneck remains sample size, exactly as the power section says.

Two things it turned up that do not pass quietly:

⚠️ **Jev is not deterministic.** Two byte-identical Nouls in one request
disagreed on 28–50% of items. The documentation says questions are evaluated "in
parallel and in isolation". The effect is negligible; the sentence is not
literally true, which matters to anyone keying a cache on it.

🔴 **The probabilities are heavily tied and heavily polarised.** 60 values, **20
distinct**, 38 below 0.10 and 13 above 0.90 — nine in between, and the same shape
in both collections. Ten equal-frequency bins over 421 items is not achievable on
a distribution like this, and the mid-range bins that carry the calibration signal
are the empty ones. See the warning added to the power section.

### The comparison this bought for free

Asked as a Noul and as a two-option Choice, the same judgment **agreed 0 times out
of 59** across two collections (mean |diff| 0.061 and 0.062; max 0.190 and 0.200)
while the decision the two imply agreed every single time. The signed difference
reproduced per item in every round — 29/29 and 30/30 — so no single rescaling
reconciles them: **at most one of the two can be calibrated.**

The vendor's own model card raises this and declines to resolve it — "it is not
obvious how to interpret either". 421 human labels resolve it for under a cent.

This is a genuinely new comparison, so it is subject to the same discipline as
the others: adding it makes **four** planned comparisons, not three, and the
count is passed to the bootstrap, which widens every interval. That cost is
declared here rather than discovered later. See the pre-registration table.

## The design

### Arms

Absolute calibration is the expensive question. The cheap and more interesting
one is comparative, and paired arms on identical items cut the variance:

| arm | what it is | what it isolates |
|---|---|---|
| **A** | Jev `Noul`, the returned `noul` — **not** `confidence`; see gate 3 | the product claim |
| **A′** | Jev two-option `Choice`, `probabilities["yes"]` | the same claim, asked the other way |
| **B** | small open model, parallel constrained decoding, softmax over the candidate slice | architecture without RLCD |
| **C** | arm B + temperature scaling, one scalar fitted on a held-out split | **whether RLCD beats one parameter** |
| **D** | frontier LLM, verbalised confidence ("how sure are you, 0–100") | the vendor's implied comparison |
| **E** | frontier LLM, logprob-derived probability under constrained decoding | the comparison they did *not* make |

**C is the arm that carries the paper.** Guo et al., *On Calibration of Modern
Neural Networks* (arXiv 1706.04599, 2017) showed a single temperature parameter
fixes most miscalibration in modern networks. If a scalar matches RLCD, a new RL
objective is not what the result needs.

⚠️ And the literature moved: Minderer et al., *Revisiting the Calibration of
Modern Neural Networks* (arXiv 2106.07998, 2021) find the newest architectures
are **among the best calibrated**, partly reversing Guo. So B may already be
decent before C touches it — which makes B and C more necessary, not less. Do
not cite Guo alone; the one-source version of this reasoning is wrong.

**D vs E is the second finding waiting to happen.** The vendor's comparison table
says models "tend to be overconfident and inconsistent" *even if prompted for a
confidence estimate* — that is verbalised confidence, arm D, the weakest
baseline available. If Jev beats D but not E, the headline is not calibration,
it is that nobody should have been asking models to say a number out loud.

### Ground truth

Reuse, do not manufacture. Inventing the test set is the exact failure being
audited.

- **Primary**: `fixtures/calibration/` — binary judgments under a written rubric,
  key withheld until labelling completes. Their yes/no shape maps onto Jev's
  `Noul` type without translation. 66 near-misses give the hard region.
  `Noul` returns a bare probability and **no `confidence` field at all**, which
  is the cleanest possible input to a reliability diagram: the forecast is the
  response, with nothing derived sitting next to it to be mistaken for a second
  opinion.
- **Secondary**: the golden routing/retrieval cases behind `npm test` —
  deterministic labels, and routing is Jev's home turf, so the arms compete
  where the vendor would want them to.
- **Ruler, unchanged**: τ²-bench verdicts stay what the README says they are —
  deterministic, therefore usable to measure drift, not a board to climb.

🔴 **Blocking dependency**: the human labelling pass for
`fixtures/calibration/label-task-zh.md` and `label-task.md` is unfinished. Until
it is, there is no ground truth and no experiment. Nothing downstream can start.

### Statistics

Report all of these or none:

- **Reliability diagram**, equal-frequency bins, **Wilson intervals on every
  point**. At n=78 the interval around an observed 0.95 is 10.4pt wide; a diagram
  without intervals will show structure that is not there.
- **ECE**, reported *with* bin count and bin scheme, never alone.
- **Brier score with the Murphy decomposition**:
  `Brier = Reliability − Resolution + Uncertainty`.

The decomposition is the point, and it is why ECE alone is a construct failure of
the same family this repo keeps finding. **A model that always emits the base
rate is perfectly calibrated and perfectly useless**: reliability ≈ 0, resolution
≈ 0. Any report of calibration without resolution has smuggled in a claim of
usefulness it did not measure. This is the quantitative form of a point the
coverage already gestures at in prose.

- **Selection accounting.** Bin count and bin scheme are researcher degrees of
  freedom; trying five and keeping the flattering one is the same trial-counting
  problem `decision-confidence`'s `selection_penalty(k, t_base)` prices. Declare
  the scheme in advance; if it changes, record k and pay the adjustment.

### The control, which is not optional

Following `npm run sensitivity`: known input, known verdict, and **exit 2 when a
control could not run, because a control that did not run is not a control that
passed.**

**Positive** — push an arm's probabilities through a logit temperature rescale
at T = 0.5, a known signed synthetic overconfidence. The harness must flag it.
**Negative** — score a predictor whose outcomes were *drawn from* its own stated
probabilities, so it is calibrated by construction. The harness must not flag
it. A harness that fires on everything passes the positive control and is
useless; only the pair is a control.

Two details that cost two wrong drafts, both now unit-tested:

- **The transform must fix p = 0.5.** `p ** 0.5` raises every probability, which
  sharpens a "yes" and softens a "no" — a shift toward yes, not overconfidence.
  `max(p,1−p) ** 0.5` fixes the asymmetry but maps a coin flip to 70% sure,
  injecting signal. Logit temperature is monotone, symmetric, and fixes 0.5, so
  **resolution must survive it** — which becomes a third control on the
  decomposition itself. It is also the exact inverse of arm C, so the control
  injects the very defect C exists to remove.
- **Ties must not straddle a bin boundary.** Equal-frequency binning splits
  identical forecasts across bins, and since the sort is stable the split tracks
  input order — manufacturing resolution from nothing. A constant predictor
  scored resolution 0.21 when the true value is 0 before this was fixed.
  Decision models emit heavily tied probabilities (a 255-way `Choice` has far
  fewer distinct confidences than items), so this is the common case here.

Implementation: `lib/assay/calibration.ts`, 21 tests in
`lib/assay/__tests__/calibration.test.ts`. The Murphy identity is checked
against a hand-worked three-point example rather than against the code's own
output — an assertion copied out of the implementation agrees with it by
construction.

## Pre-registration

Fixed before any arm is called. Each outcome is written now so that none of them
can be reinterpreted later:

| result | reading |
|---|---|
| A significantly better calibrated than C | RLCD carries real increment over a scalar |
| A ≈ C | the claim holds, the method does not — one parameter suffices |
| A worse than C | the differentiating claim fails on this domain |
| A beats D, ties E | the baseline was strawmanned; verbalised confidence is the real loser |
| A better calibrated than A′, or the reverse | one of the vendor's two question types is the one to use, and the docs do not say which |
| A ≈ A′ despite never agreeing | the 0/59 disagreement is noise around a common truth; both usable, neither preferable |
| Δresolution excludes zero on a pair | that pair is confounded; its ΔECE is not a calibration result |
| intervals overlap everywhere | **underpowered — a legitimate, publishable output** |

The last row is the one that gets dropped under pressure. It stays — and on
today's 114 labels it is the *expected* row, not the fallback.

Four comparisons are planned, not fifteen. Six arms admit fifteen pairs, and
running all fifteen to report the interesting one is the mechanism the vendor's
own anti-benchmaxxing essay names: try enough experimental settings and the
benchmark ends up selecting the model, "even if nobody intended to game it".
Declaring four
in advance is cheaper than correcting for fifteen, and the count is passed to the
bootstrap, so adding a fifth widens every interval automatically.

| pair | what it decides |
|---|---|
| A vs C | does RLCD beat one fitted scalar? — **the result** |
| A vs B | RLCD over the same architecture without it |
| D vs E | the comparison the vendor did not make |
| A vs A′ | which of the vendor's own two question types is calibrated — added 2026-09-20, see gate 4 |

The fourth was added after the instrument work, not after seeing any outcome, and
adding it widened the other three. That ordering is the whole point of declaring
a count: a comparison admitted before the data is cheap and honest, and the same
comparison admitted afterwards is the mechanism this design exists to avoid.

## What this does not establish

- **One domain, and it is fiction.** The corpus is a made-up exchange. Frequency
  properties survive fictional content, but **out-of-distribution robustness is
  not measured at all** — and OOD is where calibration classically dies.
- **Binary judgments only.** Nothing here tests `Choice` over 255 options or
  `Score`. High-cardinality calibration is a different, harder measurement.
- **A point-in-time reading of an early-access model.** Not a claim about RLCD
  as a method, and not a claim about any future version.
- **Non-independence inside a query.** Ten fields from one KV-cache broadcast are
  not ten independent trials. If items are batched that way, the effective n is
  smaller than the count and must be discounted; otherwise send one judgment per
  query and say so.
- **Vendor terms.** ✅ Cleared 2026-09-20 — no benchmarking or publication
  prohibition exists; see gate 1. Two live constraints remain and they bind the
  *write-up*, not the run: output must not feed a similar or competing product,
  and nothing published may use the vendor's marks or imply a relationship.
  ~~Read the ToS before running, not before publishing.~~ Kept struck through
  rather than deleted, because the reason it was written still applies to the
  next vendor.

## The word itself

The collision at the top is the durable finding, independent of how Jev scores.
"Calibrated" currently denotes at least three different things:

1. **A detector fitted to human labels** — this repo's `calibrate:*`. Requires
   labels.
2. **A softmax over a restricted candidate set** — e.g. the widely-shared
   reimplementation `harshatheg/Qwen-2.5-1B-RLCD`, whose card labels
   `P(cᵢ)=exp(zᵢ/T)/Σexp(zⱼ/T)` as "Calibrated Softmax Probabilities". That is
   normalisation. **It requires no evidence and guarantees nothing**; a model can
   be perfectly normalised and wildly overconfident.
3. **An empirical frequency match** — the only sense in which the word carries
   information, and the only one that needs data.

Sense 2 is doing the most damage, because it makes a free operation sound like a
measured property. The two-hour reimplementation reproduced Jev's parallel
sampling and type safety — the two layers nobody disputed — and labelled its
softmax "calibrated". So the loudest critique ("just a JSON classifier") and the
loudest claim ("a new paradigm") have both skipped the same layer.

Whatever the arms return, that distinction is worth writing down once, carefully.

## Entry point

```
python scripts/stated_power.py          # first — can the labels you have see anything?
npm run stated                          # scripts/assay-stated-confidence.ts
ASSAY_STATED_DEMO=1 npm run stated      # synthetic arms; exercises layers 1 and 2
npx jest lib/assay/__tests__/calibration.test.ts

# instrument, before any arm — these need a key but no labels
TYPESAFE_API_KEY=… python scripts/probe_jev_confidence.py   # what `confidence` computes
TYPESAFE_API_KEY=… python scripts/probe_jev_retest.py       # reproducibility floor
```

Neither probe stores a key; both read `TYPESAFE_API_KEY` from the environment and
pin the model version. Together they cost about two cents and take a minute.

Deliberately not `calibrate`. See the top of this file.

With no arms wired and no labels finished, `npm run stated` runs its controls
and exits **2**. That is the intended state today, and it is the point: the
harness is verifiable before there is anything to measure.

`ASSAY_STATED_DEMO=1` replaces every arm with a generated predictor at a known
temperature, so the reporting path executes before an arm exists — shipping
report code that has never run is how a harness arrives already broken. Every
number it prints is invented and the banner says so. It is also, unintentionally,
the clearest illustration of the last row of the pre-registration table: at
n=114 with a *known* injected difference, every interval still crosses zero.

### Paired bootstrap, three choices that change the answer

- **Resample items once for both arms.** Scoring arms on independently drawn
  samples discards the pairing, which is the whole reason the comparison is
  affordable at n in the hundreds.
- **Resample within strata.** The bootstrap has to reproduce the design it
  stands in for. Pooling A/B/P would let a replicate hold eleven near-misses,
  which the real design cannot produce.
- **The census is a choice.** `finite` holds the 42 zh rows fixed — they are the
  population, matching how `assay-detector-score.ts` already reports zh recall
  as exact. `super-population` treats them as one draw from the model's
  behaviour, which is the right question if the claim is about the model. Both
  are printed. Agreement makes the conclusion robust; **disagreement is the
  finding, and neither may be picked for excluding zero.**

Percentile intervals, not BCa — slightly biased for a statistic bounded below,
which ECE is. Read a near-zero lower bound as "consistent with no difference",
never as a measurement of how small the difference is.
