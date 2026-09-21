#!/usr/bin/env python3
"""Reverse-engineer what TypeSafe's `confidence` field actually computes.

Backs FINDINGS #17. Run before reading any arm-A result: the whole comparison
depends on knowing whether `confidence` is an independent prediction or a
restatement of a number the response already carries.

`docs.typesafe.ai/confidence.md` says confidence is "a statistic computed from
the probability distribution the answer already gives you" and offers
`(n*peak-1)/(n-1)` as an *approximation* for three options. The word
"approximate" is theirs, and an approximation is not something you can build a
reading on. So measure it: send states that span the certainty range, carry
Choice and Score questions at several option counts, and fit every plausible
closed form against what comes back.

    TYPESAFE_API_KEY=... python scripts/probe_jev_confidence.py

Standard library only. Shells out to curl so the run works wherever curl's
proxy configuration already does, which on some machines is the only thing that
reaches the API at all.
"""

import json
import math
import os
import pathlib
import subprocess
import sys

URL = "https://api.typesafe.ai/v1/systemone"

# Pinned, never the `jev-latest` alias. The docs' own model page says to pin a
# version if you have tuned thresholds against it; a reverse-engineering run has
# the same requirement for a stronger reason — an alias that moves mid-run turns
# a version change into an apparent property of the formula.
MODEL = "jev-1.13.0"

OUT = pathlib.Path(__file__).parent.parent / "fixtures" / "jev-confidence-pairs.json"

# Two unambiguous states, two genuinely borderline, one degenerate. A fit that
# only ever sees peak≈1.0 cannot separate the candidates: they all agree there.
STATES = {
    "clear_tech": "The OAuth callback returns a 500 every single time. Stack trace attached. This is a bug in your SDK.",
    "clear_billing": "I was charged $49 twice on the same day for one subscription. Please refund the duplicate.",
    "murky": "I'm not sure this is the right place to ask, but something feels off with my account since last week.",
    "mixed": "The integration broke after your update AND I got billed for a plan I downgraded from. Both need fixing.",
    "terse": "help",
}

# The same underlying judgment at growing option counts. Distractors are real
# categories rather than nonsense, so the distribution stays informative as n
# grows instead of collapsing onto one option by default.
OPTS = ["billing", "technical", "sales", "legal",
        "security", "shipping", "partnerships", "press"]
DESC = {
    "billing": "Payment, invoicing, refunds or subscription charges",
    "technical": "Bugs, outages, API errors or integration problems",
    "sales": "Pricing, upgrades, quotes or new accounts",
    "legal": "Contracts, compliance, terms or data processing",
    "security": "Vulnerabilities, breaches, access control or abuse",
    "shipping": "Physical delivery, logistics or returns",
    "partnerships": "Reseller, referral or co-marketing enquiries",
    "press": "Media enquiries, interviews or analyst briefings",
}
LEVELS = ["Calm, purely factual", "Mildly annoyed", "Clearly frustrated",
          "Angry, strong language", "Abusive"]


def questions():
    q = {}
    for n in (2, 3, 4, 5, 8):
        q[f"choice_{n}"] = {
            "type": "choice",
            "instructions": "Which team should handle this message",
            "criteria": {k: DESC[k] for k in OPTS[:n]},
        }
    for n in (3, 4, 5):
        q[f"score_{n}"] = {
            "type": "score",
            "instructions": "How frustrated the sender appears",
            "criteria": LEVELS[:n],
        }
    return q


def call(key, state):
    body = json.dumps({"state": state, "model": MODEL, "questions": questions()})
    p = subprocess.run(
        ["curl", "-sS", "-X", "POST", URL,
         "-H", f"Authorization: Bearer {key}",
         "-H", "Content-Type: application/json",
         "--max-time", "90", "-d", "@-"],
        input=body, capture_output=True, text=True, encoding="utf-8",
    )
    if p.returncode != 0:
        raise SystemExit(f"curl failed: {p.stderr[:400]}")
    r = json.loads(p.stdout)
    if "answers" not in r:
        raise SystemExit(f"API error: {json.dumps(r)[:400]}")
    return r


# --- candidate closed forms --------------------------------------------------
# Unordered first: every one of these is a concentration measure, and none of
# them can exceed the peak. That shared ceiling is what the Score data breaks.

def f_demo(p, n):
    """(n*peak - 1)/(n - 1) — the docs' own approximation."""
    return max(0.0, min(1.0, (n * max(p) - 1) / (n - 1)))


def f_entropy(p, n):
    h = -sum(x * math.log(x) for x in p if x > 0)
    return 1 - h / math.log(n) if n > 1 else 1.0


def f_gini(p, n):
    return (n * sum(x * x for x in p) - 1) / (n - 1)


def f_margin(p, n):
    s = sorted(p, reverse=True)
    return s[0] - (s[1] if len(s) > 1 else 0.0)


def f_tv(p, n):
    u = 1.0 / n
    return sum(abs(x - u) for x in p) / (2 * (1 - u)) if n > 1 else 1.0


# Ordered-aware, for Score only. Mass on two ADJACENT levels is not the same
# uncertainty as mass on two distant ones, and a spread-aware statistic is
# allowed to exceed the peak — which the unordered family above cannot do.

def _moments(p):
    mu = sum(i * x for i, x in enumerate(p))
    return mu, sum(x * (i - mu) ** 2 for i, x in enumerate(p))


def s_std(p, n):
    _, var = _moments(p)
    return 1 - math.sqrt(var) / ((n - 1) / 2.0) if n > 1 else 1.0


def s_var(p, n):
    _, var = _moments(p)
    return 1 - var / (((n - 1) / 2.0) ** 2) if n > 1 else 1.0


def s_sd_unit(p, n):
    _, var = _moments(p)
    return max(0.0, 1 - math.sqrt(var))


def s_pair(p, n):
    if n < 2:
        return max(p)
    best = max(p[i] + p[i + 1] for i in range(n - 1))
    return max(0.0, min(1.0, 2 * best - 1))


def s_mad(p, n):
    mu, _ = _moments(p)
    mad = sum(x * abs(i - mu) for i, x in enumerate(p))
    return 1 - mad / ((n - 1) / 2.0) if n > 1 else 1.0


UNORDERED = {
    "demo (n*peak-1)/(n-1)": f_demo,
    "1 - H/log n": f_entropy,
    "gini (n*sum p^2-1)/(n-1)": f_gini,
    "peak - second": f_margin,
    "TV from uniform": f_tv,
}
ORDERED = {**UNORDERED, "1 - sd/sd_max": s_std, "1 - var/var_max": s_var,
           "1 - sd (level units)": s_sd_unit, "adjacent pair 2q-1": s_pair,
           "1 - mad/mad_max": s_mad}

# The API reports probabilities and confidence to two decimals, so agreement can
# never be asserted tighter than half a step either side.
TOL = 0.0105


def fit(title, rows, cands):
    print("=" * 92)
    print(f"{title}   ({len(rows)} pairs)")
    print("=" * 92)
    for r in sorted(rows, key=lambda r: (r["n"], -max(r["probs"]))):
        pv = " ".join(f"{x:.2f}" for x in r["probs"])
        print(f"{r['q']:<10}{r['n']:>3}  peak {max(r['probs']):.2f}"
              f"  conf {r['conf']:.2f}   [{pv}]")
    print()
    print(f"{'candidate':<26}{'max|err|':>10}{'mean|err|':>11}{'within 2dp':>13}   verdict")
    best = None
    for k, fn in cands.items():
        e = [abs(fn(r["probs"], r["n"]) - r["conf"]) for r in rows]
        mx, mn = max(e), sum(e) / len(e)
        hits = sum(1 for x in e if x <= TOL)
        v = "EXACT (to 2dp)" if mx <= TOL else ("close" if mx < 0.05 else "no")
        print(f"{k:<26}{mx:>10.4f}{mn:>11.4f}{hits:>8}/{len(e):<4}   {v}")
        if best is None or mx < best[1]:
            best = (k, mx)
    print()
    return best


def main():
    key = os.environ.get("TYPESAFE_API_KEY")
    if not key:
        sys.exit("TYPESAFE_API_KEY is not set. This script never stores a key.")

    rows = []
    for name, state in STATES.items():
        r = call(key, state)
        for qid, a in r["answers"].items():
            if "confidence" not in a:
                continue          # Noul carries none; that is itself the finding
            probs = a["probabilities"]
            vec = [probs[k] for k in sorted(probs, key=str)]
            rows.append({"state": name, "q": qid, "n": len(vec),
                         "probs": vec, "conf": a["confidence"]})
        print(f"  {name:<14} {len(r['answers'])} answers, "
              f"{r['usage']['input_tokens']} in-tok, model {r['model']}")
    print(f"\n{len(rows)} (probabilities, confidence) pairs\n")

    ch = [r for r in rows if r["q"].startswith("choice")]
    sc = [r for r in rows if r["q"].startswith("score")]
    fit("CHOICE — unordered options", ch, UNORDERED)
    fit("SCORE — ordered levels", sc, ORDERED)

    print("=" * 92)
    print("Can confidence exceed the peak probability it is confident about?")
    print("=" * 92)
    for nm, grp in (("Choice", ch), ("Score", sc)):
        over = [r for r in grp if r["conf"] > max(r["probs"]) + 1e-9]
        print(f"  {nm}: {len(over)}/{len(grp)}")
        for r in over:
            print(f"    n={r['n']}  peak {max(r['probs']):.2f} -> conf {r['conf']:.2f}"
                  f"   [{' '.join(f'{x:.2f}' for x in r['probs'])}]")
    print()
    print("  No concentration measure on an unordered distribution can exceed its")
    print("  own peak. Score doing so is proof the two types do not share a")
    print("  definition, independent of which closed form Score actually uses.")

    print()
    print("=" * 92)
    print("A threshold on `confidence` is not a threshold on probability")
    print("=" * 92)
    print("  Inverting the Choice form: peak = (conf*(n-1) + 1)/n")
    print(f"{'n options':>10} |" + "".join(f"{'conf=' + str(c):>12}" for c in (0.5, 0.7, 0.9)))
    for n in (2, 3, 4, 5, 10, 20):
        print(f"{n:>10} |" + "".join(f"{(c*(n-1)+1)/n:>12.4f}" for c in (0.5, 0.7, 0.9)))
    for c in (0.5, 0.7, 0.9):
        v = [(c * (n - 1) + 1) / n for n in range(2, 21)]
        print(f"  conf={c}: admits peak {min(v):.3f}..{max(v):.3f}"
              f"   spread {100*(max(v)-min(v)):.1f}pt across n=2..20")

    OUT.write_text(json.dumps(rows, indent=2))
    print(f"\nraw pairs -> {OUT}")


if __name__ == "__main__":
    main()
