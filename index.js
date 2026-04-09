const http = require("http");
const url  = require("url");
const fs   = require("fs");
const path = require("path");

const GSB_HOST = "api.gsbsoftware.com.br";
const GSB_PORT = 50013;
const AUTH     = "Basic " + Buffer.from("hayashi:cpjlk54*#spl89").toString("base64");
const PORT     = process.env.PORT || 3000;

// ── PERSISTÊNCIA EM ARQUIVO ────────────────────────────────
// No Render o filesystem é efêmero, mas para dados leves funciona
// enquanto o servidor estiver no ar. Reinicializações limpam os dados,
// mas solicitações pendentes são verificadas a cada abertura do app.
const DATA_FILE = path.join("/tmp", "gsb_data.json");

function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch { return { config: { whatsHGO: "", whatsHBA: "" }, solicitacoes: [] }; }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data), "utf8");
}

// ── HELPERS ────────────────────────────────────────────────
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res, status, obj) {
  cors(res);
  res.setHeader("Content-Type", "application/json");
  res.writeHead(status);
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", c => body += c);
    req.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

// ── PROXY GSB ─────────────────────────────────────────────
function proxyGSB(cleanPath, res) {
  const options = {
    hostname: GSB_HOST, port: GSB_PORT, path: cleanPath,
    method: "GET",
    headers: { "Authorization": AUTH, "Content-Type": "application/json" },
  };
  const proxy = http.request(options, (gsb) => {
    let data = "";
    gsb.on("data", c => data += c);
    gsb.on("end", () => { json(res, gsb.statusCode, JSON.parse(data || "null")); });
  });
  proxy.on("error", (e) => json(res, 500, { error: e.message }));
  proxy.end();
}

// ── SERVER ─────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const parsed  = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // ── GET /config ── lê configurações (whatsapp por filial)
  if (req.method === "GET" && pathname === "/config") {
    const data = loadData();
    return json(res, 200, data.config);
  }

  // ── PUT /config ── salva configurações
  if (req.method === "PUT" && pathname === "/config") {
    const body = await readBody(req);
    const data = loadData();
    data.config = { ...data.config, ...body };
    saveData(data);
    return json(res, 200, { ok: true });
  }

  // ── GET /solicitacoes ── lista todas as solicitações
  if (req.method === "GET" && pathname === "/solicitacoes") {
    const data = loadData();
    return json(res, 200, data.solicitacoes);
  }

  // ── POST /solicitacoes ── cria nova solicitação
  if (req.method === "POST" && pathname === "/solicitacoes") {
    const body = await readBody(req);
    const data = loadData();
    const nova = {
      id:           Date.now(),
      filial:       body.filial       || "",
      solicitante:  body.solicitante  || "",
      idImobilizado:body.idImobilizado|| "",
      numImobilizado:body.numImobilizado|| "",
      equipNome:    body.equipNome    || "",
      descricao:    body.descricao    || "",
      prazo:        body.prazo        || "",
      dataSolicit:  body.dataSolicit  || new Date().toISOString(),
      status:       "pendente",       // pendente | lançada
    };
    data.solicitacoes.push(nova);
    saveData(data);
    return json(res, 201, nova);
  }

  // ── DELETE /solicitacoes/:id ── remove solicitação
  if (req.method === "DELETE" && pathname.startsWith("/solicitacoes/")) {
    const id   = parseInt(pathname.split("/")[2]);
    const data = loadData();
    data.solicitacoes = data.solicitacoes.filter(s => s.id !== id);
    saveData(data);
    return json(res, 200, { ok: true });
  }

  // ── PUT /solicitacoes/:id ── atualiza status
  if (req.method === "PUT" && pathname.startsWith("/solicitacoes/")) {
    const id   = parseInt(pathname.split("/")[2]);
    const body = await readBody(req);
    const data = loadData();
    const idx  = data.solicitacoes.findIndex(s => s.id === id);
    if (idx !== -1) { data.solicitacoes[idx] = { ...data.solicitacoes[idx], ...body }; saveData(data); }
    return json(res, 200, { ok: true });
  }

  // ── GET /proxy/... ── proxy para API GSB
  if (pathname.startsWith("/proxy/")) {
    const cleanPath = pathname.replace(/^\/proxy/, "");
    return proxyGSB(cleanPath, res);
  }

  json(res, 404, { error: "Not found" });
});

server.listen(PORT, () => console.log(`GSB Proxy+API rodando na porta ${PORT}`));
