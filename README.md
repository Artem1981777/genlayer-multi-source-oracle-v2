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

## Deployment evidence

Deployment evidence is generated for each release and must refer to the same
commit as the submitted `contracts/oracle.py`. Run `npm run deploy`, then save
the resulting address and transaction hash, register the example feed, run one
successful update, and run `npm run verify-parity`. Do not reuse an Explorer
address from an earlier implementation: the parity proof is valid only when
the deployed UTF-8 source and the submitted file have identical bytes and
SHA-256 digests.

The example feed is `btc_usd` over Coinbase, CoinGecko and Kraken public price
APIs. Deployment artifacts (`contract.txt`, `deploy-tx.txt`, and the generated
parity proof) are intentionally ignored by Git until they have been verified
against the release commit.

### Verified release deployment

The public release commit `a479c36` was validated by GitHub Actions run
[`35453480327`](https://github.com/Artem1981777/genlayer-multi-source-oracle-v2/actions/runs/35453480327): GenVM lint and semantic validation passed, and all 22 offline
exact-consensus regression checks passed. That exact commit was then deployed
to GenLayer Testnet Bradbury using the repository secret-backed workflow.

- Contract: [`0x0856Ac3120Ac58c84EfaF5A40fDD5FE067810b97`](https://explorer-bradbury.genlayer.com/address/0x0856Ac3120Ac58c84EfaF5A40fDD5FE067810b97)
- Deploy transaction: [`0xcde1dcf9aaa2f3ddf70a1179ec3c55c833ad79f038df6ee4818f3063ea8e3368`](https://explorer-bradbury.genlayer.com/tx/0xcde1dcf9aaa2f3ddf70a1179ec3c55c833ad79f038df6ee4818f3063ea8e3368)
- Submitted/deployed source SHA-256: `47696d4bee7e2cb849609fa9b9b00a7c8d0acda52426101f3da37e2a49dba85a` (14,041 UTF-8 bytes)
- Machine-readable deployment record: [`deployment-proof.txt`](deployment-proof.txt)

## Run it yourself

1. `npm install`
2. Copy `.env.example` to `.env` and set `PRIVATE_KEY` (funded Bradbury account).
3. `npm run deploy` — deploys `contracts/oracle.py` to Bradbury.
4. `npm run register` — registers the btc_usd feed (Coinbase + CoinGecko + Kraken).
5. `npm run update` — runs a consensus round and publishes the median.
6. `npm run read` — reads back feeds, value and history.
7. `npm test` — deploys a fresh instance and runs the 6-check on-chain suite.
8. `npm run lint` — runs the official GenVM linter and semantic validator.
9. `npm run verify-parity` — verifies deployed byte-for-byte source parity.

All scripts tunnel RPC through a local browser QUIC relay (`rpc-relay.mjs` opens a page that forwards RPC over HTTP/3) because the direct TCP path to the Bradbury RPC is unreliable on some networks; pass `--direct` to bypass the relay.

## Verification tooling

- `verify-relay.mjs` — proves the deployed contract code is byte-for-byte identical to `contracts/oracle.py` (sha256 of both sides).
- `sim_consensus.py` — offline simulation of the leader/validator protocol (20/20 scenarios: agreement, disagreement, outlier rejection, spread gate, provenance forgery, liveness corroboration).
- `status.mjs <tx_hash>` — dumps a transaction's consensus status to `tx.json`.

## Tech

GenLayer Intelligent Contract (Python), genlayer-js deployment scripts, Node.js. No mocks: every value comes from live web sources aggregated under validator consensus.

## Tests

Automated on-chain test suite against Testnet Bradbury (`npm test`): deploys a fresh instance and checks deploy, feed registration, state views, empty-value-before-update, unknown-feed handling, and a guard revert for feeds with fewer than two sources. Result: 6/6 passing.
