const http   = require("http");
const url    = require("url");
const crypto = require("crypto");

// ── CONFIG ─────────────────────────────────────────────────
const GSB_HOST  = "api.gsbsoftware.com.br";
const GSB_PORT  = 50013;
const GSB_AUTH  = "Basic " + Buffer.from("hayashi:cpjlk54*#spl89").toString("base64");
const GSB_CLI   = "cf051147574882010032";
const GSB_TOK   = "$2a$10$BueYcMU8EZboMx3Fy12S8";
const PORT      = process.env.PORT || 3000;

const SB_URL    = process.env.SUPABASE_URL  || "https://jcxufffjufocevvcbcxv.supabase.co";
const SB_KEY    = process.env.SUPABASE_KEY  || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpjeHVmZmZqdWZvY2V2dmNiY3h2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU3NTkwNDgsImV4cCI6MjA5MTMzNTA0OH0.40E2DJmYdzfSizgdEtd-GWzesNRY-bAN8LRR_4w_iJ0";

// ── SUPABASE REST HELPER ───────────────────────────────────
const https = require("https");

function sbReq(method, table, body, query) {
  return new Promise((resolve, reject) => {
    let path = `/rest/v1/${table}`;
    if (query) path += `?${query}`;
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: new URL(SB_URL).hostname,
      port: 443,
      path,
      method,
      headers: {
        "apikey":        SB_KEY,
        "Authorization": "Bearer " + SB_KEY,
        "Content-Type":  "application/json",
        "Prefer":        method === "POST" ? "return=representation" : "return=representation",
      },
    };
    if (data) opts.headers["Content-Length"] = Buffer.byteLength(data);
    const req = https.request(opts, res => {
      let d = "";
      res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d || "[]") }); }
        catch { resolve({ status: res.statusCode, data: d }); }
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// Helpers Supabase
async function sbGet(table, query)       { return sbReq("GET",    table, null,  query); }
async function sbPost(table, body)       { return sbReq("POST",   table, body,  null); }
async function sbPatch(table, body, q)   { return sbReq("PATCH",  table, body,  q); }
async function sbDelete(table, query)    { return sbReq("DELETE", table, null,  query); }

// ── AUTH ───────────────────────────────────────────────────
function hashSenha(s) { return crypto.createHash("sha256").update(s + "gsb2026").digest("hex"); }
function gerarToken() { return crypto.randomBytes(32).toString("hex"); }

async function getSession(req) {
  const tok = (req.headers["authorization"] || "").replace("Bearer ", "").trim();
  if (!tok) return null;
  const r = await sbGet("sessoes", `token=eq.${tok}&expira_em=gte.${new Date().toISOString()}&select=user_id,usuarios(id,nome,whatsapp,filial,status,admin)`);
  if (!r.data || !r.data[0]) return null;
  const u = r.data[0].usuarios;
  if (!u || u.status !== "aprovado") return null;
  return u;
}

// ── HTTP HELPERS ───────────────────────────────────────────
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
}
function json(res, status, obj) {
  cors(res); res.setHeader("Content-Type", "application/json");
  res.writeHead(status); res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise(resolve => {
    let b = ""; req.on("data", c => b += c);
    req.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } });
  });
}

// ── GSB CACHE ──────────────────────────────────────────────
// Guarda respostas da API GSB em memória por um tempo
// Cadastros (funcionarios, setores, etc): 10 minutos
// OS do período: 2 minutos
const cache = new Map(); // key → { data, expiresAt }
const pending = new Map(); // key → Promise (deduplicação)

const TTL = {
  default:  10 * 60 * 1000, // 10 min para cadastros estáticos
  os:        2 * 60 * 1000, // 2 min para OS e produtos
};

function cacheKey(path) { return path; }

function getTTL(path) {
  if (path.includes('ordemservico') || path.includes('produto')) return TTL.os;
  return TTL.default;
}

function fromCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { cache.delete(key); return null; }
  return entry.data;
}

function toCache(key, data, ttl) {
  cache.set(key, { data, expiresAt: Date.now() + ttl });
}

// ── GSB PROXY COM CACHE ────────────────────────────────────
function proxyGSB(gsbPath, res) {
  const key = cacheKey(gsbPath);

  // 1. Tenta retornar do cache
  const cached = fromCache(key);
  if (cached) {
    res.setHeader('X-Cache', 'HIT');
    return json(res, 200, cached);
  }

  // 2. Se já há uma requisição em andamento para o mesmo endpoint,
  //    aguarda ela terminar em vez de fazer nova chamada (deduplicação)
  if (pending.has(key)) {
    pending.get(key).then(data => {
      if (data) json(res, 200, data);
      else json(res, 502, { error: 'Upstream error' });
    }).catch(() => json(res, 502, { error: 'Upstream error' }));
    return;
  }

  // 3. Faz a requisição real à GSB
  const promise = new Promise((resolve) => {
    const opts = {
      hostname: GSB_HOST, port: GSB_PORT, path: gsbPath,
      method: "GET",
      headers: { "Authorization": GSB_AUTH, "Content-Type": "application/json" },
    };
    const px = http.request(opts, gsb => {
      let d = ""; gsb.on("data", c => d += c);
      gsb.on("end", () => {
        pending.delete(key);
        try {
          const parsed = JSON.parse(d || "null");
          if (gsb.statusCode === 200) {
            toCache(key, parsed, getTTL(gsbPath));
          }
          json(res, gsb.statusCode, parsed);
          resolve(gsb.statusCode === 200 ? parsed : null);
        } catch {
          json(res, gsb.statusCode, { raw: d });
          resolve(null);
        }
      });
    });
    px.on("error", e => {
      pending.delete(key);
      json(res, 500, { error: e.message });
      resolve(null);
    });
    px.end();
  });

  pending.set(key, promise);
}

// ── SERVER ─────────────────────────────────────────────────
http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const p = url.parse(req.url, true).pathname;

  // ── REGISTRO ───────────────────────────────────────────────
  if (req.method === "POST" && p === "/auth/registrar") {
    const { nome, whatsapp, senha, filial } = await readBody(req);
    if (!nome || !whatsapp || !senha || !filial)
      return json(res, 400, { error: "Preencha todos os campos" });

    const whatsClean = whatsapp.replace(/\D/g, "");
    // Verifica se já existe
    const existe = await sbGet("usuarios", `whatsapp=eq.${whatsClean}`);
    if (existe.data && existe.data.length > 0)
      return json(res, 409, { error: "WhatsApp já cadastrado" });

    // Verifica se é o primeiro usuário
    const todos = await sbGet("usuarios", "select=id");
    const primeiro = !todos.data || todos.data.length === 0;

    const novo = {
      nome,
      whatsapp: whatsClean,
      senha_hash: hashSenha(senha),
      filial,
      status: primeiro ? "aprovado" : "pendente",
      admin:  primeiro,
    };
    const r = await sbPost("usuarios", novo);
    if (r.status !== 201) return json(res, 500, { error: "Erro ao criar usuário" });
    return json(res, 201, { ok: true, primeiroAdmin: primeiro });
  }

  // ── LOGIN ──────────────────────────────────────────────────
  if (req.method === "POST" && p === "/auth/login") {
    const { whatsapp, senha } = await readBody(req);
    const whatsClean = (whatsapp || "").replace(/\D/g, "");
    const r = await sbGet("usuarios", `whatsapp=eq.${whatsClean}&senha_hash=eq.${hashSenha(senha)}`);
    if (!r.data || !r.data[0]) return json(res, 401, { error: "WhatsApp ou senha incorretos" });
    const u = r.data[0];
    if (u.status === "pendente")  return json(res, 403, { error: "Aguardando aprovação do administrador" });
    if (u.status === "bloqueado") return json(res, 403, { error: "Acesso bloqueado" });

    const token = gerarToken();
    const expira = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await sbPost("sessoes", { token, user_id: u.id, expira_em: expira });

    return json(res, 200, { token, nome: u.nome, filial: u.filial, admin: u.admin, id: u.id });
  }

  // ── ADMIN: LISTAR USUÁRIOS ─────────────────────────────────
  if (req.method === "GET" && p === "/admin/usuarios") {
    const sess = await getSession(req);
    if (!sess || !sess.admin) return json(res, 403, { error: "Sem permissão" });
    const r = await sbGet("usuarios", "select=id,nome,whatsapp,filial,status,admin,criado_em&order=criado_em.asc");
    return json(res, 200, r.data || []);
  }

  // ── ADMIN: ATUALIZAR USUÁRIO ───────────────────────────────
  if (req.method === "PUT" && p.startsWith("/admin/usuarios/")) {
    const sess = await getSession(req);
    if (!sess || !sess.admin) return json(res, 403, { error: "Sem permissão" });
    const id   = p.split("/")[3];
    const body = await readBody(req);
    const upd  = {};
    if (body.status) upd.status = body.status;
    if (body.admin  !== undefined) upd.admin = body.admin;
    await sbPatch("usuarios", upd, `id=eq.${id}`);
    return json(res, 200, { ok: true });
  }

  // ── ADMIN: REMOVER USUÁRIO ─────────────────────────────────
  if (req.method === "DELETE" && p.startsWith("/admin/usuarios/")) {
    const sess = await getSession(req);
    if (!sess || !sess.admin) return json(res, 403, { error: "Sem permissão" });
    const id = p.split("/")[3];
    await sbDelete("sessoes",  `user_id=eq.${id}`);
    await sbDelete("usuarios", `id=eq.${id}`);
    return json(res, 200, { ok: true });
  }

  // ── CONFIG ─────────────────────────────────────────────────
  if (req.method === "GET" && p === "/config") {
    const sess = await getSession(req);
    if (!sess) return json(res, 401, { error: "Não autenticado" });
    const r = await sbGet("config", "select=chave,valor");
    const cfg = {};
    (r.data || []).forEach(row => cfg[row.chave] = row.valor);
    return json(res, 200, cfg);
  }

  if (req.method === "PUT" && p === "/config") {
    const sess = await getSession(req);
    if (!sess || !sess.admin) return json(res, 403, { error: "Sem permissão" });
    const body = await readBody(req);
    for (const [chave, valor] of Object.entries(body)) {
      await sbPatch("config", { valor }, `chave=eq.${chave}`);
    }
    return json(res, 200, { ok: true });
  }

  // ── SOLICITAÇÕES ───────────────────────────────────────────
  if (req.method === "GET" && p === "/solicitacoes") {
    const sess = await getSession(req);
    if (!sess) return json(res, 401, { error: "Não autenticado" });
    const r = await sbGet("solicitacoes", "order=data_solicit.desc");
    return json(res, 200, r.data || []);
  }

  if (req.method === "POST" && p === "/solicitacoes") {
    const sess = await getSession(req);
    if (!sess) return json(res, 401, { error: "Não autenticado" });
    const body = await readBody(req);
    const nova = {
      filial:          body.filial,
      solicitante:     body.solicitante,
      id_imobilizado:  body.idImobilizado,
      num_imobilizado: body.numImobilizado,
      equip_nome:      body.equipNome,
      descricao:       body.descricao,
      prazo:           body.prazo || null,
      status:          "pendente",
      user_id:         sess.id,
    };
    const r = await sbPost("solicitacoes", nova);
    return json(res, 201, r.data?.[0] || nova);
  }

  if (req.method === "PUT" && p.startsWith("/solicitacoes/")) {
    const sess = await getSession(req);
    if (!sess) return json(res, 401, { error: "Não autenticado" });
    const id   = p.split("/")[2];
    const body = await readBody(req);
    const upd  = {};
    if (body.status) upd.status = body.status;
    await sbPatch("solicitacoes", upd, `id=eq.${id}`);
    return json(res, 200, { ok: true });
  }

  if (req.method === "DELETE" && p.startsWith("/solicitacoes/")) {
    const sess = await getSession(req);
    if (!sess) return json(res, 401, { error: "Não autenticado" });
    const id = p.split("/")[2];
    await sbDelete("solicitacoes", `id=eq.${id}`);
    return json(res, 200, { ok: true });
  }

  // ── LIMPAR CACHE (admin) ───────────────────────────────────
  if (req.method === "POST" && p === "/cache/clear") {
    const sess = await getSession(req);
    if (!sess || !sess.admin) return json(res, 403, { error: "Sem permissão" });
    const size = cache.size;
    cache.clear();
    pending.clear();
    return json(res, 200, { ok: true, cleared: size });
  }

  // ── GSB PROXY ──────────────────────────────────────────────
  if (p.startsWith("/proxy/")) {
    const sess = await getSession(req);
    if (!sess) return json(res, 401, { error: "Não autenticado" });
    const parts = p.replace(/^\/proxy\//, "").split("/");
    let gsbPath;
    if (parts.length === 3) {
      gsbPath = `/${parts[0]}/${parts[1]}/${parts[2]}/${GSB_CLI}/${encodeURIComponent(GSB_TOK)}`;
    } else {
      gsbPath = `/${parts[0]}/${GSB_CLI}/${encodeURIComponent(GSB_TOK)}`;
    }
    return proxyGSB(gsbPath, res);
  }

  json(res, 404, { error: "Not found" });

}).listen(PORT, () => console.log(`GSB + Supabase rodando na porta ${PORT}`));
