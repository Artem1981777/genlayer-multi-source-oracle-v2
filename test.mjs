import { readFileSync } from "node:fs";
import { createClient, createAccount } from "genlayer-js";
import { testnetBradbury } from "genlayer-js/chains";
import { TransactionStatus } from "genlayer-js/types";
const account = createAccount(process.env.PRIVATE_KEY);
const client = createClient({ chain: testnetBradbury, account });
let pass = 0; let fail = 0;
function ok(name, cond) { if (cond) { pass++; console.log("PASS:", name); } else { fail++; console.log("FAIL:", name); } }
async function result(hash) { await client.waitForTransactionReceipt({ hash, status: TransactionStatus.ACCEPTED, retries: 400 }); const tx = await client.getTransaction({ hash }); return tx?.txExecutionResultName; }
function clean(r) { return r === "FINISHED" || r === "FINISHED_WITH_RETURN"; }
async function expectRevert(name, fn) { try { const h = await fn(); const r = await result(h); ok(name, !clean(r)); } catch (e) { ok(name, true); } }
const code = new TextEncoder().encode(readFileSync("contracts/oracle.py", "utf8"));
console.log("Deploying fresh MultiSourceOracle for tests...");
const dhash = await client.deployContract({ code, args: [] });
await client.waitForTransactionReceipt({ hash: dhash, status: TransactionStatus.ACCEPTED, retries: 400 });
const dtx = await client.getTransaction({ hash: dhash });
const address = dtx?.txDataDecoded?.contractAddress ?? dtx?.recipient;
ok("deploy clean", clean(dtx?.txExecutionResultName));
console.log("test contract:", address);
const SRCS = JSON.stringify(["https://api.coinbase.com/v2/prices/BTC-USD/spot", "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd", "https://api.kraken.com/0/public/Ticker?pair=XBTUSD"]);
const rhash = await client.writeContract({ address, functionName: "register_feed", args: ["btc_usd", "What is the current BTC price in USD?", SRCS, 200, 500, 2] });
ok("register_feed clean", clean(await result(rhash)));
const feeds = await client.readContract({ address, functionName: "list_feeds", args: [] });
ok("feed appears in list_feeds", String(feeds).includes("btc_usd"));
const val = await client.readContract({ address, functionName: "get_value", args: ["btc_usd"] });
ok("value empty before update", String(val).trim() === "");
const unknown = await client.readContract({ address, functionName: "get_feed", args: ["nope"] });
ok("unknown feed returns empty json", String(unknown).replace(/\s/g, "") === "{}");
await expectRevert("reject feed with <2 sources", () => client.writeContract({ address, functionName: "register_feed", args: ["bad", "q", JSON.stringify(["https://only.one/x"]), 200, 500, 2] }));
console.log("---"); console.log("PASS:", pass, "FAIL:", fail);
if (fail > 0) process.exit(1);
