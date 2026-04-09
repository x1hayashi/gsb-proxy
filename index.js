const http   = require("http");
const url    = require("url");
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

// ── CONFIG ─────────────────────────────────────────────────
const GSB_HOST = "api.gsbsoftware.com.br";
const GSB_PORT = 50013;
const GSB_AUTH = "Basic " + Buffer.from("hayashi:cpjlk54*#spl89").toString("base64");
const GSB_CLIENTE = "cf051147574882010032";
const GSB_TOKEN   = "$2a$10$BueYcMU8EZboMx3Fy12S8";
const PORT = process.env.PORT || 3000;
const DATA_FILE = "/tmp/gsb_data.json";

// ── PERSISTÊNCIA ───────────────────────────────────────────
function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch {
    return {
      config:       { whatsHGO: "", whatsHBA: "" },
      solicitacoes: [],
      usuarios:     [],
      sessoes:      {}
    };
  }
}
function saveData(d) { fs.writeFileSync(DATA_FILE, JSON.stringify(d), "utf8"); }

function hash(str) { return crypto.createHash("sha256").update(str).digest("hex"); }
function token()   { return crypto.randomBytes(32).toString("hex"); }

// ── HELPERS ────────────────────────────────────────────────
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
function json(res, status, obj) {
  cors(res); res.setHeader("Content-Type", "application/json");
  res.writeHead(status); res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise(resolve => {
    let b = "";
    req.on("data", c => b += c);
    req.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } });
  });
}
function authMiddleware(req, res) {
  const data = loadData();
  const authHeader = req.headers["authorization"] || "";
  const tok = authHeader.replace("Bearer ", "").trim();
  if (!tok) return null;
  const sessao = data.sessoes[tok];
  if (!sessao) return null;
  // Sessão expira em 7 dias
  if (Date.now() - sessao.criada > 7 * 24 * 60 * 60 * 1000) {
    delete data.sessoes[tok]; saveData(data); return null;
  }
  const usuario = data.usuarios.find(u => u.id === sessao.userId);
  return usuario || null;
}

// ── GSB PROXY ──────────────────────────────────────────────
function proxyGSB(cleanPath, res) {
  const options = {
    hostname: GSB_HOST, port: GSB_PORT,
    path: `${cleanPath}/${GSB_CLIENTE}/${GSB_TOKEN}`,
    method: "GET",
    headers: { "Authorization": GSB_AUTH, "Content-Type": "application/json" },
  };
  const proxy = http.request(options, gsb => {
    let data = "";
    gsb.on("data", c => data += c);
    gsb.on("end", () => {
      try { json(res, gsb.statusCode, JSON.parse(data || "null")); }
      catch { json(res, 500, { error: "Parse error" }); }
    });
  });
  proxy.on("error", e => json(res, 500, { error: e.message }));
  proxy.end();
}

function proxyGSBDated(cleanPath, d1, d2, res) {
  const options = {
    hostname: GSB_HOST, port: GSB_PORT,
    path: `${cleanPath}/${d1}/${d2}/${GSB_CLIENTE}/${GSB_TOKEN}`,
    method: "GET",
    headers: { "Authorization": GSB_AUTH, "Content-Type": "application/json" },
  };
  const proxy = http.request(options, gsb => {
    let data = "";
    gsb.on("data", c => data += c);
    gsb.on("end", () => {
      try { json(res, gsb.statusCode, JSON.parse(data || "null")); }
      catch { json(res, 500, { error: "Parse error" }); }
    });
  });
  proxy.on("error", e => json(res, 500, { error: e.message }));
  proxy.end();
}

// ── SERVER ─────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // ── AUTH: Registro ─────────────────────────────────────
  if (req.method === "POST" && pathname === "/auth/registrar") {
    const body = await readBody(req);
    const { nome, whatsapp, senha, filial } = body;
    if (!nome || !whatsapp || !senha) return json(res, 400, { error: "Campos obrigatórios" });
    const data = loadData();
    if (data.usuarios.find(u => u.whatsapp === whatsapp))
      return json(res, 409, { error: "WhatsApp já cadastrado" });
    const novo = {
      id:        Date.now(),
      nome,
      whatsapp:  whatsapp.replace(/\D/g, ""),
      senhaHash: hash(senha),
      filial:    filial || "",
      status:    "pendente", // pendente | aprovado | bloqueado
      admin:     false,
      criado:    new Date().toISOString(),
    };
    // Primeiro usuário vira admin aprovado automaticamente
    if (data.usuarios.length === 0) { novo.status = "aprovado"; novo.admin = true; }
    data.usuarios.push(novo);
    saveData(data);
    return json(res, 201, { ok: true, primeiroAdmin: novo.admin });
  }

  // ── AUTH: Login ────────────────────────────────────────
  if (req.method === "POST" && pathname === "/auth/login") {
    const body = await readBody(req);
    const { whatsapp, senha } = body;
    const data = loadData();
    const usuario = data.usuarios.find(u =>
      u.whatsapp === whatsapp.replace(/\D/g, "") && u.senhaHash === hash(senha)
    );
    if (!usuario) return json(res, 401, { error: "Credenciais inválidas" });
    if (usuario.status === "pendente")  return json(res, 403, { error: "Aguardando aprovação do administrador" });
    if (usuario.status === "bloqueado") return json(res, 403, { error: "Acesso bloqueado" });
    const tok = token();
    if (!data.sessoes) data.sessoes = {};
    data.sessoes[tok] = { userId: usuario.id, criada: Date.now() };
    saveData(data);
    return json(res, 200, {
      token: tok,
      nome:  usuario.nome,
      filial: usuario.filial,
      admin: usuario.admin,
      id:    usuario.id,
    });
  }

  // ── AUTH: Logout ───────────────────────────────────────
  if (req.method === "POST" && pathname === "/auth/logout") {
    const tok = (req.headers["authorization"] || "").replace("Bearer ", "");
    const data = loadData();
    delete data.sessoes[tok];
    saveData(data);
    return json(res, 200, { ok: true });
  }

  // ── ADMIN: Lista usuários (admin only) ─────────────────
  if (req.method === "GET" && pathname === "/admin/usuarios") {
    const user = authMiddleware(req, res);
    if (!user || !user.admin) return json(res, 403, { error: "Sem permissão" });
    const data = loadData();
    return json(res, 200, data.usuarios.map(u => ({
      id: u.id, nome: u.nome, whatsapp: u.whatsapp,
      filial: u.filial, status: u.status, admin: u.admin, criado: u.criado,
    })));
  }

  // ── ADMIN: Aprovar/Bloquear usuário ────────────────────
  if (req.method === "PUT" && pathname.startsWith("/admin/usuarios/")) {
    const user = authMiddleware(req, res);
    if (!user || !user.admin) return json(res, 403, { error: "Sem permissão" });
    const id   = parseInt(pathname.split("/")[3]);
    const body = await readBody(req);
    const data = loadData();
    const idx  = data.usuarios.findIndex(u => u.id === id);
    if (idx === -1) return json(res, 404, { error: "Usuário não encontrado" });
    if (body.status) data.usuarios[idx].status = body.status;
    if (body.admin !== undefined) data.usuarios[idx].admin = body.admin;
    if (body.filial) data.usuarios[idx].filial = body.filial;
    saveData(data);
    return json(res, 200, { ok: true });
  }

  // ── CONFIG ─────────────────────────────────────────────
  if (req.method === "GET" && pathname === "/config") {
    const user = authMiddleware(req, res);
    if (!user) return json(res, 401, { error: "Não autenticado" });
    return json(res, 200, loadData().config);
  }
  if (req.method === "PUT" && pathname === "/config") {
    const user = authMiddleware(req, res);
    if (!user || !user.admin) return json(res, 403, { error: "Sem permissão" });
    const body = await readBody(req);
    const data = loadData();
    data.config = { ...data.config, ...body };
    saveData(data);
    return json(res, 200, { ok: true });
  }

  // ── SOLICITAÇÕES ───────────────────────────────────────
  if (req.method === "GET" && pathname === "/solicitacoes") {
    const user = authMiddleware(req, res);
    if (!user) return json(res, 401, { error: "Não autenticado" });
    return json(res, 200, loadData().solicitacoes);
  }
  if (req.method === "POST" && pathname === "/solicitacoes") {
    const user = authMiddleware(req, res);
    if (!user) return json(res, 401, { error: "Não autenticado" });
    const body = await readBody(req);
    const data = loadData();
    const nova = {
      id: Date.now(), ...body,
      userId:      user.id,
      dataSolicit: new Date().toISOString(),
      status:      "pendente",
    };
    data.solicitacoes.push(nova);
    saveData(data);
    return json(res, 201, nova);
  }
  if (req.method === "PUT" && pathname.startsWith("/solicitacoes/")) {
    const user = authMiddleware(req, res);
    if (!user) return json(res, 401, { error: "Não autenticado" });
    const id   = parseInt(pathname.split("/")[2]);
    const body = await readBody(req);
    const data = loadData();
    const idx  = data.solicitacoes.findIndex(s => s.id === id);
    if (idx !== -1) { data.solicitacoes[idx] = { ...data.solicitacoes[idx], ...body }; saveData(data); }
    return json(res, 200, { ok: true });
  }
  if (req.method === "DELETE" && pathname.startsWith("/solicitacoes/")) {
    const user = authMiddleware(req, res);
    if (!user) return json(res, 401, { error: "Não autenticado" });
    const id   = parseInt(pathname.split("/")[2]);
    const data = loadData();
    data.solicitacoes = data.solicitacoes.filter(s => s.id !== id);
    saveData(data);
    return json(res, 200, { ok: true });
  }

  // ── GSB PROXY (autenticado) ────────────────────────────
  if (pathname.startsWith("/proxy/")) {
    const user = authMiddleware(req, res);
    if (!user) return json(res, 401, { error: "Não autenticado" });
    const parts = pathname.replace(/^\/proxy\//, "").split("/");
    // Detecta se é rota com data: /proxy/endpoint/d1/d2
    if (parts.length === 3) {
      return proxyGSBDated(`/${parts[0]}`, parts[1], parts[2], res);
    }
    return proxyGSB(`/${parts[0]}`, res);
  }

  json(res, 404, { error: "Not found" });
});

server.listen(PORT, () => console.log(`GSB Servidor rodando na porta ${PORT}`));
