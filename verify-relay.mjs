// verify-relay.mjs — browser-assisted parity verification.
//
// The direct TCP path to rpc-bradbury.genlayer.com is throttled mid-response
// for payloads over ~1KB (DPI). Browsers negotiate HTTP/3 (QUIC over UDP),
// which is not affected. This server:
//   1. serves verify-relay.html locally,
//   2. gives the browser the exact eth_call body (getTransactionData),
//   3. receives the full RPC result back from the browser,
//   4. RLP-decodes txData and checks byte-for-byte parity with
//      contracts/oracle.py.
//
// Run: node verify-relay.mjs   (from apps/multi-source-oracle)
import http from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { exec } from "node:child_process";
import { fromRlp, isHex, encodeFunctionData, decodeFunctionResult } from "viem";
import { testnetBradbury } from "genlayer-js/chains";

const PORT = Number(process.env.PORT || 8899);
const html = readFileSync("verify-relay.html", "utf8");
const DEPLOY_TX = readFileSync("deploy-tx.txt", "utf8").trim();
const LOCAL_SOURCE = readFileSync("contracts/oracle.py", "utf8");
const ABI = testnetBradbury.consensusDataContract.abi;

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

// Build the exact request body the browser will POST to the RPC.
const calldata = encodeFunctionData({
  abi: ABI,
  functionName: "getTransactionData",
  args: [DEPLOY_TX, BigInt(Math.round(Date.now() / 1000))],
});
const body = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "eth_call",
  params: [{ to: testnetBradbury.consensusDataContract.address, data: calldata }, "latest"],
});

console.log("deploy tx:", DEPLOY_TX);
console.log("eth_call body bytes:", body.length);

function checkParity(rpcResultText) {
  let json;
  try { json = JSON.parse(rpcResultText); } catch (e) {
    return { ok: false, msg: "browser result is not JSON: " + String(e.message).slice(0, 80) };
  }
  if (json.error) return { ok: false, msg: "RPC error: " + JSON.stringify(json.error).slice(0, 200) };
  let txData = null;
  try {
    const decoded = decodeFunctionResult({ abi: ABI, functionName: "getTransactionData", data: json.result });
    // viem may return an array (single output) or the struct directly.
    const struct = Array.isArray(decoded) ? decoded[0] : decoded;
    txData = struct && struct.txCalldata ? struct.txCalldata : null;
  } catch (e) {
    return { ok: false, msg: "decodeFunctionResult failed: " + String(e.message).slice(0, 120) };
  }
  if (!txData || !isHex(txData) || txData === "0x") return { ok: false, msg: "no txCalldata in result" };

  const decoded = fromRlp(txData);
  if (!Array.isArray(decoded) || decoded.length !== 3) {
    return { ok: false, msg: "unexpected RLP structure, length=" + (Array.isArray(decoded) ? decoded.length : typeof decoded) };
  }
  const deployedCode = Buffer.from(decoded[0].slice(2), "hex").toString("utf8");
  console.log("");
  console.log("local    bytes:", Buffer.byteLength(LOCAL_SOURCE, "utf8"), " sha256:", sha256(LOCAL_SOURCE));
  console.log("deployed bytes:", Buffer.byteLength(deployedCode, "utf8"), " sha256:", sha256(deployedCode));
  console.log("");
  if (deployedCode === LOCAL_SOURCE) {
    return { ok: true, msg: "PARITY OK: deployed contract code is byte-for-byte identical to contracts/oracle.py" };
  }
  const n = Math.min(deployedCode.length, LOCAL_SOURCE.length);
  let d = -1;
  for (let i = 0; i < n; i++) { if (deployedCode[i] !== LOCAL_SOURCE[i]) { d = i; break; } }
  if (d === -1) d = n;
  return {
    ok: false,
    msg: "PARITY FAILED: first difference at byte " + d +
      "\n  local    ...[" + LOCAL_SOURCE.slice(Math.max(0, d - 40), d + 40).replace(/\n/g, "\\n") + "]..." +
      "\n  deployed ...[" + deployedCode.slice(Math.max(0, d - 40), d + 40).replace(/\n/g, "\\n") + "]...",
  };
}

const server = http.createServer((req, res) => {
  console.log("[relay] " + req.method + " " + req.url + " from " + (req.socket.remoteAddress || "?"));
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
    return;
  }
  if (req.method === "GET" && req.url === "/verify-body.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(body);
    return;
  }
  if (req.method === "POST" && req.url === "/report") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      console.log("=== BROWSER REPORT ===");
      let verdict = null;
      try {
        const j = JSON.parse(raw);
        for (const line of j.lines) console.log("  " + line);
        if (j.ok && j.rpcResult) {
          verdict = checkParity(j.rpcResult);
          console.log(verdict.ok ? ">>> " + verdict.msg : "!!! " + verdict.msg);
          if (verdict.ok) writeFileSync("parity-proof.txt",
            "deploy tx: " + DEPLOY_TX + "\n" +
            "local    sha256: " + sha256(LOCAL_SOURCE) + " (" + Buffer.byteLength(LOCAL_SOURCE, "utf8") + " bytes)\n" +
            "deployed sha256: " + sha256(LOCAL_SOURCE) + " (" + Buffer.byteLength(LOCAL_SOURCE, "utf8") + " bytes)\n" +
            "PARITY OK: deployed contract code is byte-for-byte identical to contracts/oracle.py\n" +
            "verified at: " + new Date().toISOString() + "\n");
        } else {
          console.log("!!! browser could not fetch the txData");
        }
      } catch (e) {
        console.log("bad report:", String(e.message));
      }
      res.writeHead(200, { "Access-Control-Allow-Origin": "*" });
      res.end("ok");
      if (verdict && verdict.ok) {
        console.log("[relay] parity proof saved -> parity-proof.txt");
        setTimeout(() => process.exit(0), 500);
      }
    });
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, "127.0.0.1", () => {
  console.log("verify relay on http://127.0.0.1:" + PORT + "/");
  console.log("opening browser...");
  exec('start "" "http://127.0.0.1:' + PORT + '/"');
});
let heartbeat = 0;
const hb = setInterval(() => {
  heartbeat++;
  console.log("[relay] alive " + heartbeat * 15 + "s, waiting for browser report...");
}, 15000);
hb.unref();

setTimeout(() => {
  console.log("TIMEOUT: no successful report within 5 min");
  process.exit(3);
}, 300000);
