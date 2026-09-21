#!/usr/bin/env python3
"""How many labelled decisions a calibration bin needs before it can say anything.

Backs the two power tables in ``docs/STATED-CONFIDENCE.md``. Run it before
running any arm: if the bins cannot reach the effect size you care about, the
experiment is already decided and the answer is "not enough data".

Standard library only, no network, writes nothing.

    python scripts/stated_power.py

One deliberate constraint: this uses the *same* two-proportion arithmetic as the
minimum-decision-count work in ``decision-confidence`` rather than a second
formula that happens to agree. A harness that audits construct conflation should
not quietly run two definitions of sample size.
"""

import math

# One-sided alpha = 0.05, power = 80%. Conventional, and stated rather than
# buried: changing either changes every number below.
ALPHA, POWER = 0.05, 0.80


def Phi(z: float) -> float:
    return 0.5 * math.erfc(-z / math.sqrt(2.0))


def z_of(p: float) -> float:
    """Phi^{-1}(p) by bisection. Slow, exact enough, no dependency."""
    lo, hi = -10.0, 10.0
    for _ in range(200):
        mid = (lo + hi) / 2
        if Phi(mid) < p:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


ZA, ZB = z_of(1 - ALPHA), z_of(POWER)


def n_for(p0: float, delta: float):
    """Samples needed to show a bin stamped p0 is really p0 - delta.

    delta is signed toward overconfidence, which is the direction that costs
    something in production: a threshold set at p0 fires more often than the
    error budget allows.
    """
    p1 = p0 - delta
    if p1 <= 0:
        return None
    num = (ZA * math.sqrt(p0 * (1 - p0)) + ZB * math.sqrt(p1 * (1 - p1))) ** 2
    return math.ceil(num / delta ** 2)


def delta_for(p0: float, n: int) -> float:
    """Inverse: with n in the bin, the smallest overconfidence still detectable."""
    lo, hi = 1e-5, p0 - 1e-6
    for _ in range(200):
        mid = (lo + hi) / 2
        need = n_for(p0, mid)
        if need is None or need > n:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def wilson(k: int, n: int, z: float = 1.96):
    """Wilson interval. Every reliability-diagram point gets one of these.

    The normal approximation degrades exactly where calibration matters most —
    near p = 1 with few samples — which is the top bin.
    """
    if n == 0:
        return (0.0, 1.0)
    p = k / n
    d = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / d
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (centre - half, centre + half)


def main() -> None:
    deltas = (0.01, 0.02, 0.03, 0.05, 0.10)
    print("=" * 74)
    print(f"Samples needed in one bin  (one-sided a={ALPHA}, power={POWER:.0%})")
    print("=" * 74)
    print(f"{'bin stated':>11} |" + "".join(f"{'d=' + str(int(d * 100)) + 'pt':>9}" for d in deltas))
    for p0 in (0.95, 0.90, 0.80, 0.70, 0.60):
        row = f"{p0:>11.2f} |"
        for d in deltas:
            n = n_for(p0, d)
            row += f"{(n if n else '-'):>9}"
        print(row)

    ns = (50, 100, 200, 500, 1000)
    print()
    print("=" * 74)
    print("Inverse: smallest overconfidence a bin of size n can catch")
    print("=" * 74)
    print(f"{'bin stated':>11} |" + "".join(f"{'n=' + str(n):>11}" for n in ns))
    for p0 in (0.95, 0.90, 0.80):
        row = f"{p0:>11.2f} |"
        for n in ns:
            row += f"{delta_for(p0, n) * 100:>9.1f}pt"
        print(row)

    print()
    print("=" * 74)
    print("What a 777-judgment vibe check can see, in the 0.95 bin")
    print("=" * 74)
    for share, label in ((1.0, "all 777 in one bin (impossible; upper bound)"),
                         (0.6, "60% piled into 0.9-1.0"),
                         (0.1, "spread evenly over 10 bins")):
        n = int(777 * share)
        print(f"  {label:<44} n={n:>4}  floor {delta_for(0.95, n) * 100:>4.1f}pt")

    print()
    print("  Wilson 95% interval at an observed 0.95:")
    for n in (78, 200, 466, 777):
        lo, hi = wilson(round(0.95 * n), n)
        print(f"    n={n:>4}: [{lo:.3f}, {hi:.3f}]   width {100 * (hi - lo):>4.1f}pt")

    print()
    print("=" * 74)
    print("Why a few points matter: cost at an auto-execute threshold")
    print("=" * 74)
    for claimed, actual in ((0.95, 0.92), (0.95, 0.90), (0.90, 0.85)):
        print(f"  stated {claimed:.2f}, actual {actual:.2f}:  error {1 - claimed:>5.1%} -> {1 - actual:>5.1%}"
              f"   ({(1 - actual) / (1 - claimed):.1f}x)")

    print()
    print("=" * 74)
    print("The binned metrics are not the only option: paired Brier needs no bins")
    print("=" * 74)
    print("  ECE / reliability / resolution are all set by the THINNEST BIN, so their")
    print("  precision tracks n/bins, not n. Brier is a plain mean over items, and under")
    print("  pairing the shared item difficulty cancels. Samples needed for a paired")
    print("  difference in Brier, by the per-item standard deviation of that difference:")
    print()
    print(f"{'sd of paired diff':>18} |" + "".join(f"{'d=' + f'{d:.3f}':>11}" for d in (0.005, 0.010, 0.020, 0.040)))
    for sd in (0.05, 0.10, 0.20, 0.30):
        row = f"{sd:>18.2f} |"
        for d in (0.005, 0.010, 0.020, 0.040):
            row += f"{math.ceil((ZA + ZB) ** 2 * sd * sd / (d * d)):>11}"
        print(row)
    print()
    print("  sd has to be measured, not guessed — run the arms on whatever labels exist")
    print("  and read it off. Everything above is the shape of the answer, not the answer.")

    print()
    print("=" * 74)
    print("Ground truth on disk")
    print("=" * 74)
    print("  421 items:  379 en (census, extended 2026-09-19 from a 72-row sample)")
    print("            +  42 zh (census)")
    print("  Kish n_eff = 421.0 once labelled; every weight is 1.")
    print()
    print("  ⚠ Before the extension it was 114 rows worth n_eff 42.1 — the strata were cut")
    print("    to measure detector recall, so weights ran 1.47 to 15.20. Row count is not")
    print("    precision whenever a sample is weighted.")
    print()
    print(f"  At 10 bins that is ~42 per bin → floor {delta_for(0.95, 42) * 100:.0f}pt in the 0.95 bin.")
    print("  Enough to falsify a large miscalibration; not enough to certify a small one.")
    print("  Paired Brier, which needs no bins, remains the comparison with real power.")


if __name__ == "__main__":
    main()
