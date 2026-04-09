// ============================================================
// SERVIDOR PROXY GSB — Node.js
// Deploy gratuito no Railway.app (https://railway.app)
//
// COMO FAZER O DEPLOY:
// 1. Crie conta em https://railway.app (login com GitHub)
// 2. Clique em "New Project" → "Deploy from GitHub repo"
//    OU "New Project" → "Empty Project" → "Add Service" → "GitHub Repo"
// 3. Faça upload destes 2 arquivos (index.js e package.json)
//    em um repositório GitHub público ou privado
// 4. O Railway detecta automaticamente o Node.js e faz o deploy
// 5. Vá em Settings → Networking → Generate Domain
// 6. Copie a URL gerada e cole no PROXY_URL do oficina-os.html
// ============================================================

const http  = require("http");
const https = require("https");
const url   = require("url");

const GSB_HOST = "api.gsbsoftware.com.br";
const GSB_PORT = 50013;
const AUTH     = "Basic " + Buffer.from("hayashi:cpjlk54*#spl89").toString("base64");
const PORT     = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  // CORS para qualquer origem
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    res.writeHead(204); res.end(); return;
  }

  // Remove /proxy do path
  const cleanPath = req.url.replace(/^\/proxy/, "");

  const options = {
    hostname: GSB_HOST,
    port:     GSB_PORT,
    path:     cleanPath,
    method:   "GET",
    headers:  { "Authorization": AUTH, "Content-Type": "application/json" },
  };

  // Usa HTTP puro (sem SSL) para a API GSB
  const proxy = http.request(options, (gsb) => {
    let data = "";
    gsb.on("data", chunk => data += chunk);
    gsb.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      res.writeHead(gsb.statusCode);
      res.end(data);
    });
  });

  proxy.on("error", (e) => {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  });

  proxy.end();
});

server.listen(PORT, () => {
  console.log(`GSB Proxy rodando na porta ${PORT}`);
});
