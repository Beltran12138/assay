# assay

**Check the judge before you trust the score.**

`assay` is an evaluation harness for knowledge-answering support agents. Its
subject is not the agent — it is the *evaluator*. Before reporting a quality
number, `assay` asks three questions about the number itself:

1. **Is the judge scoring its own work?** (self-preference)
2. **Does the eval exercise the path that actually runs in production?** (mirror drift)
3. **Are two different things being averaged into one score?** (construct conflation)

Only after those pass does a score mean anything.

> Status: **early, single-fixture.** One reference agent, one FAQ corpus, no
> published results yet. Nothing here is production-tested. See
> [Honest limitations](#honest-limitations).

### One question, five domains

**"Are these sources answering the same question?"**

Most tooling asks whether independent sources *agree*. This one asks whether they are
measuring the same thing at all — two sources can differ by 68 points and both be right.

Five failure families keep surfacing in five unrelated domains; a sixth has so far
appeared in one domain, and a seventh was found the other way round — first in
someone else's published work, and only then looked for here. Three of the five
domains are public repositories, below; the fourth is a local experiment cited in
the evidence table; the fifth is a third-party skill I did not write. This repo is
the **LLM-judge** instance — and, in the seventh family, the one that supplied the
near-miss.

| repo | domain | the question it asks |
|---|---|---|
| [decision-confidence](https://github.com/Beltran12138/decision-confidence) | third-party risk vendors | do these vendors answer the same question? |
| **assay** ← you are here | LLM-as-judge | does this metric measure what its name claims? |
| [prophetmap](https://github.com/Beltran12138/prophetmap) | self-built equity scoring | does my own score survive my own rule? |

Cross-domain evidence → [`failure-families.md`](https://github.com/Beltran12138/decision-confidence/blob/main/docs/failure-families.md)

---

## Why this exists

The 2026 standard for customer-service agents is
[τ²-bench](https://github.com/sierra-research/tau2-bench): it scores an agent by
diffing the **final database state** against an annotated goal. No LLM judge is
involved, so there is nothing to be biased.

That design only covers tasks with a world state to diff — a return, a
cancellation, a plan change. It does not cover the other half of a support
queue: **knowledge questions**. "What's the withdrawal fee?" changes no
database row. There is no state to compare, so in practice these are graded by
an LLM judge — and the judge layer ships with no verification of its own.

`assay` is that missing layer. τ²-bench is not a leaderboard to climb here; it
is a **ruler**. Because its verdicts are deterministic, they can be used to
measure how far an LLM judge drifts on the same trajectories.

## The three checks

### 1. Self-preference

Using the same model to generate an answer and to grade it is widely reported to
inflate the score — roughly 10–25% for same-model pairs, surviving even
programmatically verifiable rubrics.

**This repo's own measurement does not reproduce that as a rule.** Across a 3×3
generator × judge matrix, one model shows +0.114, one shows **−0.373**, one is
flat, and the mean residual is negative. The naive single-generator version of
the same experiment returned +0.177 — the expected answer — and it was wrong,
because "same family" was collinear with judge strictness. Both numbers, and
why the first was discarded, are in [FINDINGS #5](FINDINGS.md).

Which is the point: the effect is real enough to matter and unstable enough that
you cannot assume its direction for *your* judge. So `assay` refuses to report a
score without naming the generator and the judge, flags the pair when they share
a model family, and does not tell you which way the bias runs — it makes you
measure it.

### 2. Mirror drift

An eval that reimplements the retrieval logic it is testing will pass while
production fails, because the copy and the original share the same bug. An eval
that stubs out the production path tests something that never runs.

`assay` calls the same entry point the application calls, and its assertions are
anchored to independently sourced expectations rather than to a second copy of
the implementation.

### 3. Construct conflation

**Faithfulness is not correctness.** Faithfulness asks "did the answer stay
inside the retrieved context"; correctness asks "is the answer true". A system
scoring 0.95 faithfulness on a stale or wrong context is faithfully repeating
something false — and the metric reports that as success.

`assay` keeps them as separate constructs and **never averages across
constructs**. When the two disagree — high faithfulness, low correctness — that
is not noise to be smoothed away; it is the single most informative signal in
the report, and it points at the corpus, not the model.

## Layout

```
lib/          reference support agent under test (Next.js + RAG)
              intent routing → retrieval → generation → human handoff
lib/knowledge/ fixture FAQ corpus for a fictional exchange ("Acme")
scripts/      eval entry points
supabase/     schema for the reference agent
```

The chat application in this repo is not the product. It is the **fixture** —
a real, non-trivial RAG support agent to point the harness at, so the checks
are exercised against something that behaves like production rather than a toy.

## Running it

```bash
npm install
npm test            # golden cases: intent routing + retrieval, no network
npm run eval        # judge-scored eval of the reference agent
npm run selfpref    # generator × judge matrix (see below)
npm run sensitivity # can this harness still detect a failure it is known to have?
```

`eval` needs `DEEPSEEK_API_KEY`. `selfpref` additionally needs
`ASSAY_JUDGE_BASE_URL` and `ASSAY_JUDGE_API_KEY` for the cross-family judges.

`sensitivity` is the control the other two do not contain: known-label inputs in,
known verdicts expected out. It exits 1 when a control fails and 2 when one could
not run, because a control that did not run is not a control that passed. **It
currently exits 1** — on purpose. Both failures are findings, not bugs in the
script: judges miss a hallucination at realistic density, and the cases dropped
from the matrix are the same three every run. See FINDINGS #7.

`selfpref` runs every model as both writer and grader and reports the residual
on the diagonal after subtracting each model's leniency and each model's
quality. The naive version of this experiment — one generator, self judge vs
cross judges — is not implemented on purpose: it confounds self-preference with
judge strictness, and the confound is not small. See FINDINGS #5.

Generated answers are frozen to `fixtures/answers/` and committed, so the
grading half of the experiment is reproducible without re-running generation.

## Honest limitations

- **The corpus is fiction.** The FAQ describes a made-up exchange. It is
  internally consistent and adequate for exercising retrieval, but no claim in
  it is a fact about any real venue.
- **One fixture, one domain.** Everything is Chinese-language crypto exchange
  support. Nothing here shows the checks generalize.
- **No published measurement yet.** The self-preference number for this
  pipeline has not been measured. Until it is, the claim above is borrowed from
  the literature, not from this repo.
- **The reference agent is a single model behind eight prompts.** It routes by
  keyword to one of eight system prompts; there is no agent-to-agent handoff and
  no planner. Calling that "multi-agent" would be a stretch, so this README
  doesn't.

## References

- Yao et al., *τ-bench* / [tau2-bench](https://github.com/sierra-research/tau2-bench) — deterministic state-diff scoring for CS agents
- [Self-Preference Bias in Rubric-Based Evaluation of LLMs](https://arxiv.org/abs/2604.06996) — bias persists under verifiable rubrics
- [Agreement Measurement for Rubric-based LLM Judges](https://arxiv.org/abs/2606.00093) — why agreement numbers across differing rubrics aren't comparable
- [AI Self-preferencing in Algorithmic Hiring](https://arxiv.org/abs/2509.00462) — self-preference measured against controlled quality

## License

MIT
