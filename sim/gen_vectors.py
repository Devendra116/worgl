"""Generate fixed test vectors from the Python reference maths -> contract/tests/vectors.json"""
import json, random, sys, os
sys.path.insert(0, os.path.dirname(__file__))
from worgl_math import *

rng = random.Random(20261114)
out = {"factor_demo": str(FACTOR_DEMO), "factor_real": str(FACTOR_REAL), "rpow": [], "ops": []}
for name, f in (("demo", FACTOR_DEMO), ("real", FACTOR_REAL)):
    ns = [0, 1, 2, 3, 59, 60, 600, 601, 3600, 86400, 86401, 604800, 2592000, 2592001, 31536000]
    ns += [rng.randrange(0, 2_000_000) for _ in range(40)]
    for n in ns:
        if name == "demo" and n > 3_000_000: continue
        out["rpow"].append({"factor": str(f), "n": n, "index": str(rpow(f, n))})
# ops at a range of indexes (demo, up to ~ 3 days)
for _ in range(300):
    n = rng.randrange(0, 260_000)
    idx = rpow(FACTOR_DEMO, n)
    shares = rng.randrange(1, 10**26)
    amount = rng.randrange(1, 10**24)
    out["ops"].append({
        "index": str(idx), "shares": str(shares), "amount": str(amount),
        "balance": str(balance(shares, idx)),
        "circulating": str(circulating(shares, idx)),
        "shares_floor": str(shares_floor(amount, idx)),
        "shares_ceil": str(shares_ceil(amount, idx)),
    })
path = os.path.join(os.path.dirname(__file__), "..", "contract", "tests", "vectors.json")
json.dump(out, open(path, "w"), indent=1)
print("wrote", len(out["rpow"]), "rpow vectors,", len(out["ops"]), "op vectors")
