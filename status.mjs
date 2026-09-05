// status.mjs — dump a transaction's status from Bradbury into tx.json.
//
// Tunnels all RPC through the browser QUIC relay (rpc-relay.mjs) by default
// because the direct TCP path to the Bradbury RPC is broken by DPI on this
// network. Pass --direct to use the plain network path instead.
//
// Usage: node --env-file=.env status.mjs <tx_hash> [--direct]
import { writeFileSync } from "node:fs";
import { createClient, createAccount } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { installFetchRelay } from "./rpc-relay.mjs";

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) { throw new Error("PRIVATE_KEY missing. Run: node --env-file=.env status.mjs <tx_hash>"); }
const HASH = process.argv.find((a, i) => i > 1 && !a.startsWith("--"));
if (!HASH) { throw new Error("Usage: node --env-file=.env status.mjs <tx_hash>"); }
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
const tx = await robust("tx read", () => client.getTransaction({ hash: HASH }));
const safe = JSON.stringify(tx, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
writeFileSync("tx.json", safe);
console.log("status:", tx?.status);
console.log("statusName:", tx?.statusName);
console.log("txExecutionResultName:", tx?.txExecutionResultName);
console.log("bytes:", safe.length);
