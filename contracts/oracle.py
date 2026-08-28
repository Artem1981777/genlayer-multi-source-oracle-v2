# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
from genlayer import *
import json
# MultiSourceOracle: reusable source-grounded numeric oracle primitive.
# Validators independently fetch several sources, extract a number, and reach
# consensus on the median within a configurable tolerance (spread rejection +
# on-chain provenance). Full design notes in README.
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
        question = str(cfg.get("question", ""))
        sources = list(cfg.get("sources", []))
        tolerance_bps = int(cfg.get("tolerance_bps", 100))
        max_spread_bps = int(cfg.get("max_spread_bps", 500))
        decimals = int(cfg.get("decimals", 2))
        def aggregate() -> str:
            samples = []
            used = []
            for i in range(len(sources)):
                url = sources[i]
                try:
                    body = gl.nondet.web.get(url).body.decode("utf-8")
                except Exception:
                    body = ""
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
                if (val is not None) and (val > 0):
                    samples.append(val)
                    used.append(url)
            n = len(samples)
            if n == 0:
                return json.dumps({"ok": False, "reason": "no source returned a usable number", "median": 0, "samples": [], "sources_used": 0, "spread_bps": 0})
            s = sorted(samples)
            mid = n // 2
            if n % 2 == 1:
                med = float(s[mid])
            else:
                med = (float(s[mid - 1]) + float(s[mid])) / 2.0
            inliers = list(samples)
            if n >= 3:
                fi = 0
                fd = -1.0
                for i in range(n):
                    di = abs(samples[i] - med)
                    if di > fd:
                        fd = di
                        fi = i
                inliers = [samples[i] for i in range(n) if i != fi]
            lo = min(inliers)
            hi = max(inliers)
            if med == 0:
                spread_bps = 0 if hi == lo else 10000
            else:
                spread_bps = int(round(((hi - lo) / abs(med)) * 10000))
            ok = (n >= 2) and (spread_bps <= max_spread_bps)
            reason = "" if ok else "too few samples or sources disagree beyond max_spread_bps"
            mu = int(round(med * (10 ** decimals)))
            return json.dumps({"ok": ok, "reason": reason, "median": mu / (10 ** decimals), "median_units": mu, "decimals": decimals, "samples": [round(x, decimals) for x in samples], "sources_used": n, "spread_bps": spread_bps})
        def leader_fn() -> str:
            return aggregate()
        def validator_fn(leader_result) -> bool:
            if not isinstance(leader_result, gl.vm.Return):
                return False
            try:
                ld = json.loads(leader_result.calldata); vd = json.loads(leader_fn())
            except Exception:
                return False
            if bool(ld.get("ok", False)) != bool(vd.get("ok", False)):
                return False
            if int(ld.get("decimals", -1)) != decimals or int(vd.get("decimals", -1)) != decimals:
                return False
            ln = int(ld.get("sources_used", 0)); vn = int(vd.get("sources_used", 0))
            ls = int(ld.get("spread_bps", 0)); vs = int(vd.get("spread_bps", 0))
            if not bool(ld.get("ok", False)):
                return (ln < 2) or (vn < 2) or (ls > max_spread_bps)
            l_samples = ld.get("samples", [])
            if not isinstance(l_samples, list) or len(l_samples) != ln or ln > len(sources):
                return False
            if ln < 2 or vn < 2 or abs(ln - vn) > 1:
                return False
            if ls > max_spread_bps or vs > max_spread_bps or abs(ls - vs) > max_spread_bps:
                return False
            lu = int(ld.get("median_units", 0)); vu = int(vd.get("median_units", 0))
            if lu == 0:
                return vu == 0
            return abs(lu - vu) * 10000 <= tolerance_bps * abs(lu)
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
        ok = bool(data.get("ok", False))
        assert ok, "Oracle update rejected: " + str(data.get("reason", "sources disagreed"))
        median_units = int(data.get("median_units", 0))
        dec = decimals  # deterministic feed config, validator-enforced
        median = median_units / (10 ** dec)
        samples = data.get("samples", [])
        sources_used = int(data.get("sources_used", 0))
        spread_bps = int(data.get("spread_bps", 0))
        vals = self._values()
        prev = vals.get(key, {})
        round_no = len(self._history_list()) + 1
        vals[key] = {"value": median, "median": median, "median_units": median_units, "decimals": dec, "samples": samples, "sources_used": sources_used, "spread_bps": spread_bps, "updated_round": round_no, "updated_by": str(gl.message.sender_address), "status": "ok", "previous": prev.get("value", None)}
        self.values = json.dumps(vals)
        self._log("update", key, "median=" + str(median) + " n=" + str(sources_used) + " spread_bps=" + str(spread_bps))
