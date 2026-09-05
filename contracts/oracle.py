# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
from genlayer import *
import json
# MultiSourceOracle: reusable source-grounded numeric oracle primitive.
#
# CONSENSUS DESIGN - fail-safe, exact-value binding:
#   * The leader fetches every configured source, extracts one number per
#     source, and deterministically derives the full acceptance outcome
#     (ok, median_units, spread_bps, sources_used) plus the provenance it
#     was derived from.
#   * Each validator INDEPENDENTLY re-fetches the same sources, re-derives
#     its own full outcome from its own data, and accepts the leader's
#     result only if the two outcomes are EXACTLY equal on every field.
#     There is deliberately NO tolerance band on the median: the integer
#     the validators verify is bit-for-bit the integer the contract
#     persists.
#   * tolerance_bps is used ONLY as a per-source liveness corroboration
#     bound: every source the leader reported must still be served and be
#     within tolerance_bps of the validator's own fresh reading. It only
#     ever causes rejection; it never widens the set of acceptable
#     medians.
#   * If independent recomputation does not match exactly, consensus fails
#     and NO value is published (fail-safe).
def _extract_number(body: str):
    val = None
    try:
        d = json.loads(body)
        if isinstance(d, dict) and isinstance(d.get("data", None), dict) and ("amount" in d["data"]):
            val = float(d["data"]["amount"])
        elif isinstance(d, dict) and isinstance(d.get("bitcoin", None), dict) and ("usd" in d["bitcoin"]):
            val = float(d["bitcoin"]["usd"])
        elif isinstance(d, dict) and isinstance(d.get("result", None), dict):
            r = d["result"]
            ks = list(r.keys())
            if len(ks) > 0 and isinstance(r[ks[0]], dict) and ("c" in r[ks[0]]):
                val = float(r[ks[0]]["c"][0])
    except Exception:
        val = None
    return val
def _derive_result(prov, decimals, max_spread_bps):
    dec = int(decimals)
    ms = int(max_spread_bps)
    vals = []
    for p in prov:
        try:
            vals.append(float(p["value"]))
        except Exception:
            pass
    n = len(vals)
    if n == 0:
        return {"ok": False, "reason": "no source returned a usable number", "median": 0, "median_units": 0, "decimals": dec, "samples": [], "provenance": [], "sources_used": 0, "spread_bps": 0}
    s = sorted(vals)
    mid = n // 2
    if n % 2 == 1:
        med = float(s[mid])
    else:
        med = (float(s[mid - 1]) + float(s[mid])) / 2.0
    inliers = list(vals)
    if n >= 3:
        fi = 0
        fd = -1.0
        for i in range(n):
            di = abs(vals[i] - med)
            if di > fd:
                fd = di
                fi = i
        inliers = [vals[i] for i in range(n) if i != fi]
    lo = min(inliers)
    hi = max(inliers)
    if med == 0:
        spread_bps = 0 if hi == lo else 10000
    else:
        spread_bps = int(round(((hi - lo) / abs(med)) * 10000))
    ok = (n >= 2) and (spread_bps <= ms)
    reason = "" if ok else "too few samples or sources disagree beyond max_spread_bps"
    mu = int(round(med * (10 ** dec)))
    prov_out = []
    for p in prov:
        try:
            prov_out.append({"source": str(p["source"]), "value": float(p["value"])})
        except Exception:
            pass
    return {"ok": ok, "reason": reason, "median": mu / (10 ** dec), "median_units": mu, "decimals": dec, "samples": [round(x, dec) for x in vals], "provenance": prov_out, "sources_used": n, "spread_bps": spread_bps}
def _fetch_provenance(sources):
    # Module-level on purpose: this helper contains the gl.nondet.web.get
    # call and must be statically reachable from the functions passed to
    # gl.vm.run_nondet_unsafe (GenVM lint rule E010).
    prov = []
    for i in range(len(sources)):
        url = sources[i]
        try:
            body = gl.nondet.web.get(url).body.decode("utf-8")
        except Exception:
            body = ""
        val = _extract_number(body)
        if (val is not None) and (val > 0):
            prov.append({"source": url, "value": val})
    return prov
class MultiSourceOracle(gl.Contract):
    owner: str
    feeds: str
    values: str
    history: str
    def __init__(self):
        self.owner = str(gl.message.sender_address)
        self.feeds = "{}"
        self.values = "{}"
        self.history = "[]"
    def _load(self, raw: str, fallback):
        try:
            return json.loads(raw)
        except Exception:
            return fallback
    def _feeds(self) -> dict:
        v = self._load(self.feeds, {})
        return v if isinstance(v, dict) else {}
    def _values(self) -> dict:
        v = self._load(self.values, {})
        return v if isinstance(v, dict) else {}
    def _history_list(self) -> list:
        v = self._load(self.history, [])
        return v if isinstance(v, list) else []
    def _log(self, kind: str, key: str, note: str):
        items = self._history_list()
        items.append({"round": len(items) + 1, "kind": kind, "feed": key, "by": str(gl.message.sender_address), "note": note})
        self.history = json.dumps(items)
    @gl.public.view
    def get_state(self) -> dict:
        return {"owner": self.owner, "feeds": self.feeds, "values": self.values, "history": self.history}
    @gl.public.view
    def list_feeds(self) -> str:
        return json.dumps(list(self._feeds().keys()))
    @gl.public.view
    def get_feed(self, key: str) -> str:
        return json.dumps(self._feeds().get(key, {}))
    @gl.public.view
    def get(self, key: str) -> str:
        return json.dumps(self._values().get(key, {}))
    @gl.public.view
    def get_value(self, key: str) -> str:
        return str(self._values().get(key, {}).get("value", ""))
    @gl.public.view
    def is_stale(self, key: str, max_age_rounds: int) -> bool:
        vals = self._values()
        if key not in vals:
            return True
        updated = int(vals[key].get("updated_round", 0))
        return (len(self._history_list()) - updated) > int(max_age_rounds)
    @gl.public.write
    def register_feed(self, key: str, question: str, sources_json: str, tolerance_bps: int, max_spread_bps: int, decimals: int):
        assert str(gl.message.sender_address) == self.owner, "Only owner can register feeds"
        assert len(key.strip()) > 0, "Feed key required"
        try:
            sources = json.loads(sources_json)
        except Exception:
            sources = []
        assert isinstance(sources, list) and len(sources) >= 2, "Provide >= 2 source URLs as a JSON array"
        clean = []
        for s in sources:
            u = str(s).strip()
            assert u.startswith("http://") or u.startswith("https://"), "Each source must be an http(s) URL"
            clean.append(u)
        tb = int(tolerance_bps)
        ms = int(max_spread_bps)
        dc = int(decimals)
        assert 0 <= tb <= 10000, "tolerance_bps out of range (0..10000)"
        assert 0 <= ms <= 10000, "max_spread_bps out of range (0..10000)"
        assert 0 <= dc <= 18, "decimals out of range (0..18)"
        feeds = self._feeds()
        feeds[key] = {"question": question, "sources": clean, "tolerance_bps": tb, "max_spread_bps": ms, "decimals": dc}
        self.feeds = json.dumps(feeds)
        self._log("register", key, "sources=" + str(len(clean)))
    @gl.public.write
    def remove_feed(self, key: str):
        assert str(gl.message.sender_address) == self.owner, "Only owner can remove feeds"
        feeds = self._feeds()
        assert key in feeds, "No such feed"
        del feeds[key]
        self.feeds = json.dumps(feeds)
        vals = self._values()
        if key in vals:
            del vals[key]
            self.values = json.dumps(vals)
        self._log("remove", key, "")
    @gl.public.write
    def update(self, key: str):
        feeds = self._feeds()
        assert key in feeds, "No such feed; register it first"
        cfg = feeds[key]
        sources = list(cfg.get("sources", []))
        tolerance_bps = int(cfg.get("tolerance_bps", 100))
        max_spread_bps = int(cfg.get("max_spread_bps", 500))
        decimals = int(cfg.get("decimals", 2))
        def leader_fn() -> str:
            return json.dumps(_derive_result(_fetch_provenance(sources), decimals, max_spread_bps))
        def validator_fn(leader_result) -> bool:
            if not isinstance(leader_result, gl.vm.Return):
                return False
            try:
                ld = json.loads(leader_result.calldata)
            except Exception:
                return False
            if not isinstance(ld, dict):
                return False
            if int(ld.get("decimals", -1)) != decimals:
                return False
            lprov = ld.get("provenance", [])
            if not isinstance(lprov, list):
                return False
            seen = []
            lvals = []
            for p in lprov:
                if not isinstance(p, dict):
                    return False
                u = str(p.get("source", ""))
                if u not in sources:
                    return False
                if u in seen:
                    return False
                seen.append(u)
                try:
                    pv = float(p.get("value", 0))
                except Exception:
                    return False
                if pv <= 0:
                    return False
                lvals.append((u, pv))
            # (1) Bind claims to evidence: the leader's stated outcome must be
            # exactly the deterministic recomputation from the leader's own
            # provenance. The leader cannot state an outcome its data does
            # not support.
            reck = _derive_result([{"source": u, "value": pv} for (u, pv) in lvals], decimals, max_spread_bps)
            for f in ("ok", "median_units", "spread_bps", "sources_used", "decimals"):
                if reck.get(f) != ld.get(f):
                    return False
            # (2) The validator independently re-fetches the same sources and
            # re-derives the FULL outcome from its own data.
            v_prov = _fetch_provenance(sources)
            vres = _derive_result(v_prov, decimals, max_spread_bps)
            # (3) EXACT binding, no ranges: the validator's independently
            # recomputed outcome must equal the leader's outcome on every
            # field. median_units is compared for exact integer equality,
            # and so are ok / spread_bps / sources_used / decimals. This is
            # the integer that will be persisted, verified bit-for-bit.
            for f in ("ok", "median_units", "spread_bps", "sources_used", "decimals"):
                if vres.get(f) != ld.get(f):
                    return False
            # (4) Per-source liveness corroboration, bounded by tolerance_bps:
            # every source the leader reported must be present in the
            # validator's own fetch and agree within tolerance_bps. This
            # check can only reject; it never accepts a range of medians.
            vmap = {}
            for p in v_prov:
                vmap[str(p["source"])] = float(p["value"])
            for (u, pv) in lvals:
                if u not in vmap:
                    return False
                mvv = vmap[u]
                if mvv <= 0:
                    return False
                if abs(pv - mvv) * 10000 > tolerance_bps * abs(mvv):
                    return False
            # (5) A failure outcome (ok=False) reaches acceptance only when
            # the validator's independent recomputation failed identically
            # (guaranteed by the exact match in (3)); the contract then
            # refuses to publish any value.
            return True
        raw = gl.vm.run_nondet_unsafe(leader_fn, validator_fn)
        data = None
        try:
            data = json.loads(raw)
        except Exception:
            a = raw.find("{")
            b = raw.rfind("}")
            if a != -1 and b != -1 and b > a:
                try:
                    data = json.loads(raw[a:b + 1])
                except Exception:
                    data = None
        assert isinstance(data, dict), "Oracle aggregation returned an unparseable result"
        prov_in = data.get("provenance", [])
        assert isinstance(prov_in, list), "Oracle result missing source provenance"
        prov = [{"source": str(p.get("source", "")), "value": float(p.get("value", 0))} for p in prov_in if isinstance(p, dict) and str(p.get("source", "")) in sources]
        canon = _derive_result(prov, decimals, max_spread_bps)
        # Defense in depth: the outcome that gets persisted must be exactly
        # the outcome that consensus verified.
        for f in ("ok", "median_units", "spread_bps", "sources_used", "decimals"):
            assert canon.get(f) == data.get(f), "Consensus result failed canonical re-derivation"
        assert bool(canon.get("ok", False)), "Oracle update rejected: " + str(data.get("reason", "sources disagreed"))
        median_units = int(canon.get("median_units", 0))
        dec = decimals
        median = median_units / (10 ** dec)
        samples = canon.get("samples", [])
        provenance = canon.get("provenance", [])
        sources_used = int(canon.get("sources_used", 0))
        spread_bps = int(canon.get("spread_bps", 0))
        vals = self._values()
        prev = vals.get(key, {})
        round_no = len(self._history_list()) + 1
        vals[key] = {"value": median, "median": median, "median_units": median_units, "decimals": dec, "samples": samples, "provenance": provenance, "sources_used": sources_used, "spread_bps": spread_bps, "updated_round": round_no, "updated_by": str(gl.message.sender_address), "status": "ok", "previous": prev.get("value", None)}
        self.values = json.dumps(vals)
        self._log("update", key, "median=" + str(median) + " n=" + str(sources_used) + " spread_bps=" + str(spread_bps))
