// Servidor falso: Kapso (envío + media), Claude (Messages API) y STT de xAI.
import { createServer } from "node:http";

const sent = [];
const sttCalls = [];

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

const claudeRequests = [];
const rawTxs = [];
// Depósitos inyectados por la prueba (POST /_inject): cada uno va en un bloque nuevo.
let head = 0x10;
const deposits = [];
const hex = (n) => "0x" + BigInt(n).toString(16);
const pad = (h) => "0x" + h.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const USDC = "0x5425890298aed601595a70ab815c96711a31bc65";
function blockObj(n, full) {
  const txs = deposits.filter((d) => d.block === n && d.token === "AVAX").map((d) => ({
    hash: d.hash, from: d.from, to: d.to, value: hex(d.value), blockNumber: hex(n), blockHash: "0x" + "11".repeat(32),
    gas: "0x5208", gasPrice: "0x5d21dba00", input: "0x", nonce: "0x0", transactionIndex: "0x0", type: "0x0",
    v: "0x1b", r: "0x" + "01".repeat(32), s: "0x" + "02".repeat(32), chainId: "0xa869",
  }));
  return { number: hex(n), hash: "0x" + "11".repeat(32), parentHash: "0x" + "22".repeat(32), timestamp: "0x6729c4e0",
    gasLimit: "0x1c9c380", gasUsed: "0x0", baseFeePerGas: "0x5d21dba00", transactions: full ? txs : txs.map((t) => t.hash), miner: "0x" + "00".repeat(20),
    nonce: "0x0000000000000000", difficulty: "0x0", extraData: "0x", logsBloom: "0x" + "00".repeat(256), sha3Uncles: "0x" + "33".repeat(32),
    size: "0x0", stateRoot: "0x" + "44".repeat(32), receiptsRoot: "0x" + "55".repeat(32), transactionsRoot: "0x" + "66".repeat(32), uncles: [] };
}

// Nodo de Fuji falso: lo justo para saldo, estimación de gas y envío de transacciones firmadas.
function rpc({ id, method, params }) {
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  switch (method) {
    case "eth_chainId": return ok("0xa869");
    case "eth_getBalance": return ok("0xde0b6b3a7640000"); // 1 AVAX
    case "eth_estimateGas": return ok("0x5208");
    case "eth_call": return ok("0x" + (100_000_000).toString(16).padStart(64, "0")); // balanceOf: 100 USDC
    case "eth_maxPriorityFeePerGas": return ok("0x3b9aca00");
    case "eth_gasPrice": return ok("0x5d21dba00");
    case "eth_getTransactionCount": return ok("0x" + rawTxs.length.toString(16));
    case "eth_blockNumber": return ok(hex(head));
    case "eth_getBlockByNumber":
      return ok(blockObj(params[0] === "latest" || params[0] === "pending" ? head : Number(BigInt(params[0])), params[1] === true));
    case "eth_getLogs": {
      const f = params[0];
      const from = Number(BigInt(f.fromBlock)), to = Number(BigInt(f.toBlock));
      return ok(deposits.filter((d) => d.token === "USDC" && d.block >= from && d.block <= to).map((d) => ({
        address: USDC, topics: [TRANSFER_TOPIC, pad(d.from), pad(d.to)], data: pad(BigInt(d.value).toString(16)),
        blockNumber: hex(d.block), blockHash: "0x" + "11".repeat(32), transactionHash: d.hash, transactionIndex: "0x0", logIndex: "0x0", removed: false,
      })));
    }
    case "eth_getTransactionReceipt": {
      const d = deposits.find((x) => x.hash === params[0]);
      return ok(d ? { transactionHash: d.hash, blockNumber: hex(d.block), blockHash: "0x" + "11".repeat(32), status: "0x1", from: d.from, to: d.to,
        gasUsed: "0x5208", cumulativeGasUsed: "0x5208", effectiveGasPrice: "0x5d21dba00", logs: [], logsBloom: "0x" + "00".repeat(256),
        contractAddress: null, transactionIndex: "0x0", type: "0x0" } : null);
    }
    case "eth_sendRawTransaction": rawTxs.push(params[0]); return ok("0x" + "ab".repeat(32));
    default: return { jsonrpc: "2.0", id, error: { code: -32601, message: "mock: " + method } };
  }
}

function claudeReply(body) {
  const last = body.messages[body.messages.length - 1];
  const block = (content, stop_reason) => ({ id: "msg_mock", type: "message", role: "assistant", model: body.model, content, stop_reason, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } });
  if (Array.isArray(last.content) && last.content[0]?.type === "tool_result") {
    const result = JSON.parse(last.content[0].content);
    const text = result.direccion && "nueva" in result
      ? `${result.nueva ? "Te creé la wallet" : "Ya tenías wallet"}: ${result.direccion}${result.saldo_inicial ? ". Saldo inicial: " + result.saldo_inicial : ""}${result.aviso ? ". " + result.aviso : ""}`
      : result.codigo && result.monto
      ? `Para mandarle ${result.monto} a ${result.destino}, respondé SI ${result.codigo} (vence en 2 minutos).`
      : result.codigo
        ? `Para agendar a ${result.nombre}, respondé SI ${result.codigo} (vence en 2 minutos).`
        : `Resultado: ${last.content[0].content}`;
    return block([{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text }], "end_turn");
  }
  const user = String(last.content).toLowerCase();
  const tool = (name, input) => block([{ type: "thinking", thinking: "", signature: "sig" }, { type: "tool_use", id: "toolu_1", name, input }], "tool_use");
  if (user.includes("wallet")) return tool("create_wallet", {});
  if (user.includes("agenda")) return tool("propose_add_contact", { alias: "pedro", address: "0x4444444444444444444444444444444444444444" });
  if (user.includes("dolares")) return tool("propose_transfer", { alias: "juan", amount: "12.5", token: "USDC" });
  if (user.includes("mandale")) return tool("propose_transfer", { alias: user.includes("pedro") ? "pedro" : "juan", amount: "0.1", token: "AVAX" });
  if (user.includes("saldo")) return tool("get_balance", {});
  return block([{ type: "text", text: `Eco: ${last.content}` }], "end_turn");
}

createServer(async (req, res) => {
  const body = await readBody(req);
  const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

  if (req.url === "/_sent") return json(200, { sent, sttCalls, claudeRequests, rawTxs: rawTxs.length });
  if (req.method === "POST" && req.url === "/_inject") {
    const d = JSON.parse(body.toString());
    head += 1;
    deposits.push({ ...d, block: head, hash: "0x" + head.toString(16).padStart(64, "d") });
    return json(200, { ok: true, block: head });
  }
  if (req.method === "POST" && req.url === "/rpc") {
    const parsed = JSON.parse(body.toString());
    return json(200, Array.isArray(parsed) ? parsed.map(rpc) : rpc(parsed));
  }
  if (req.method === "POST" && req.url.startsWith("/meta/whatsapp/")) {
    if (req.headers["x-api-key"] !== "test-key") return json(401, { error: "bad key" });
    sent.push(JSON.parse(body.toString()));
    return json(200, { messages: [{ id: "wamid.out" }] });
  }
  if (req.method === "GET" && req.url === "/media/audio1") {
    if (req.headers["x-api-key"] !== "test-key") return json(401, { error: "bad key" });
    res.writeHead(200, { "content-type": "audio/ogg" });
    return res.end(Buffer.from("OggS-fake-audio"));
  }
  if (req.method === "POST" && req.url.startsWith("/v1/messages")) {
    const claudeKey = req.headers["x-api-key"] ?? String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (claudeKey !== "claude-key") return json(401, { type: "error", error: { type: "authentication_error", message: "bad key" } });
    const parsed = JSON.parse(body.toString());
    claudeRequests.push({ model: parsed.model, beta: req.headers["anthropic-beta"], fallbacks: parsed.fallbacks, effort: parsed.output_config?.effort, system: typeof parsed.system === "string", tools: parsed.tools?.length, roles: parsed.messages.map((m) => m.role).join(",") });
    return json(200, claudeReply(parsed));
  }
  if (req.method === "POST" && req.url === "/v1/stt") {
    sttCalls.push({ auth: req.headers.authorization, size: body.length, fileLast: body.toString("latin1").lastIndexOf('name="file"') > body.toString("latin1").lastIndexOf('name="model"') });
    return json(200, { text: "mandale a juan", language: "es", duration: 1.2 });
  }
  json(404, { error: "no mock", url: req.url });
}).listen(3998, () => console.log("mock en :3998"));
