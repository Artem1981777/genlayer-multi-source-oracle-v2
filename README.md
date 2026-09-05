# MultiSourceOracle — exact-value consensus oracle for GenLayer

**Deployed on GenLayer Testnet Bradbury.** A reusable Intelligent Contract that turns several disagreeing public web sources into a single trustworthy on-chain number through validator consensus, with **exact-value binding**: the persisted integer is the exact integer every validator recomputed and authorized — never a range.

## Why this is a real Intelligent Contract

Most on-chain data feeds trust a single operator. MultiSourceOracle instead makes every validator independently fetch multiple live web sources, extract the answer with an LLM, and reach Optimistic Democracy consensus on the aggregated result. No single node, source, or LLM run can dictate the value.

## How consensus is used — v2 exact-value semantics

The core `update(key)` method runs a custom leader/validator scheme via `gl.vm.run_nondet_unsafe(leader_fn, validator_fn)` — no LLM in the accept/reject decision:

1. Each validator fetches every configured source (`gl.nondet.web.render`), and an LLM (`gl.nondet.exec_prompt`) extracts a single number answering the feed question from each untrusted page.
2. The outcome is canonicalized to a deterministic integer: `median_units = int(round(median * 10 ** decimals))`, together with the full acceptance outcome `ok`, `spread_bps`, `sources_used`, `decimals`.
3. **The validator independently re-fetches the sources and re-derives the FULL outcome from its own data, then requires EXACT equality on every field** — `ok`, `median_units`, `spread_bps`, `sources_used`, `decimals` — against the leader's outcome. `median_units` is compared for exact integer equality. There is no tolerance band on the median: the validator accepts one integer, not a range.
4. `tolerance_bps` is used **only** for per-source liveness corroboration — every source the leader reported must be present in the validator's own fetch and agree within `tolerance_bps`. This check can only reject; it never widens the accepted median.
5. Outlier protection: the round is rejected when fewer than two sources return a usable number or the cross-source spread exceeds `max_spread_bps`; with three or more sources the single farthest outlier is dropped before the spread is computed.
6. The leader's stated outcome must also be exactly the deterministic recomputation from the leader's **own provenance** — the leader cannot state an outcome its data does not support.
7. Storage is written only after the non-deterministic block returns, and the contract re-derives the outcome once more from the returned provenance and asserts exact field equality before persisting — defense in depth: the persisted value is exactly the consensus-verified value.

## On-chain state

All state is stored as JSON strings for deterministic serialization:

- `owner` — deployer address; only owner can register or remove feeds.
- `feeds` — per-feed config: question, sources, tolerance_bps, max_spread_bps, decimals.
- `values` — last accepted value per feed: value, median, `median_units` (canonical integer), decimals, samples, provenance, sources_used, spread_bps, status, updated_round, previous.
- `history` — append-only audit log of every register, remove and update round.

## Public methods

- `register_feed(key, question, sources_json, tolerance_bps, max_spread_bps, decimals)` — owner registers a feed over two or more http(s) sources.
- `remove_feed(key)` — owner removes a feed.
- `update(key)` — anyone can trigger a consensus refresh of the feed value.
- Views: `get_state`, `list_feeds`, `get_feed`, `get`, `get_value`, `is_stale`.

## Live deployment

- Network: GenLayer Testnet Bradbury
- Contract address: [0x5dECa96a72749fDEc8F19e5bc289B0EF3839874C](https://explorer-bradbury.genlayer.com/address/0x5dECa96a72749fDEc8F19e5bc289B0EF3839874C)
- Deploy tx: [0x053f9caa65c1e2935a2992a69aad92efbc94904e2e40b78cb2b3937924bfec09](https://explorer-bradbury.genlayer.com/tx/0x053f9caa65c1e2935a2992a69aad92efbc94904e2e40b78cb2b3937924bfec09) — ACCEPTED, FINISHED_WITH_RETURN
- Register tx (btc_usd): [0x4f46e05e200c9f6443f5da05fd24f2e2e96326779160bc3e8a074449aaf6a5c6](https://explorer-bradbury.genlayer.com/tx/0x4f46e05e200c9f6443f5da05fd24f2e2e96326779160bc3e8a074449aaf6a5c6)
- Finalized consensus update (FINISHED_WITH_RETURN): [0xbf7de69e1abc111ed0a87b45f095a3b8cd862c9db9ac2164df1132ea1f462b60](https://explorer-bradbury.genlayer.com/tx/0xbf7de69e1abc111ed0a87b45f095a3b8cd862c9db9ac2164df1132ea1f462b60) — btc_usd = 79737.00 (median_units 7973700), sources_used 3, spread_bps 0
- Example feed: btc_usd over Coinbase, CoinGecko and Kraken public price APIs.
- **Source parity proof**: the deployed contract code is byte-for-byte identical to the submitted `contracts/oracle.py` — 14,343 bytes, sha256 `1324409e64ad91f2811c3d8a409eefabcd524de447d858273d97dc5f8a2d64f5` on both sides (verified with `verify-relay.mjs`, which fetches the deployed code via `ConsensusData.getTransactionData`, RLP-decodes `[code, constructorArgs, leaderOnly]`, and compares sha256 against the local file; proof saved to `parity-proof.txt`).

## Run it yourself

1. `npm install`
2. Copy `.env.example` to `.env` and set `PRIVATE_KEY` (funded Bradbury account).
3. `npm run deploy` — deploys `contracts/oracle.py` to Bradbury.
4. `npm run register` — registers the btc_usd feed (Coinbase + CoinGecko + Kraken).
5. `npm run update` — runs a consensus round and publishes the median.
6. `npm run read` — reads back feeds, value and history.
7. `npm test` — deploys a fresh instance and runs the 6-check on-chain suite.

All scripts tunnel RPC through a local browser QUIC relay (`rpc-relay.mjs` opens a page that forwards RPC over HTTP/3) because the direct TCP path to the Bradbury RPC is unreliable on some networks; pass `--direct` to bypass the relay.

## Verification tooling

- `verify-relay.mjs` — proves the deployed contract code is byte-for-byte identical to `contracts/oracle.py` (sha256 of both sides).
- `sim_consensus.py` — offline simulation of the leader/validator protocol (20/20 scenarios: agreement, disagreement, outlier rejection, spread gate, provenance forgery, liveness corroboration).
- `status.mjs <tx_hash>` — dumps a transaction's consensus status to `tx.json`.

## Tech

GenLayer Intelligent Contract (Python), genlayer-js deployment scripts, Node.js. No mocks: every value comes from live web sources aggregated under validator consensus.

## Tests

Automated on-chain test suite against Testnet Bradbury (`npm test`): deploys a fresh instance and checks deploy, feed registration, state views, empty-value-before-update, unknown-feed handling, and a guard revert for feeds with fewer than two sources. Result: 6/6 passing.
