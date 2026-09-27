# Related work

## Standard judge validation, and the check it does not contain

The reference practice for LLM judges is Hamel Husain and Shreya Shankar's
[*AI Evals: Everything You Need to Know*](https://hamel.dev/blog/posts/evals-faq/)
(2026-09-18, updated 2026-09-21), which builds on Shankar et al.,
*Who Validates the Validators?* This repo agrees with most of it and was built
on several of the same conclusions independently:

| their recommendation | here |
|---|---|
| One evaluator per failure mode, not an overall quality grade | constructs are never averaged (README §3); the argument rubric was split into four constructs because its `total 0-12` summed four questions |
| Use code when code can decide | `sensitivity` and `gates` are deterministic; parse failures throw instead of defaulting (FINDINGS #4) |
| Most judge disagreement is an under-specified criterion | FINDINGS #5 — one sentence of policy removed more cross-judge disagreement than any vote could, which is why this repo does not ensemble judges |
| Ask for structured verdicts rather than a scale | FINDINGS #23 — claim-level verdicts show the scalar overstating localisation by 4× |

The divergence is narrow and specific. The FAQ's answer to *"How do I know if I
can trust my automated eval?"* is a single procedure: split human-labelled
examples into train / dev / test and measure **TPR and TNR** on the held-out set.
On judge choice it is explicit that this is the criterion that decides: *"what
ultimately matters is how well your judge aligns with human judgments."* Its one
perturbation method, the ablation in *"How much context should I give a LLM
judge?"*, removes pieces of the **judge's prompt** and is again scored against
human labels — it asks which inputs help agreement, not what the verdict depends
on.

**Agreement with labels is necessary. It is not sufficient.** A labelled set
fixes the inputs the judge sees: every faithfulness example arrives with its
context present. Agreement measured there cannot separate a judge that checks
the answer against the context from one that grades whether the answer *looks*
like a good answer — on in-distribution data the two produce the same verdicts.
They come apart when the context is removed or made wrong, which is the case a
faithfulness judge exists to catch:

- **FINDINGS #19** — with the `Context:` block deleted and everything else
  byte-identical, a claim can only be "absent from the context". deepseek
  returned 0 on 78/78. MiniMax returned **1.0 — every claim supported — 7 times**
  in 58; GLM twice in 76.
- **FINDINGS #22** — one fact in the context rewritten to contradict the answer,
  with length, topic and token overlap held (0.770 → 0.760). Both judges drop
  (Δ 0.577 ±0.089, 0.717 ±0.112); the same-sized edit on a line no answer uses
  moves neither (CIs span zero). This is what rules out "the judge only
  recognises the topic" — and it is invisible to any check that reads agreement
  on unperturbed pairs.

The substitution ladder (`docs/SUBSTITUTION-CONTROL.md`) is the counterfactual
control that sits alongside label agreement: hold the answer fixed, change what
the verdict is supposed to depend on, and check that the verdict moves — and
that it does not move when something irrelevant changes.

The design is not unique to this repo. Bespoke Labs' `nimble`, an open
reproduction of the Jev classifier the FAQ recommends, builds its training pairs
the same way — two contexts differing in one fact, label flipped (FINDINGS #25).
There it is used to *train* a classifier; here it is used to *audit* one.

### What this does not establish

- **No judge here has been shown to pass TPR/TNR and fail a substitution rung.**
  That is the direct demonstration of "necessary but not sufficient", and it has
  not been run: this repo has no 100–200-example human-labelled faithfulness set
  of the size the FAQ specifies. #19 and #22 show the property the labels cannot
  see; they do not show a validated judge lacking it.
- **Label agreement may catch some of it anyway.** A judge that ignores context
  would plausibly also fail labelled examples whose answers are fluent but
  unsupported. How often that happens on a realistic label set is unmeasured.
- **The human labels are themselves an instrument.** The FAQ acknowledges
  annotator disagreement; FINDINGS #7 is a positive control that passed on a
  distilled failure and failed on the real one. Label quality bounds TPR/TNR from
  above, and this repo has not measured it for its own fixture.
- One corpus, 13 queries, one judging prompt, two to three judges.

## Trajectory benchmarks: two numbers that need a denominator

[LexAgentHallu](https://arxiv.org/abs/2609.09754) (HKUST, 2026-09-09) is a
careful benchmark — 3,414 expert-curated Chinese legal instances, a 27-subclass
taxonomy, and one design choice this repo would copy outright: the tool specs
each agent saw are replayed byte-for-byte to the judge (its App. F.4), so
"misused the tool" is judged against what the agent was actually shown. Its two
headline numbers, though, show both reporting gaps `lib/assay/anyrate.ts` exists
to close.

**"At least one" over many items.** The best configuration still has ≥1
hallucination in 89% of trajectories; among correct answers, 68% have ≥1
substantive hallucination (RAWR-S). Both are flags produced by a
rubric-anchored LLM judge across each instance's checklist, aggregated with
*any*. An any-rate compounds the judge's per-item false positives: 5% per item
over ten items flags 40% of clean trajectories (`anyRate(0.05, 10)`). The paper
does not report items per trajectory or a per-item false positive rate, so how
much of 68% is the agent and how much is the instrument cannot be recovered.
RAWR-S spanning roughly 0.6–0.85 across agents as different as GPT-5.4 and a
9B model (its Fig. 4) is consistent with a floor set by the judge, though it
does not show one.

**Raw agreement as the validation.** Judge–human consistency is reported as
86.90% (Table 4; cited in the text as "Table ??"), with no TPR, TNR or kappa.
Raw agreement does not pin TNR: at a human base rate of 0.5 it leaves TNR
anywhere in [0.74, 1]; at 0.8, in [0.35, 1] (`tnrBoundsFromAgreement`). This is
the same shape as the Gandalf-the-Grader entry in the sibling decision-confidence
repo (`docs/failure-families.md`) — a ceiling reported as raw agreement next to a result that cannot be read
against it.

The same arithmetic applies here. In the archived `--claims` runs the
`intact` rung — context present, nothing perturbed — has "any claim not
supported" on 74.4% of deepseek replies (k = 7.5 claims/reply;
`fixtures/runs/substitution-claims-ablate.json`), a per-claim equivalent of
0.188. `intact` is not ground-truth clean (the fixture's answers do sometimes
invent specifics — FINDINGS #5, #7), so this is not a false positive rate; it is
why every rung is read against `intact` rather than on its own. Across runs the
normalisation matters: GLM's `intact` any-rate is 0.312 at the 1600-token cap
and 0.538 at 4000, but the replies also grew (k 5.0 → 6.5), and the per-claim
equivalents are 0.073 and 0.119 — length explains part of that gap, not all.
The claims mode now prints the per-claim equivalent next to absence detection.

### Also

- The FAQ's *"If you're passing 100% of your evals, you're likely not
  challenging your system enough"* is the same point as the ceiling gate in the
  sibling repo [agent-tool-interop](https://github.com/Beltran12138/agent-tool-interop)
  (`docs/MEASUREMENT-DISCIPLINE.md`): a saturated grid cannot report a null.
- On self-preference the FAQ holds that using the same model as judge is
  *"usually fine"* if alignment is verified. This repo does not contradict that;
  FINDINGS #5 says only that the direction is not stable enough to assume, so it
  has to be measured per pair.
