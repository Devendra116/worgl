"""60-day simulation of Wörgl using the contract's integer maths (sim/worgl_math.py).

Usage: python3 sim/simulate.py [--period-days 1] [--out sim/simulation.png]

The decay rate used here is *illustrative*: 1% per day, so that 60 days shows visible
dynamics. (The real setting, 1% per 30 days, would only decay ~2% in 60 days; the demo
setting, 1% per 10 minutes, would reduce everything to dust in under a day.)
Everything else - rpow, shares, floor/ceil rules, treasury = supply - ceil(circulating) -
is exactly the contract's arithmetic.
"""
import argparse, os, random, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from worgl_math import *

DAY = 86_400
N = 100
DAYS = 60
PAYOUT_PCT_OF_TREASURY = 0.5    # treasury pays out 0.5% of itself per day...
CAP_PCT = 10                    # ...well under the 10% daily cap of the contract
SPEND_FRACTION = (30, 70)       # spenders send 30-70% of their balance away each day


def run(scenario_hoarders: int, factor: int, seed: int):
    rng = random.Random(seed)
    shares = [0] * N
    total_shares = 0
    # wallets [0, hoarders) hoard; the rest spend. We track wallet 0 (hoarder) and N-1 (spender).
    hoarder = lambda i: i < scenario_hoarders  # wallet 0 is also the tracked idle wallet
    hist = {"treasury": [], "circulating": [], "hoarder": [], "spender": []}

    # Two tracked wallets: "idle" (wallet 0) claims once and then never moves or receives,
    # "paid" (wallet N-1) receives a regular daily treasury payout on top of its claim.
    # (Both are otherwise ordinary wallets of the scenario; the rest of the crowd is the
    # hoarder/spender mix that defines the scenario.)
    # day 0: everyone claims 100 coins from the faucet
    idx = rpow(factor, 0)
    for i in range(N):
        s = shares_floor(100 * 10**DECIMALS, idx)
        shares[i] += s; total_shares += s

    for day in range(DAYS + 1):
        idx = index_at(factor, day * DAY)
        circ = circulating(total_shares, idx)
        treasury = TOTAL_SUPPLY - circ
        assert circ <= TOTAL_SUPPLY
        hist["treasury"].append(treasury)
        hist["circulating"].append(circ)
        hist["hoarder"].append(balance(shares[0], idx))
        hist["spender"].append(balance(shares[N - 1], idx))
        if day == DAYS:
            break
        # --- activity during the day (uses next day's index as "now" for simplicity) ---
        idx = index_at(factor, (day + 1) * DAY)
        # spenders move part of their balance to random other wallets
        for i in range(N):
            if hoarder(i):
                continue
            b = balance(shares[i], idx)
            amt = b * rng.randint(*SPEND_FRACTION) // 100
            if amt == 0:
                continue
            j = rng.randrange(scenario_hoarders, N)   # spenders trade among spenders only
            if j == i:
                continue
            loss = shares_ceil(amt, idx); gain = shares_floor(amt, idx)
            shares[i] -= loss; shares[j] += gain; total_shares -= loss - gain
        # treasury pays out a slice of itself, split equally across all wallets EXCEPT the
        # tracked idle wallet 0 (it never receives anything after its claim)
        circ = circulating(total_shares, idx)
        treasury = TOTAL_SUPPLY - circ
        pay = treasury * int(PAYOUT_PCT_OF_TREASURY * 10) // 1000
        assert pay <= treasury * CAP_PCT // 100
        each = pay // (N - 1)
        for i in range(1, N):
            s = shares_floor(each, idx)
            shares[i] += s; total_shares += s
    return hist


def main():
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    ap = argparse.ArgumentParser()
    ap.add_argument("--period-days", type=float, default=1.0, help="days over which balances lose 1%%")
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "simulation.png"))
    a = ap.parse_args()
    factor = factor_for(int(a.period_days * DAY))

    scenarios = [("Mostly hoarders (80 hoard / 20 spend)", 80),
                 ("Mostly spenders (20 hoard / 80 spend)", 20),
                 ("Mixed (50 / 50)", 50)]
    fig, axes = plt.subplots(2, 3, figsize=(15, 8), sharex=True)
    C = 10**DECIMALS
    for col, (title, hoarders) in enumerate(scenarios):
        h = run(hoarders, factor, seed=col + 1)
        days = list(range(DAYS + 1))
        ax = axes[0][col]
        ax.plot(days, [x / C for x in h["treasury"]], label="Treasury", color="#1f77b4")
        ax.plot(days, [x / C for x in h["circulating"]], label="Circulating", color="#d62728")
        ax.set_title(title, fontsize=10); ax.set_yscale("log")
        if col == 0: ax.set_ylabel("coins (log)")
        ax.legend(fontsize=8); ax.grid(alpha=.3)
        ax = axes[1][col]
        ax.plot(days, [x / C for x in h["hoarder"]], label="Idle holder (claims once, then nothing)", color="#7f7f7f")
        ax.plot(days, [x / C for x in h["spender"]], label="Paid by the treasury (regular payouts)", color="#2ca02c")
        ax.set_xlabel("day")
        if col == 0: ax.set_ylabel("tracked wallet balance (coins)")
        ax.legend(fontsize=8); ax.grid(alpha=.3)
        print(f"{title}: day60 treasury={h['treasury'][-1]/C:,.0f} circ={h['circulating'][-1]/C:,.2f} "
              f"idle={h['hoarder'][-1]/C:.2f} paid={h['spender'][-1]/C:.2f}")
    fig.suptitle(f"Wörgl, 60 days, 100 wallets. ILLUSTRATIVE decay rate: 1% per {a.period_days:g} day "
                 f"(real setting: 1% per 30 days). Treasury pays out {PAYOUT_PCT_OF_TREASURY}% of itself daily.",
                 fontsize=11)
    fig.text(0.5, 0.005,
             "Treasury and circulation are identical across scenarios because transfers cannot avoid the melt: "
             "every holder decays at the same rate, so only payouts and decay move the totals.",
             ha="center", fontsize=9, style="italic")
    fig.tight_layout(rect=(0, 0.03, 1, 1))
    fig.savefig(a.out, dpi=110)
    print("wrote", a.out)


if __name__ == "__main__":
    main()
