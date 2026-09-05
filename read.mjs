// read.mjs — read-only view of the deployed oracle (feeds, current value, state).
//
// Tunnels all RPC through the browser QUIC relay (rpc-relay.mjs) by default
// because the direct TCP path to the Bradbury RPC is broken by DPI on this
// network. Pass --direct to use the plain network path instead.
//
// Usage: node --env-file=.env read.mjs [feed_key] [--direct]
import { readFileSync } from "node:fs";
import { createClient, createAccount } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { installFetchRelay } from "./rpc-relay.mjs";

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) { throw new Error("PRIVATE_KEY missing. Run: node --env-file=.env read.mjs"); }
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
const CONTRACT = readFileSync("contract.txt", "utf8").trim();
const KEY = process.argv.find((a, i) => i > 1 && !a.startsWith("--")) || "btc_usd";

const feeds = await robust("list_feeds read", () => client.readContract({ address: CONTRACT, functionName: "list_feeds", args: [] }));
console.log("feeds:", feeds);
const val = await robust("get read", () => client.readContract({ address: CONTRACT, functionName: "get", args: [KEY] }));
console.log("value:", val);
const gv = await robust("get_value read", () => client.readContract({ address: CONTRACT, functionName: "get_value", args: [KEY] }));
console.log("get_value:", gv);
const state = await robust("get_state read", () => client.readContract({ address: CONTRACT, functionName: "get_state", args: [] }));
console.log("history:", state.history);
