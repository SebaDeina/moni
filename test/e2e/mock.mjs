// Servidor falso: Kapso (envío + media), LLM (chat completions) y STT de xAI.
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

function llmReply(messages) {
  const last = messages[messages.length - 1];
  if (last.role === "tool") {
    const result = JSON.parse(last.content);
    const text = result.codigo
      ? `Para mandarle ${result.monto} a ${result.destino}, respondé SI ${result.codigo} (vence en 2 minutos).`
      : `Resultado: ${last.content}`;
    return { role: "assistant", content: text };
  }
  const user = String(last.content).toLowerCase();
  if (user.includes("mandale")) {
    const alias = user.includes("pedro") ? "pedro" : "juan";
    return {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "propose_native_transfer", arguments: JSON.stringify({ alias, amountAvax: "0.1" }) } }],
    };
  }
  if (user.includes("saldo")) {
    return { role: "assistant", content: null, tool_calls: [{ id: "call_2", type: "function", function: { name: "get_balance", arguments: "{}" } }] };
  }
  return { role: "assistant", content: `Eco: ${last.content}` };
}

createServer(async (req, res) => {
  const body = await readBody(req);
  const json = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };

  if (req.url === "/_sent") return json(200, { sent, sttCalls });
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
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    const { messages } = JSON.parse(body.toString());
    return json(200, { id: "c1", object: "chat.completion", created: 0, model: "mock", choices: [{ index: 0, finish_reason: "stop", message: llmReply(messages) }] });
  }
  if (req.method === "POST" && req.url === "/v1/stt") {
    sttCalls.push({ auth: req.headers.authorization, size: body.length, fileLast: body.toString("latin1").lastIndexOf('name="file"') > body.toString("latin1").lastIndexOf('name="model"') });
    return json(200, { text: "mandale a juan", language: "es", duration: 1.2 });
  }
  json(404, { error: "no mock", url: req.url });
}).listen(3998, () => console.log("mock en :3998"));
