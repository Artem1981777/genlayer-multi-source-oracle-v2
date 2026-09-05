// update.mjs — run update(key) on the deployed oracle (exact-value consensus).
//
// Tunnels all RPC through the browser QUIC relay (rpc-relay.mjs) by default
// because the direct TCP path to the Bradbury RPC is broken by DPI on this
// network. Pass --direct to use the plain network path instead.
//
// Usage: node --env-file=.env update.mjs [feed_key] [--direct]
import { readFileSync } from "node:fs";
import { createClient, createAccount } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";
import { installFetchRelay } from "./rpc-relay.mjs";

const PK = process.env.PRIVATE_KEY;
if (!PK) { throw new Error("PRIVATE_KEY missing. Run: node --env-file=.env update.mjs"); }
const CONTRACT = readFileSync("contract.txt", "utf8").trim();
const KEY = process.argv.find((a, i) => i >= 2 && !a.startsWith("--")) || "btc_usd";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function isTransient(e){ let m=""; try{ m=(e&&(e.shortMessage||e.message||""))+" "+(e&&e.details||"")+" "+((e&&e.cause&&e.cause.code)||""); }catch(x){ m=String(e);} return ["fetch failed","ECONNABORTED","ECONNRESET","capacity","-32005","timeout","socket","terminated","relay:","HTTP request failed","consensus contract","NOT_VOTED"].some(s=>m.indexOf(s)>=0); }
async function robust(label, fn, tries){ const T=tries||60; for(let i=1;i<=T;i++){ try{ return await fn(); } catch(e){ if(isTransient(e)&&i<T){ console.log(label+" transient, retry "+i+" of "+T); await sleep(4000); continue; } throw e; } } }

if (!process.argv.includes("--direct")) {
  installFetchRelay();
  console.log("waiting 8s for the browser relay tab...");
  await sleep(8000);
}

const account = createAccount(PK);
const client = createClient({ chain: testnetBradbury, account });

console.log("Updating feed", KEY, "on", CONTRACT);
const txHash = await robust("update submit", () => client.writeContract({ address: CONTRACT, functionName: "update", args: [KEY], value: 0n }));
console.log("update tx:", txHash);
await robust("update wait", () => client.waitForTransactionReceipt({ hash: txHash, status: TransactionStatus.ACCEPTED, retries: 600 }));
let res = "";
for (let i = 0; i < 120; i++) {
  const tx = await robust("result", () => client.getTransaction({ hash: txHash }));
  res = tx?.txExecutionResultName || "";
  if (res && res !== "NOT_VOTED") break;
  await sleep(5000);
}
console.log("exec:", res);
const st = await robust("read state", () => client.readContract({ address: CONTRACT, functionName: "get_state", args: [] }));
let vals = {}; try { vals = JSON.parse(st.values); } catch (e) {}
console.log("value:", JSON.stringify(vals[KEY] || {}, null, 2));
console.log("Explorer tx: https://explorer-bradbury.genlayer.com/tx/" + txHash);
