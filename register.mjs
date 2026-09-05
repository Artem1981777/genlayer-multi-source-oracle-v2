// register.mjs — register the btc_usd feed on the deployed oracle.
//
// Tunnels all RPC through the browser QUIC relay (rpc-relay.mjs) by default
// because the direct TCP path to the Bradbury RPC is broken by DPI on this
// network. Pass --direct to use the plain network path instead.
//
// Usage: node --env-file=.env register.mjs [--direct]
import { readFileSync } from "node:fs";
import { createClient, createAccount } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";
import { installFetchRelay } from "./rpc-relay.mjs";

const PK = process.env.PRIVATE_KEY;
if (!PK) { throw new Error("PRIVATE_KEY missing. Run: node --env-file=.env register.mjs"); }
const CONTRACT = readFileSync("contract.txt", "utf8").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function isTransient(e){ let m=""; try{ m=(e&&(e.shortMessage||e.message||""))+" "+(e&&e.details||"")+" "+((e&&e.cause&&e.cause.code)||""); }catch(x){ m=String(e);} return ["fetch failed","ECONNABORTED","ECONNRESET","capacity","-32005","timeout","socket","terminated","relay:","HTTP request failed","consensus contract"].some(s=>m.indexOf(s)>=0); }
async function robust(label, fn, tries){ const T=tries||30; for(let i=1;i<=T;i++){ try{ return await fn(); } catch(e){ if(isTransient(e)&&i<T){ console.log(label+" transient, retry "+i+" of "+T); await sleep(3500); continue; } throw e; } } }

if (!process.argv.includes("--direct")) {
  installFetchRelay();
  console.log("waiting 8s for the browser relay tab...");
  await sleep(8000);
}

const account = createAccount(PK);
const client = createClient({ chain: testnetBradbury, account });

const KEY = "btc_usd";
const QUESTION = "BTC/USD spot price, median across Coinbase, CoinGecko and Kraken";
const SOURCES = ["https://api.coinbase.com/v2/prices/BTC-USD/spot", "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd", "https://api.kraken.com/0/public/Ticker?pair=XBTUSD"];
const TOLERANCE_BPS = 100;   // per-source liveness corroboration bound (NOT a median range)
const MAX_SPREAD_BPS = 500;
const DECIMALS = 2;

console.log("Registering feed", KEY, "on", CONTRACT);
const txHash = await robust("register submit", () => client.writeContract({ address: CONTRACT, functionName: "register_feed", args: [KEY, QUESTION, JSON.stringify(SOURCES), TOLERANCE_BPS, MAX_SPREAD_BPS, DECIMALS], value: 0n }));
console.log("register tx:", txHash);
await robust("register wait", () => client.waitForTransactionReceipt({ hash: txHash, status: TransactionStatus.ACCEPTED, retries: 300 }));
const tx = await robust("register read", () => client.getTransaction({ hash: txHash }));
console.log("txExecutionResultName:", tx?.txExecutionResultName);
const ok = (tx?.txExecutionResultName === "FINISHED" || tx?.txExecutionResultName === "FINISHED_WITH_RETURN");
console.log(ok ? ">>> REGISTER OK" : ("!!! not clean -> " + tx?.txExecutionResultName));
console.log("Explorer tx: https://explorer-bradbury.genlayer.com/tx/" + txHash);
