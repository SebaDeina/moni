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

function claudeReply(body) {
  const last = body.messages[body.messages.length - 1];
  const block = (content, stop_reason) => ({ id: "msg_mock", type: "message", role: "assistant", model: body.model, content, stop_reason, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } });
  if (Array.isArray(last.content) && last.content[0]?.type === "tool_result") {
    const result = JSON.parse(last.content[0].content);
    const text = result.codigo && result.monto
      ? `Para mandarle ${result.monto} a ${result.destino}, respondé SI ${result.codigo} (vence en 2 minutos).`
      : result.codigo
        ? `Para agendar a ${result.nombre}, respondé SI ${result.codigo} (vence en 2 minutos).`
        : `Resultado: ${last.content[0].content}`;
    return block([{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text }], "end_turn");
  }
  const user = String(last.content).toLowerCase();
  const tool = (name, input) => block([{ type: "thinking", thinking: "", signature: "sig" }, { type: "tool_use", id: "toolu_1", name, input }], "tool_use");
  if (user.includes("agenda")) return tool("propose_add_contact", { alias: "pedro", address: "0x4444444444444444444444444444444444444444" });
  if (user.includes("mandale")) return tool("propose_native_transfer", { alias: user.includes("pedro") ? "pedro" : "juan", amountAvax: "0.1" });
  if (user.includes("saldo")) return tool("get_balance", {});
  return block([{ type: "text", text: `Eco: ${last.content}` }], "end_turn");
}

createServer(async (req, res) => {
  const body = await readBody(req);
  const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

  if (req.url === "/_sent") return json(200, { sent, sttCalls, claudeRequests });
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
