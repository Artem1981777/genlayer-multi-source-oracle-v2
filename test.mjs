// test.mjs — end-to-end on-chain checks for the v2 MultiSourceOracle.
//
// Deploys a fresh instance on GenLayer Testnet Bradbury and runs 6 checks:
//   1. deploy executes clean
//   2. register_feed executes clean
//   3. the feed appears in list_feeds
//   4. get_value is empty before any update
//   5. get_feed on an unknown key returns "{}"
//   6. register_feed with <2 sources reverts
//
// Tunnels all RPC through the browser QUIC relay (rpc-relay.mjs) by default
// because the direct TCP path to the Bradbury RPC is broken by DPI on this
// network. Pass --direct to use the plain network path instead.
//
// Usage: node --env-file=.env test.mjs [--direct]
import { readFileSync } from "node:fs";
import { createClient, createAccount } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";
import { installFetchRelay } from "./rpc-relay.mjs";

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) { throw new Error("PRIVATE_KEY missing. Run: node --env-file=.env test.mjs"); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function isTransient(e){ let m=""; try{ m=(e&&(e.shortMessage||e.message||""))+" "+(e&&e.details||"")+" "+((e&&e.cause&&e.cause.code)||""); }catch(x){ m=String(e);} return ["fetch failed","ECONNABORTED","ECONNRESET","capacity","-32005","timeout","socket","terminated","relay:","HTTP request failed"].some(s=>m.indexOf(s)>=0); }
async function robust(label, fn, tries){ const T=tries||30; for(let i=1;i<=T;i++){ try{ return await fn(); } catch(e){ if(isTransient(e)&&i<T){ console.log(label+" transient, retry "+i+" of "+T); await sleep(3000); continue; } throw e; } } }

if (!process.argv.includes("--direct")) {
  installFetchRelay();
  console.log("waiting 8s for the browser relay tab...");
  await sleep(8000);
}

const account = createAccount(PRIVATE_KEY);
const client = createClient({ chain: testnetBradbury, account });

let pass = 0; let fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("PASS:", name); } else { fail++; console.log("FAIL:", name); } }
async function result(hash) {
  await robust("receipt wait", () => client.waitForTransactionReceipt({ hash, status: TransactionStatus.ACCEPTED, retries: 400 }));
  const tx = await robust("tx read", () => client.getTransaction({ hash }));
  return tx?.txExecutionResultName;
}
function clean(r) { return r === "FINISHED" || r === "FINISHED_WITH_RETURN"; }
async function expectRevert(name, fn) { try { const h = await fn(); const r = await result(h); ok(name, !clean(r)); } catch (e) { ok(name, true); } }

const code = new TextEncoder().encode(readFileSync("contracts/oracle.py", "utf8"));
console.log("Deploying fresh MultiSourceOracle (v2, exact-value consensus) for tests...");
const dhash = await robust("deploy submit", () => client.deployContract({ code, args: [] }));
await robust("deploy wait", () => client.waitForTransactionReceipt({ hash: dhash, status: TransactionStatus.ACCEPTED, retries: 400 }));
const dtx = await robust("deploy read", () => client.getTransaction({ hash: dhash }));
const address = dtx?.txDataDecoded?.contractAddress ?? dtx?.recipient;
ok("deploy clean", clean(dtx?.txExecutionResultName));
console.log("test contract:", address);

// tolerance_bps = per-source liveness corroboration bound (NOT a median range);
// max_spread_bps = the only spread gate, applied to the leader's own result.
const SRCS = JSON.stringify([
  "https://api.coinbase.com/v2/prices/BTC-USD/spot",
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd",
  "https://api.kraken.com/0/public/Ticker?pair=XBTUSD",
]);
const rhash = await robust("register submit", () => client.writeContract({ address, functionName: "register_feed", args: ["btc_usd", "What is the current BTC price in USD?", SRCS, 100, 500, 2] }));
ok("register_feed clean", clean(await result(rhash)));

const feeds = await robust("list_feeds read", () => client.readContract({ address, functionName: "list_feeds", args: [] }));
ok("feed appears in list_feeds", String(feeds).includes("btc_usd"));

const val = await robust("get_value read", () => client.readContract({ address, functionName: "get_value", args: ["btc_usd"] }));
ok("value empty before update", String(val).trim() === "");

const unknown = await robust("get_feed read", () => client.readContract({ address, functionName: "get_feed", args: ["nope"] }));
ok("unknown feed returns empty json", String(unknown).replace(/\s/g, "") === "{}");

await expectRevert("reject feed with <2 sources", () => client.writeContract({ address, functionName: "register_feed", args: ["bad", "q", JSON.stringify(["https://only.one/x"]), 100, 500, 2] }));

console.log("---"); console.log("PASS:", pass, "FAIL:", fail);
if (fail > 0) process.exit(1);
