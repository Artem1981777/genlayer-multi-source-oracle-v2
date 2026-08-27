# MultiSourceOracle — source-grounded numeric oracle for GenLayer

**Deployed on GenLayer Testnet Bradbury.** A reusable Intelligent Contract that turns several disagreeing public web sources into a single trustworthy on-chain number through validator consensus.

## Why this is a real Intelligent Contract

Most on-chain data feeds trust a single operator. MultiSourceOracle instead makes every validator independently fetch multiple live web sources, extract the answer with an LLM, and then reach Optimistic Democracy consensus on the aggregated result. The write only commits if validators agree within a configurable tolerance, so no single node, source, or LLM run can dictate the value.

## How consensus is used

The core `update(key)` method reaches consensus with a custom leader/validator scheme via `gl.vm.run_nondet_unsafe(leader_fn, validator_fn)` - the pattern the GenLayer docs recommend for numeric results, with no LLM in the accept/reject decision:

- Each validator calls `gl.nondet.web.render(url)` for every configured source.
- An LLM (`gl.nondet.exec_prompt`) extracts a single number answering the feed question from each untrusted page.
- The validator computes the median of the collected samples and a spread in basis points across sources.
- Each value is canonicalized to a single deterministic integer `median_units = int(round(median * 10 ** decimals))`. Every validator independently re-fetches the sources, recomputes its own `median_units`, and agrees only if `abs(leader_units - validator_units) * 10000 <= tolerance_bps * abs(leader_units)`, so all validators authorize the exact same canonical integer rather than a range.
- Outlier protection: the round is rejected when fewer than two sources return a usable number or the cross-source spread exceeds `max_spread_bps`; with three or more sources the single farthest outlier is dropped before the spread is computed.
- Storage is written only after the non-deterministic block returns the accepted result, so the persisted on-chain value is exactly the consensus value bound by every validator.

## On-chain state

All state is stored as JSON strings for deterministic serialization:

- `owner` — deployer address; only owner can register or remove feeds.
- `feeds` — per-feed config: question, sources, tolerance_bps, max_spread_bps, decimals.
- `values` — last accepted value per feed: value, median, `median_units` (canonical integer), decimals, samples, sources_used, spread_bps, status, updated_round, previous.
- `history` — append-only audit log of every register, remove and update round.

## Public methods

- `register_feed(key, question, sources_json, tolerance_bps, max_spread_bps, decimals)` — owner registers a feed over two or more http(s) sources.
- `remove_feed(key)` — owner removes a feed.
- `update(key)` — anyone can trigger a consensus refresh of the feed value.
- Views: `get_state`, `list_feeds`, `get_feed`, `get`, `get_value`, `is_stale`.

## Live deployment

- Network: GenLayer Testnet Bradbury
- Contract address: 0xfdE0d2cBD651FC3E7c14fFEc7D981A05E2969DCC
- Deploy tx: 0x4dffe49a4cd7726b9f4a7b814f0cfe9808425a3cd235b1784112cd2ea5543d64
- Register tx: 0xf599e8d8d45f025203b6e121fc3d3fea9e8f361dc3fb672ad142e4781b873f52
- Finalized consensus updates (FINISHED_WITH_RETURN):
  - round 2: 0x42494e45ed7e66d21798d7ed3b8b95fc97d7552bf4425b9fde67a6ec22059ec9 (btc_usd = 78663.9, spread 2 bps)
  - round 3, triggered from the live dApp UI: 0x8f5fb6a72973bcc24e567427090318e8387b4473ba9205351ecd32e4e21350ec (btc_usd = 78863.8, sources_used 3, spread_bps 0)
- Live dApp: https://artem1981777.github.io/genlayer-dashboard/ (Multi-Source Oracle tab)
- Example feed: btc_usd over Coinbase, CoinGecko and Kraken public price APIs.

## Run it yourself

1. npm install
2. Copy .env.example to .env and set PRIVATE_KEY and ADDRESS (funded Bradbury account).
3. npm run deploy
4. npm run register
5. npm run update
6. npm run read

## Tech

GenLayer Intelligent Contract (Python), genlayer-js deployment scripts, Node.js. No mocks: every value comes from live web sources aggregated under validator consensus.

## Tests

Automated on-chain test suite against Testnet Bradbury (npm test): deploys a fresh instance and checks deploy, feed registration, state views, empty-value-before-update, unknown-feed handling, and a guard revert for feeds with fewer than two sources. Result: 6/6 passing.
