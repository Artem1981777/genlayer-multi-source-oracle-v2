# MultiSourceOracle — source-grounded numeric oracle for GenLayer

**Deployed on GenLayer Testnet Bradbury.** A reusable Intelligent Contract that turns several disagreeing public web sources into a single trustworthy on-chain number through validator consensus.

## Why this is a real Intelligent Contract

Most on-chain data feeds trust a single operator. MultiSourceOracle instead makes every validator independently fetch multiple live web sources, extract the answer with an LLM, and then reach Optimistic Democracy consensus on the aggregated result. The write only commits if validators agree within a configurable tolerance, so no single node, source, or LLM run can dictate the value.

## How consensus is used

The core `update(key)` method runs a non-deterministic block wrapped by `gl.eq_principle.prompt_comparative`:

- Each validator calls `gl.nondet.web.render(url)` for every configured source.
- An LLM (`gl.nondet.exec_prompt`) extracts a single number answering the feed question from each untrusted page.
- The validator computes the median of the collected samples and a spread in basis points across sources.
- The equivalence principle accepts the round only if the validator medians agree within `tolerance_bps` and agree on the boolean `ok`.
- Outlier protection: a feed is rejected when fewer than two sources return a usable number or the cross-source spread exceeds `max_spread_bps`.

## On-chain state

All state is stored as JSON strings for deterministic serialization:

- `owner` — deployer address; only owner can register or remove feeds.
- `feeds` — per-feed config: question, sources, tolerance_bps, max_spread_bps, decimals.
- `values` — last accepted value per feed: value, median, samples, sources_used, spread_bps, updated_round, previous.
- `history` — append-only audit log of every register, remove and update round.

## Public methods

- `register_feed(key, question, sources_json, tolerance_bps, max_spread_bps, decimals)` — owner registers a feed over two or more http(s) sources.
- `remove_feed(key)` — owner removes a feed.
- `update(key)` — anyone can trigger a consensus refresh of the feed value.
- Views: `get_state`, `list_feeds`, `get_feed`, `get`, `get_value`, `is_stale`.

## Live deployment

- Network: GenLayer Testnet Bradbury
- Contract address: 0x9a87961693FF753de5AeBcfD72D861BD21C9d0A4
- Deploy tx: 0x04652ea6f42ed74cad05083e2fccbfae4e1c2743a359985bceb501e59bcd10b1
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
