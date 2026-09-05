#!/usr/bin/env python3
"""
Offline consensus simulation for the MultiSourceOracle contract.

This harness loads the REAL contract source (contracts/oracle.py), swaps the
`genlayer` runtime for a deterministic mock, and drives the exact leader /
validator functions that `update()` passes to `gl.vm.run_nondet_unsafe`.

It proves the consensus properties the reviewer required:

  T1  identical node views                 -> accepted, exact value persisted
  T2  medians differ (within old tolerance)-> REJECTED (old logic accepted!)
  T3  leader claims unfaithful median      -> REJECTED (claims bound to data)
  T4  leader reports unknown source        -> REJECTED
  T5  sources disagree for every node      -> failure verified, nothing published
  T6  validator loses one source           -> REJECTED (outcome changed)
  T7  even sample count (2 sources)        -> accepted, averaged median exact
  T8  benign per-source noise, same outcome-> accepted (robustness)

Run:  python sim_consensus.py   (no dependencies, stdlib only)
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CONTRACT = os.path.join(HERE, "contracts", "oracle.py")

CB = "https://api.coinbase.com/v2/prices/BTC-USD/spot"
CG = "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"
KR = "https://api.kraken.com/0/public/Ticker?pair=XBTUSD"
URLS = [CB, CG, KR]


def _coinbase(v):
    return json.dumps({"data": {"amount": str(v)}})


def _coingecko(v):
    return json.dumps({"bitcoin": {"usd": v}})


def _kraken(v):
    return json.dumps({"result": {"XXBTZUSD": {"c": [str(v), "1", "100"]}}})


BODY = {CB: _coinbase, CG: _coingecko, KR: _kraken}


# --------------------------------------------------------------------------
# Deterministic stand-in for the `genlayer` SDK surface used by the contract.
# --------------------------------------------------------------------------
class _Resp:
    def __init__(self, text):
        self.body = text.encode("utf-8")


class _Web:
    def get(self, url):
        view = GL.current_view
        if view is None:
            raise RuntimeError("fetch outside consensus context")
        if url not in view or view[url] is None:
            raise RuntimeError("simulated network failure: " + url)
        return _Resp(BODY[url](view[url]))


class _Nondet:
    def __init__(self):
        self.web = _Web()


class _Return:
    def __init__(self, calldata):
        self.calldata = calldata


class _VM:
    Return = _Return

    def run_nondet_unsafe(self, leader_fn, validator_fn):
        # Leader executes first, then each validator votes on the leader's
        # (possibly tampered) result using its own independent view.
        GL.current_view = GL.leader_view
        raw = leader_fn()
        if GL.tamper is not None:
            raw = GL.tamper(raw)
        votes = []
        for vw in GL.validator_views:
            GL.current_view = vw
            try:
                votes.append(bool(validator_fn(_Return(raw))))
            except Exception:
                votes.append(False)
        GL.current_view = None
        GL.last_votes = votes
        if sum(1 for v in votes if v) * 2 <= len(votes):
            raise AssertionError("simulated consensus failure: votes=" + json.dumps(votes))
        return raw


class _Public:
    def view(self, fn):
        return fn

    def write(self, fn):
        return fn


class _Message:
    sender_address = "0xSIMSENDER"


class _ContractBase:
    pass


class _Gl:
    def __init__(self):
        self.nondet = _Nondet()
        self.vm = _VM()
        self.public = _Public()
        self.message = _Message()
        self.Contract = _ContractBase
        self.leader_view = None
        self.validator_views = []
        self.current_view = None
        self.tamper = None
        self.last_votes = None


GL = _Gl()

# --------------------------------------------------------------------------
# Load the real contract, replacing only the genlayer import.
# --------------------------------------------------------------------------
with open(CONTRACT, encoding="utf-8") as f:
    src = f.read()
src = src.replace("from genlayer import *", "gl = GL", 1)
NS = {"GL": GL, "gl": GL, "__name__": "oracle_under_test"}
exec(compile(src, CONTRACT, "exec"), NS)
MultiSourceOracle = NS["MultiSourceOracle"]

RESULTS = []


def check(cond, label):
    RESULTS.append((bool(cond), label))
    print(("  PASS  " if cond else "  FAIL  ") + label)


def fresh(urls=None, tol=100, spread=500, dec=2):
    c = MultiSourceOracle()
    c.register_feed("btc_usd", "sim feed", json.dumps(urls or URLS), tol, spread, dec)
    return c


def attempt(c):
    GL.last_votes = None
    try:
        c.update("btc_usd")
        return None
    except Exception as e:
        return e


def stored(c):
    return json.loads(c.values).get("btc_usd", {})


print("MultiSourceOracle offline consensus simulation")
print("contract under test:", CONTRACT)
print("(tolerance_bps=100, max_spread_bps=500, decimals=2 — same as register.mjs)")

# T1: every node sees the same three prices -------------------------------
print("\n[T1] identical node views -> exact acceptance + persistence")
c = fresh()
GL.tamper = None
GL.leader_view = {CB: 100000.5, CG: 100000.7, KR: 100000.3}
GL.validator_views = [dict(GL.leader_view) for _ in range(3)]
err = attempt(c)
check(GL.last_votes == [True, True, True], "all validators accept")
check(err is None, "update succeeds")
s = stored(c)
check(s.get("median_units") == 10000050, "persisted median_units == verified 10000050")
check(s.get("value") == 100000.5 and s.get("sources_used") == 3 and s.get("spread_bps") == 0,
      "persisted value/spread/sources match the verified outcome")

# T2: validator medians differ but stay inside the OLD tolerance band -----
print("\n[T2] validator median differs (within old tolerance band) -> REJECT")
c = fresh()
GL.tamper = None
GL.leader_view = {CB: 100000.0, CG: 100000.0, KR: 100000.0}
GL.validator_views = [{CB: 100500.0, CG: 100500.0, KR: 100500.0} for _ in range(3)]
err = attempt(c)
check(GL.last_votes == [False, False, False], "validators reject differing medians (no range acceptance)")
check(err is not None, "update fails, nothing published")
old_lu, old_vu, old_tol = 10000000, 10050000, 100
old_would_accept = abs(old_lu - old_vu) * 10000 <= old_tol * abs(old_lu)
check(old_would_accept and GL.last_votes == [False, False, False],
      "REGRESSION PROOF: old tolerance formula would have accepted this exact case")

# T3: leader result does not match its own provenance ---------------------
print("\n[T3] leader claims a median its provenance does not support -> REJECT")


def tamper_median(raw):
    d = json.loads(raw)
    d["median_units"] = 99999999
    return json.dumps(d)


c = fresh()
GL.tamper = tamper_median
GL.leader_view = {CB: 100000.5, CG: 100000.7, KR: 100000.3}
GL.validator_views = [dict(GL.leader_view) for _ in range(3)]
err = attempt(c)
check(GL.last_votes == [False, False, False], "claims are bound to provenance (unfaithful median rejected)")
check(err is not None, "update fails, nothing published")

# T4: leader reports a source that is not part of the feed ---------------
print("\n[T4] leader reports unknown source URL -> REJECT")


def tamper_source(raw):
    d = json.loads(raw)
    d["provenance"][0]["source"] = "https://evil.example/fake"
    return json.dumps(d)


c = fresh()
GL.tamper = tamper_source
GL.leader_view = {CB: 100000.5, CG: 100000.7, KR: 100000.3}
GL.validator_views = [dict(GL.leader_view) for _ in range(3)]
err = attempt(c)
check(GL.last_votes == [False, False, False], "unknown source rejected")
check(err is not None, "update fails, nothing published")

# T5: sources disagree for every node identically ------------------------
print("\n[T5] sources disagree beyond max_spread for every node -> fail-safe")
c = fresh()
GL.tamper = None
bad = {CB: 100000.0, CG: 200000.0, KR: 300000.0}
GL.leader_view = dict(bad)
GL.validator_views = [dict(bad) for _ in range(3)]
err = attempt(c)
check(GL.last_votes == [True, True, True], "validators verify the identical failure outcome (ok=False)")
check(err is not None and "Oracle update rejected" in str(err), "contract refuses to publish a failed outcome")
check(stored(c) == {}, "no value stored")

# T6: validator loses one source -----------------------------------------
print("\n[T6] validator independently sees only 2 of 3 sources -> REJECT")
c = fresh()
GL.tamper = None
GL.leader_view = {CB: 100000.0, CG: 100000.0, KR: 100000.0}
GL.validator_views = [{CB: 100000.0, CG: 100000.0, KR: None} for _ in range(3)]
err = attempt(c)
check(GL.last_votes == [False, False, False], "different sources_used (3 vs 2) changes the outcome -> rejected")
check(err is not None, "update fails, nothing published")

# T7: even sample count (2-source feed) ----------------------------------
print("\n[T7] two-source feed, exact match on averaged median")
c = fresh(urls=[CB, CG])
GL.tamper = None
GL.leader_view = {CB: 2000.10, CG: 2000.30}
GL.validator_views = [dict(GL.leader_view) for _ in range(3)]
err = attempt(c)
check(GL.last_votes == [True, True, True] and err is None, "even-count median accepted by exact equality")
check(stored(c).get("median_units") == 200020, "persisted median_units == 200020 (2000.20 @ 2 decimals)")

# T8: benign per-source noise that does not change the outcome -----------
print("\n[T8] per-source noise that leaves the outcome unchanged -> accept")
c = fresh()
GL.tamper = None
GL.leader_view = {CB: 100000.0, CG: 100000.0, KR: 100001.0}
GL.validator_views = [{CB: 100000.0, CG: 100001.0, KR: 100000.0} for _ in range(3)]
err = attempt(c)
check(GL.last_votes == [True, True, True] and err is None,
      "same derived outcome (median/spread/count) still accepted — strict but not brittle")
check(stored(c).get("median_units") == 10000000, "persisted median_units == 10000000")

# summary ------------------------------------------------------------------
failed = [label for ok, label in RESULTS if not ok]
print("\n" + "=" * 72)
print("CHECKS:", len(RESULTS), " PASSED:", len(RESULTS) - len(failed), " FAILED:", len(failed))
if failed:
    print("FAILED:")
    for label in failed:
        print("  - " + label)
    sys.exit(1)
print("ALL CHECKS PASSED — exact-value consensus binding verified.")
