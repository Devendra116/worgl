"""Reference integer maths for Wörgl. Mirrors contract/src/math.rs exactly."""
from decimal import Decimal, getcontext

getcontext().prec = 80
RAY = 10**27
DECIMALS = 18
TOTAL_SUPPLY = 1_000_000 * 10**DECIMALS


def factor_for(period_seconds: int, keep: str = "0.99") -> int:
    """Per-second decay factor (RAY scale) so that factor^period = keep. Rounded down."""
    f = (Decimal(keep).ln() / Decimal(period_seconds)).exp()
    return int(f * RAY)  # int() truncates toward zero == floor for positives


FACTOR_DEMO = factor_for(3600)         # 1% per hour (demo)
FACTOR_REAL = factor_for(2_592_000)    # 1% per 30 days


def rpow(factor: int, n: int) -> int:
    """Exponentiation by squaring in RAY fixed point, rounding DOWN at every step."""
    result = RAY
    base = factor
    while n > 0:
        if n & 1:
            result = result * base // RAY
        n >>= 1
        if n:
            base = base * base // RAY
    return result


def index_at(factor: int, elapsed_s: int) -> int:
    return rpow(factor, elapsed_s)


def balance(shares: int, index: int) -> int:
    return shares * index // RAY


def circulating(total_shares: int, index: int) -> int:
    return -((-total_shares * index) // RAY)  # ceil


def shares_floor(amount: int, index: int) -> int:
    return amount * RAY // index


def shares_ceil(amount: int, index: int) -> int:
    return -((-amount * RAY) // index)


if __name__ == "__main__":
    print("FACTOR_DEMO =", FACTOR_DEMO)
    print("FACTOR_REAL =", FACTOR_REAL)
    for name, f, p in (("demo", FACTOR_DEMO, 3600), ("real", FACTOR_REAL, 2_592_000)):
        got = rpow(f, p)
        rel = abs(Decimal(got) - Decimal(99) * Decimal(RAY) / 100) / (Decimal(99) * Decimal(RAY) / 100)
        print(name, "rpow(period) =", got, "rel err =", rel)
