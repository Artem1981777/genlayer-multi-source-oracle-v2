// deploy-relay.mjs — deploy contracts/oracle.py via the browser QUIC relay.
//
// The direct TCP path to the RPC is broken by DPI (big requests get RST).
// This script imports the relay (which starts the local job server and opens
// the browser tab), patches globalThis.fetch, and then runs the same deploy
// flow as deploy.mjs — every RPC call is transparently tunneled through the
// browser over HTTP/3.
//
// Usage (from apps/multi-source-oracle):
//   node --env-file=../../.env deploy-relay.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { createClient, createAccount } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";
import { installFetchRelay } from "./rpc-relay.mjs";

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) { throw new Error("PRIVATE_KEY not found. Run: node --env-file=../../.env deploy-relay.mjs"); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function isTransient(e){ let m=""; try{ m=(e&&(e.shortMessage||e.message||""))+" "+(e&&e.details||"")+" "+((e&&e.cause&&e.cause.code)||""); }catch(x){ m=String(e);} return ["fetch failed","ECONNABORTED","ECONNRESET","capacity","-32005","timeout","socket","terminated","relay:","HTTP request failed"].some(s=>m.indexOf(s)>=0); }
async function withRetry(label, fn, tries){ const T=tries||30; for(let a=1;a<=T;a++){ try{ return await fn(); } catch(e){ if(isTransient(e)&&a<T){ console.log(label+" transient ("+String(e&&e.details||e&&e.shortMessage||e).slice(0,70)+"), retry "+a+" of "+T); await sleep(3000); continue; } throw e; } } }

// Start the relay and give the browser tab time to spin up.
installFetchRelay();
console.log("waiting 8s for the browser relay tab...");
await sleep(8000);

const source = readFileSync("contracts/oracle.py","utf8");
const code = new TextEncoder().encode(source);
const account = createAccount(PRIVATE_KEY);
const client = createClient({ chain: testnetBradbury, account });

try { await withRetry("consensus init", () => client.initializeConsensusSmartContract()); console.log("consensus init ok"); }
catch(e){ console.log("consensus init skipped:", e&&e.message?e.message:String(e)); }

console.log("Deploying MultiSourceOracle (v2) via relay...");
const txHash = await withRetry("deploy submit", () => client.deployContract({ code, args: [] }));
console.log("deploy tx:", txHash);
await withRetry("deploy wait", () => client.waitForTransactionReceipt({ hash: txHash, status: TransactionStatus.ACCEPTED, retries: 300 }));
const tx = await withRetry("deploy read", () => client.getTransaction({ hash: txHash }));
const address = tx?.txDataDecoded?.contractAddress ?? tx?.recipient;
console.log("=== DEPLOY RESULT ===");
console.log("statusName:", tx?.statusName);
console.log("txExecutionResultName:", tx?.txExecutionResultName);
console.log("contract address:", address);
const ok = (tx?.txExecutionResultName==="FINISHED"||tx?.txExecutionResultName==="FINISHED_WITH_RETURN");
console.log(ok?">>> CLEAN DEPLOY OK":("!!! WARNING: execution not clean -> "+tx?.txExecutionResultName));
writeFileSync("contract.txt", String(address));
writeFileSync("deploy-tx.txt", String(txHash));
console.log("saved address -> contract.txt, tx -> deploy-tx.txt");
console.log("Explorer: https://explorer-bradbury.genlayer.com/address/"+String(address));
process.exit(ok ? 0 : 1);
