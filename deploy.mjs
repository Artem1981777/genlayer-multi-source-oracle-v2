// deploy.mjs — deploy contracts/oracle.py to GenLayer Testnet Bradbury.
//
// Tunnels all RPC through the browser QUIC relay (rpc-relay.mjs) by default
// because the direct TCP path to the Bradbury RPC is broken by DPI on this
// network (large requests get RST, large responses stall). The relay opens a
// local page in your browser that forwards RPC over HTTP/3 (QUIC/UDP), which
// is unaffected. Pass --direct to use the plain network path instead.
//
// Usage: node --env-file=.env deploy.mjs [--direct]
import { readFileSync, writeFileSync } from "node:fs";
import { createClient, createAccount } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";
import { installFetchRelay } from "./rpc-relay.mjs";

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) { throw new Error("PRIVATE_KEY missing. Run: node --env-file=.env deploy.mjs"); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function isTransient(e){ let m=""; try{ m=(e&&(e.shortMessage||e.message||""))+" "+(e&&e.details||"")+" "+((e&&e.cause&&e.cause.code)||""); }catch(x){ m=String(e);} return ["fetch failed","ECONNABORTED","ECONNRESET","capacity","-32005","timeout","socket","terminated","relay:","HTTP request failed"].some(s=>m.indexOf(s)>=0); }
async function robust(label, fn, tries){ const T=tries||30; for(let i=1;i<=T;i++){ try{ return await fn(); } catch(e){ if(isTransient(e)&&i<T){ console.log(label+" transient, retry "+i+" of "+T); await sleep(3000); continue; } throw e; } } }

if (!process.argv.includes("--direct")) {
  installFetchRelay();
  console.log("waiting 8s for the browser relay tab...");
  await sleep(8000);
}

const source = readFileSync("contracts/oracle.py", "utf8");
const code = new TextEncoder().encode(source);
const account = createAccount(PRIVATE_KEY);
const client = createClient({ chain: testnetBradbury, account });

try { await robust("consensus init", () => client.initializeConsensusSmartContract()); console.log("consensus init ok"); }
catch (e) { console.log("consensus init skipped:", e && e.message ? e.message : String(e)); }

console.log("Deploying MultiSourceOracle (v2, exact-value consensus)...");
const txHash = await robust("deploy submit", () => client.deployContract({ code, args: [] }));
console.log("deploy tx:", txHash);
await robust("deploy wait", () => client.waitForTransactionReceipt({ hash: txHash, status: TransactionStatus.ACCEPTED, retries: 300 }));
const tx = await robust("deploy read", () => client.getTransaction({ hash: txHash }));
const address = tx?.txDataDecoded?.contractAddress ?? tx?.recipient;
console.log("=== DEPLOY RESULT ===");
console.log("statusName:", tx?.statusName);
console.log("txExecutionResultName:", tx?.txExecutionResultName);
console.log("contract address:", address);
const ok = (tx?.txExecutionResultName === "FINISHED" || tx?.txExecutionResultName === "FINISHED_WITH_RETURN");
console.log(ok ? ">>> CLEAN DEPLOY OK" : ("!!! WARNING: execution not clean -> " + tx?.txExecutionResultName));
writeFileSync("contract.txt", String(address));
writeFileSync("deploy-tx.txt", String(txHash));
console.log("Explorer: https://explorer-bradbury.genlayer.com/address/" + address);
