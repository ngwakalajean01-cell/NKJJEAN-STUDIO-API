
// ======================================================
// NKJJEAN-STUDIO — WORKER API
// Authentification sécurisée avec Cloudflare D1
// ======================================================

// ==================== FONCTIONS DE SÉCURITÉ ====================

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function randomHex(bytes = 32) {
  const array = new Uint8Array(bytes);
  crypto.getRandomValues(array);

  return Array.from(array)
    .map(value => value.toString(16).padStart(2, "0"))
    .join("");
}

const PBKDF2_ITERATIONS = 100000;
const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;

async function passwordHash(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const derived = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256"
    },
    key,
    256
  );

  const saltHex = Array.from(salt)
    .map(value => value.toString(16).padStart(2, "0"))
    .join("");

  const hashHex = Array.from(new Uint8Array(derived))
    .map(value => value.toString(16).padStart(2, "0"))
    .join("");

  return `pbkdf2-sha256$${PBKDF2_ITERATIONS}$${saltHex}$${hashHex}`;
}

async function verifyPassword(password, stored) {
  if (typeof stored !== "string") return false;

  let iterations;
  let saltHex;
  let expectedHex;
  const parts = stored.split("$");

  if (parts.length === 4 && parts[0] === "pbkdf2-sha256") {
    iterations = Number(parts[1]);
    saltHex = parts[2];
    expectedHex = parts[3];
  } else {
    // Compatibilité avec les comptes créés avant le correctif :
    // l'ancien code avait oublié les séparateurs "$".
    const legacyPrefix = "pbkdf2-sha256" + PBKDF2_ITERATIONS;
    if (
      !stored.startsWith(legacyPrefix) ||
      stored.length !== legacyPrefix.length + 96
    ) {
      return false;
    }
    iterations = PBKDF2_ITERATIONS;
    saltHex = stored.slice(legacyPrefix.length, legacyPrefix.length + 32);
    expectedHex = stored.slice(legacyPrefix.length + 32);
  }

  if (
    !Number.isInteger(iterations) ||
    iterations !== PBKDF2_ITERATIONS ||
    !/^[a-f0-9]{32}$/i.test(saltHex) ||
    !/^[a-f0-9]{64}$/i.test(expectedHex)
  ) {
    return false;
  }

  const salt = new Uint8Array(
    saltHex.match(/.{2}/g).map(byte => parseInt(byte, 16))
  );

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const derived = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256"
    },
    key,
    256
  );

  const actual = new Uint8Array(derived);
  const expected = new Uint8Array(
    expectedHex.match(/.{2}/g).map(byte => parseInt(byte, 16))
  );

  if (actual.length !== expected.length) return false;

  let difference = 0;

  for (let i = 0; i < actual.length; i++) {
    difference |= actual[i] ^ expected[i];
  }

  return difference === 0;
}

async function sessionTokenHash(token, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(token)
  );

  return Array.from(new Uint8Array(signature))
    .map(value => value.toString(16).padStart(2, "0"))
    .join("");
}


// ==================== NKJJEAN STUDIO : MODULES ====================

const STUDIO_DEFAULT_QUOTAS = {
  requests_limit: 1000,
  tokens_limit: 100000,
  daily_limit: 100,
  monthly_limit: 1000,
  free_access: 1
};

function studioText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength || 2000) : "";
}

function studioSlug(value) {
  return studioText(value, 120).toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

async function studioHash(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map(v => v.toString(16).padStart(2, "0")).join("");
}

async function studioReadBody(request) {
  const size = Number(request.headers.get("Content-Length") || "0");
  if (size > 1024 * 1024) throw new Error("PAYLOAD_TOO_LARGE");
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("INVALID_JSON");
    return body;
  } catch (error) {
    throw new Error("INVALID_JSON");
  }
}

async function studioGetUser(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer ([a-f0-9]{64})$/i);
  if (!match) return null;
  const hash = await sessionTokenHash(match[1].toLowerCase(), env.SESSION_SECRET);
  const session = await env.DB.prepare(
    "SELECT s.id AS session_id,s.user_id,s.expires_at,u.email,u.role,u.status FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? LIMIT 1"
  ).bind(hash, new Date().toISOString()).first();
  if (!session || session.status !== "active") return null;
  const refreshedExpiry = new Date(Date.now() + SESSION_IDLE_MS).toISOString();
  await env.DB.prepare(
    "UPDATE user_sessions SET expires_at=? WHERE id=? AND revoked_at IS NULL"
  ).bind(refreshedExpiry, session.session_id).run();
  return { id: session.user_id, email: session.email, role: session.role };
}

async function studioProjectOwner(env, projectId, userId) {
  return await env.DB.prepare(
    "SELECT id,user_id,name,description,status,created_at,updated_at FROM projects WHERE id=? AND user_id=? AND status='active' LIMIT 1"
  ).bind(projectId, userId).first();
}

async function studioWorkspaceReady(env) {
  const result = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('project_conversations','project_messages')"
  ).all();
  return !!(result && result.results && result.results.length === 2);
}

// Vérifie les colonnes nécessaires sans exposer de données personnelles.
async function studioHasColumns(env, table, requiredColumns) {
  const allowedTables = new Set(["users", "user_sessions", "published_apps", "app_versions", "published_resources", "resource_files", "app_release_files"]);
  if (!env.DB || !allowedTables.has(table)) return false;
  try {
    const result = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
    const available = new Set((result.results || []).map(column => column.name));
    return requiredColumns.every(column => available.has(column));
  } catch (error) {
    return false;
  }
}

async function studioApiKey(request, env) {
  const raw = request.headers.get("X-API-Key") || "";
  if (!/^nkj_live_[a-f0-9]{64}$/i.test(raw)) return null;
  const hash = await studioHash(raw);
  const key = await env.DB.prepare(
    "SELECT k.id AS api_key_id,k.project_id,p.user_id,p.status AS project_status,k.status AS key_status FROM api_keys k JOIN projects p ON p.id=k.project_id WHERE k.key_hash=? LIMIT 1"
  ).bind(hash).first();
  if (!key || key.key_status !== "active" || key.project_status !== "active") return null;
  return key;
}

async function studioGenerateWithOwnAI(env, options) {
  if (!env.NKJ_AI || typeof env.NKJ_AI.fetch !== "function") {
    return { success:false, status:503, error:"Le moteur IA propriétaire NKJJEAN n'est pas encore relié à cette plateforme.", code:"AI_ENGINE_NOT_CONFIGURED" };
  }

  const prompt = studioText(options.prompt, 20000);
  if (!prompt) return { success:false, status:400, error:"Le message destiné à l'IA est vide." };

  const quota = await env.DB.prepare(
    "SELECT requests_limit,tokens_limit,daily_limit,monthly_limit FROM project_quotas WHERE project_id=? LIMIT 1"
  ).bind(options.projectId).first();
  if (!quota) return { success:false, status:403, error:"Les quotas de ce projet sont introuvables." };

  const daily = await env.DB.prepare(
    "SELECT COALESCE(SUM(requests_count),0) AS requests,COALESCE(SUM(input_tokens+output_tokens),0) AS tokens FROM usage_logs WHERE project_id=? AND created_at>=strftime('%Y-%m-%dT00:00:00Z','now')"
  ).bind(options.projectId).first();
  const month = await env.DB.prepare(
    "SELECT COALESCE(SUM(requests_count),0) AS requests FROM usage_logs WHERE project_id=? AND substr(created_at,1,7)=strftime('%Y-%m','now')"
  ).bind(options.projectId).first();
  if ((quota.daily_limit > 0 && Number(daily.requests) >= quota.daily_limit) ||
      (quota.monthly_limit > 0 && Number(month.requests) >= quota.monthly_limit) ||
      (quota.requests_limit > 0 && Number(month.requests) >= quota.requests_limit)) {
    return { success:false, status:429, error:"Le quota de requêtes de ce projet est atteint.", code:"PROJECT_QUOTA_EXCEEDED" };
  }
  if (quota.tokens_limit > 0 && Number(daily.tokens) >= quota.tokens_limit) {
    return { success:false, status:429, error:"Le quota quotidien de jetons de ce projet est atteint.", code:"PROJECT_TOKEN_QUOTA_EXCEEDED" };
  }

  const requestId = randomHex(16);
  let response;
  try {
    const internalRequest = new Request("https://nkjjean-ai.internal/v1/generate", {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "Accept":"application/json",
        "X-NKJJEAN-REQUEST-ID":requestId
      },
      body:JSON.stringify({
        model:"nkjjean-proprietary",
        task:"chat",
        prompt,
        context:options.context || {},
        history:Array.isArray(options.history) ? options.history.slice(-20) : [],
        project:{id:options.projectId,user_id:options.userId},
        conversation_id:options.conversationId || null
      })
    });
    response = await env.NKJ_AI.fetch(internalRequest);
  } catch (error) {
    return { success:false,status:502,error:"Le moteur IA propriétaire est momentanément injoignable.",code:"AI_ENGINE_UNREACHABLE" };
  }
  if (!response || !response.ok) {
    return { success:false,status:502,error:"Le moteur IA propriétaire a refusé ou interrompu la demande.",code:"AI_ENGINE_ERROR" };
  }

  let generated;
  try { generated = await response.json(); }
  catch (error) { return { success:false,status:502,error:"Réponse invalide du moteur IA propriétaire.",code:"AI_ENGINE_INVALID_RESPONSE" }; }

  const answer = typeof generated.answer === "string" ? generated.answer.trim()
    : (typeof generated.output_text === "string" ? generated.output_text.trim()
      : (typeof generated.response === "string" ? generated.response.trim() : ""));
  if (!answer) return { success:false,status:502,error:"Le moteur IA n'a pas renvoyé de réponse exploitable.",code:"AI_ENGINE_EMPTY_RESPONSE" };

  const inputTokens = Math.max(0,Math.min(10000000,Number(generated.usage && generated.usage.input_tokens) || 0));
  const outputTokens = Math.max(0,Math.min(10000000,Number(generated.usage && generated.usage.output_tokens) || 0));
  if (quota.tokens_limit > 0 && Number(daily.tokens) + inputTokens + outputTokens > quota.tokens_limit) {
    return { success:false,status:429,error:"Cette réponse dépasserait le quota quotidien de jetons du projet.",code:"PROJECT_TOKEN_QUOTA_EXCEEDED" };
  }

  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      "INSERT INTO usage_logs (id,project_id,api_key_id,endpoint,requests_count,input_tokens,output_tokens,status_code,created_at) VALUES (?,?,?,?,1,?,?,200,?)"
    ).bind(requestId,options.projectId,options.apiKeyId || null,"/v1/ai",inputTokens,outputTokens,now).run();
  } catch (error) {
    return { success:false,status:500,error:"La réponse IA a été produite, mais son utilisation n'a pas pu être enregistrée.",code:"AI_USAGE_LOG_FAILED" };
  }

  return {
    success:true,
    answer,
    model:typeof generated.model === "string" ? generated.model : "NKJJEAN IA propriétaire",
    usage:{input_tokens:inputTokens,output_tokens:outputTokens},
    request_id:requestId
  };
}

const STUDIO_HOME_HTML = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="NKJJEAN STUDIO : recherchez les applications, cours et ressources numériques publiés."><meta name="robots" content="index,follow"><title>NKJJEAN STUDIO — Catalogue numérique</title><style>
:root{color-scheme:dark;--bg:#07111f;--line:#284863;--muted:#a8bbce;--blue:#62b4ff;--cyan:#65e0df}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 0,#14385b 0,transparent 35%),var(--bg);color:#edf6ff;font:16px/1.65 system-ui,sans-serif}a{color:inherit;text-decoration:none}.wrap{width:min(1120px,calc(100% - 32px));margin:auto}.top{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:20px 0;border-bottom:1px solid #ffffff1c}.brand{font-weight:950;letter-spacing:.08em}.brand span{color:var(--cyan)}nav{display:flex;gap:18px;flex-wrap:wrap;color:#c1d4e7;font-size:14px}.btn{display:inline-flex;justify-content:center;align-items:center;padding:11px 17px;border-radius:10px;background:linear-gradient(110deg,var(--blue),var(--cyan));color:#061321;font-weight:850;border:0;cursor:pointer}.alt{background:#142d45;color:#eaf3ff;border:1px solid var(--line)}.hero{text-align:center;padding:58px 0 26px}.eyebrow{color:var(--cyan);font-size:12px;font-weight:900;letter-spacing:.17em;text-transform:uppercase}.hero h1{font-size:clamp(34px,6vw,62px);line-height:1.08;margin:12px 0}.hero p{color:var(--muted);max-width:720px;margin:0 auto 24px}.searchbox{display:flex;gap:10px;max-width:780px;margin:26px auto 0;padding:9px;background:#0c2033;border:1px solid #3b6687;border-radius:16px}.searchbox input{flex:1;min-width:0;background:transparent;border:0;outline:0;color:white;padding:12px;font-size:16px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:22px 0 42px}.stat,.card,.panel{background:linear-gradient(150deg,#10243a,#0b1b2c);border:1px solid var(--line);border-radius:15px;padding:18px}.stat strong{display:block;font-size:28px;color:var(--cyan)}.stat span{color:var(--muted);font-size:13px}.section{padding:22px 0 42px}.section h2{margin:5px 0;font-size:28px}.muted{color:var(--muted)}.quick{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.card h3{margin:8px 0}.card p{color:var(--muted);margin:0 0 14px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(235px,1fr));gap:14px;margin-top:18px}.tag{color:var(--cyan);font-size:12px;font-weight:800;text-transform:uppercase}.foot{border-top:1px solid #ffffff1c;padding:25px 0;color:var(--muted);font-size:13px;display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap}@media(max-width:700px){nav{gap:12px}.stats{grid-template-columns:repeat(2,1fr)}.quick{grid-template-columns:1fr}.searchbox{flex-direction:column}.searchbox .btn{width:100%}}
</style></head><body><div class="wrap"><header class="top"><a class="brand" href="/">NKJJEAN<span> STUDIO</span></a><nav><a href="/applications">Applications</a><a href="/cours">Cours</a><a href="/publications">Autres contenus</a><a href="/docs">Aide</a><a class="btn alt" href="/app">Mon espace</a></nav></header><main><section class="hero"><div class="eyebrow">Votre bibliothèque numérique</div><h1>Trouvez ce dont vous avez besoin.</h1><p>Recherchez des applications, des cours et des ressources numériques publiés et validés par NKJJEAN STUDIO.</p><form class="searchbox" id="homeSearch"><input id="homeQuery" type="search" placeholder="Rechercher une application, un cours ou un contenu…" aria-label="Rechercher dans le catalogue"><button class="btn">Rechercher</button></form></section><section class="stats"><div class="stat"><strong id="countAll">—</strong><span>Publications disponibles</span></div><div class="stat"><strong id="countApps">—</strong><span>Applications</span></div><div class="stat"><strong id="countCourses">—</strong><span>Cours</span></div><div class="stat"><strong id="countContents">—</strong><span>Autres contenus</span></div></section><section class="section"><div class="eyebrow">Explorer</div><h2>Accès rapides</h2><div class="quick"><a class="card" href="/applications"><div class="tag">Logiciels et outils</div><h3>Applications</h3><p>Découvrez les applications publiées et leurs versions disponibles.</p><span class="btn alt">Voir les applications</span></a><a class="card" href="/cours"><div class="tag">Apprendre</div><h3>Cours</h3><p>Retrouvez les cours et supports pédagogiques validés.</p><span class="btn alt">Voir les cours</span></a><a class="card" href="/publications"><div class="tag">Ressources</div><h3>Autres contenus</h3><p>Consultez les documents et autres ressources numériques.</p><span class="btn alt">Voir les contenus</span></a></div></section><section class="section"><div class="eyebrow">Mise à jour régulièrement</div><h2>Dernières publications</h2><div id="latest" class="grid"><div class="panel muted">Chargement…</div></div></section><section class="panel"><h2>Vous souhaitez proposer une application ou un cours ?</h2><p class="muted">Créez votre compte, déposez votre fiche et suivez la validation administrative. Rien n'est rendu public avant approbation.</p><a class="btn" href="/app">Proposer une publication</a></section></main><footer class="foot"><span>© NKJJEAN STUDIO</span><span>Paiement prévu : 0814620569 · <a href="mailto:ngwakalajean01@gmail.com">Contact</a></span></footer></div><script>(function(){function esc(v){return String(v==null?"":v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}async function load(){try{const r=await fetch("/api/store/catalog?limit=8"),d=await r.json();if(!r.ok)throw new Error();const c=d.counts||{};document.getElementById("countAll").textContent=c.publications||0;document.getElementById("countApps").textContent=c.applications||0;document.getElementById("countCourses").textContent=c.courses||0;document.getElementById("countContents").textContent=c.contents||0;document.getElementById("latest").innerHTML=(d.items||[]).map(x=>"<article class='card'><div class='tag'>"+esc(x.type)+" · "+esc(x.category)+"</div><h3>"+esc(x.title)+"</h3><p>"+esc((x.description||"").slice(0,150))+"</p><a class='btn alt' href='"+(x.type==="application"?"/applications/":x.type==="course"?"/cours/":"/publications/")+encodeURIComponent(x.slug)+"'>Consulter</a></article>").join("")||"<div class='panel muted'>Aucune publication publique pour le moment.</div>";}catch(e){document.getElementById("latest").textContent="Le catalogue sera disponible dès que la base sera configurée.";}}document.getElementById("homeSearch").onsubmit=e=>{e.preventDefault();location.href="/applications?q="+encodeURIComponent(document.getElementById("homeQuery").value.trim());};load();})();</script></body></html>`;

const STUDIO_WORKSPACE_HTML = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#07111f"><title>Studio du projet — NKJJEAN STUDIO</title><style>:root{color-scheme:dark;--bg:#07111f;--line:#25435f;--muted:#9db1c8;--blue:#56afff;--cyan:#65e0df}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 85% 0,#12365a 0,transparent 35%),var(--bg);color:#eaf3ff;font:15px/1.6 system-ui,sans-serif}.wrap{max-width:1320px;margin:auto;padding:22px 18px 60px}.top,.hero{display:flex;justify-content:space-between;align-items:center;gap:15px;flex-wrap:wrap}.top{border-bottom:1px solid #ffffff18;padding:10px 0 20px}.brand{font-weight:900;letter-spacing:.08em}.brand span{color:var(--cyan)}a{color:#8dccff}.btn{display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:9px;padding:10px 14px;background:linear-gradient(110deg,var(--blue),var(--cyan));color:#061321;font-weight:800;text-decoration:none;cursor:pointer}.secondary{background:#17334d;color:#eaf3ff;border:1px solid #34516d}.danger{background:#602d38;color:#fff}.muted{color:var(--muted)}.panel{background:linear-gradient(150deg,#10243a,#0b1929);border:1px solid var(--line);border-radius:15px;padding:20px;margin:16px 0}.eyebrow{color:var(--cyan);font-size:11px;font-weight:900;letter-spacing:.16em;text-transform:uppercase}.hero h1{font-size:clamp(28px,4vw,42px);margin:5px 0}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0}.stat{background:#0d2033;border:1px solid var(--line);border-radius:13px;padding:15px}.stat strong{display:block;font-size:22px}.tabs,.actions{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0}.tab{border:1px solid #34516d;background:#10263b;color:#eaf3ff;padding:10px 15px;border-radius:9px;cursor:pointer;font-weight:800}.tab.active{background:#56afff;color:#061321}.layout{display:grid;grid-template-columns:300px minmax(0,1fr);gap:16px}.list{display:grid;gap:9px;margin-top:12px}.conversation{width:100%;text-align:left;background:#091a2b;border:1px solid #2a4863;color:#eaf3ff;border-radius:10px;padding:12px;cursor:pointer}.conversation.active{border-color:var(--cyan);background:#12304a}.field{display:block;margin:10px 0;color:#c7d9eb}.field textarea{display:block;width:100%;margin-top:6px;background:#071726;color:#fff;border:1px solid #34516d;border-radius:9px;padding:12px;font:inherit;min-height:110px;resize:vertical}.messages{display:grid;gap:12px;max-height:54vh;overflow:auto;padding:8px 2px}.message{padding:14px;border-radius:12px;max-width:92%;white-space:pre-wrap;overflow-wrap:anywhere}.message.user{justify-self:end;background:#173b5a;border:1px solid #35658b}.message.assistant{justify-self:start;background:#10283d;border:1px solid #2c506d}.notice{border-left:3px solid #e3b45d;background:#332a17;color:#f5dfb3;padding:12px;border-radius:8px;margin:12px 0}.hidden{display:none!important}.keyrow{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:12px 0;border-bottom:1px solid #ffffff15}.empty{padding:28px;border:1px dashed #34516d;border-radius:12px;color:var(--muted);text-align:center}@media(max-width:850px){.layout{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,1fr)}}@media(max-width:480px){.stats{grid-template-columns:1fr 1fr}.wrap{padding:14px 12px 40px}}</style></head><body><main class="wrap"><header class="top"><div class="brand">NKJJEAN <span>STUDIO</span> / PROJET</div><div class="actions"><a class="btn secondary" href="/app">← Retour à mes projets</a><a class="btn secondary" href="/docs">Aide</a></div></header><section class="panel"><div class="hero"><div><div class="eyebrow">Espace de travail privé</div><h1 id="projectName">Chargement du projet…</h1><p id="projectDescription" class="muted"></p><p class="muted" id="projectOwner"></p></div><span class="btn secondary">Données privées du propriétaire</span></div><div id="stats" class="stats"><div class="stat"><span class="muted">Requêtes</span><strong>—</strong></div><div class="stat"><span class="muted">Jetons</span><strong>—</strong></div><div class="stat"><span class="muted">Limite quotidienne</span><strong>—</strong></div><div class="stat"><span class="muted">Journal</span><strong>—</strong></div></div></section><nav class="tabs"><button class="tab active" id="workTab">Espace de travail</button><button class="tab" id="apiTab">API et activité</button></nav><section id="workPanel"><div class="layout"><aside class="panel"><div class="hero"><div><div class="eyebrow">Organisation</div><h2>Conversations</h2></div><button class="btn" id="newConversation">+ Nouvelle</button></div><p class="muted">Tes consignes et notes de travail sont sauvegardées dans ton espace privé.</p><div id="conversationList" class="list"><div class="empty">Chargement…</div></div></aside><section class="panel"><div class="hero"><div><div class="eyebrow">Atelier de travail</div><h2 id="conversationTitle">Choisis ou crée une conversation</h2></div><span class="btn secondary">Historique sauvegardé</span></div><div id="aiNotice" class="notice"><strong>NKJJEAN IA — moteur propriétaire.</strong> Le Studio est prêt pour le moteur privé partagé avec TECHNONKJJEAN et les autres applications. <span id="aiStatusLabel">Vérification de la liaison du moteur…</span> Aucun fournisseur IA externe n'est utilisé.</div><div id="messageList" class="messages"><div class="empty">Crée une conversation pour commencer à organiser le travail de ce projet.</div></div><form id="messageForm" class="hidden"><label class="field">Message à NKJJEAN IA<textarea id="messageContent" maxlength="20000" placeholder="Explique le travail à réaliser. NKJJEAN IA analysera la demande lorsque son moteur propriétaire sera relié…" required></textarea></label><div class="actions"><button class="btn" id="sendAiButton">Envoyer à NKJJEAN IA</button><button class="btn secondary" type="button" id="saveNoteButton">Enregistrer comme note</button></div><p id="aiRequestStatus" class="muted">Le Studio est préparé pour le moteur IA propriétaire NKJJEAN.</p></form><p id="workspaceStatus" class="muted" aria-live="polite"></p></section></div></section><section id="apiPanel" class="panel hidden"><div class="eyebrow">Accès développeur</div><h2>Clés API et activité</h2><p class="muted">Gère les clés utilisées par tes applications clientes et consulte les appels enregistrés pour ce projet.</p><div class="layout"><section class="panel"><h3>Clés API</h3><div id="keysList" class="muted">Chargement…</div></section><section class="panel"><h3>Dernières utilisations</h3><div id="usageList" class="muted">Chargement…</div></section></div></section><p class="muted">NKJJEAN STUDIO — L'hébergement du modèle IA propriétaire et le stockage sécurisé des APK sont des étapes séparées.</p></main><script>(function(){const parts=location.pathname.split("/").filter(Boolean),projectId=parts.length>1?decodeURIComponent(parts[1]):"";let token=localStorage.getItem("nkj_session")||"";const $=id=>document.getElementById(id);function esc(v){return String(v==null?"":v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}async function api(path,opt){opt=opt||{};opt.headers=opt.headers||{};opt.headers["Content-Type"]=opt.headers["Content-Type"]||"application/json";if(token)opt.headers.Authorization="Bearer "+token;const r=await fetch(path,opt);let d={};try{d=await r.json();}catch(e){}if(!r.ok)throw new Error((d.error||"La demande a échoué.")+" (HTTP "+r.status+")");return d;}function showTab(which){$("workPanel").classList.toggle("hidden",which!=="work");$("apiPanel").classList.toggle("hidden",which!=="api");$("workTab").classList.toggle("active",which==="work");$("apiTab").classList.toggle("active",which==="api");if(which==="api")loadApiData();}let currentConversation="";$("workTab").onclick=()=>showTab("work");$("apiTab").onclick=()=>showTab("api");async function loadAiStatus(){try{const r=await fetch("/api/health",{headers:{Accept:"application/json"}}),d=await r.json();$("aiStatusLabel").textContent=d.checks&&d.checks.own_ai_engine_connected?"Moteur privé relié. La disponibilité du modèle doit encore être confirmée.":"Moteur privé non relié pour le moment. Les notes et conversations restent disponibles."; }catch(e){$("aiStatusLabel").textContent="État du moteur indisponible. Les notes restent disponibles.";}}async function loadProject(){const d=await api("/api/projects/"+encodeURIComponent(projectId));const p=d.project,q=d.quotas||{};$("projectName").textContent=p.name;$("projectDescription").textContent=p.description||"Aucune description renseignée.";$("projectOwner").textContent="Créé le "+(p.created_at||"date inconnue");$("stats").innerHTML="<div class='stat'><span class='muted'>Limite de requêtes</span><strong>"+esc(q.requests_limit||0)+"</strong></div><div class='stat'><span class='muted'>Limite de jetons</span><strong>"+esc(q.tokens_limit||0)+"</strong></div><div class='stat'><span class='muted'>Limite quotidienne</span><strong>"+esc(q.daily_limit||0)+"</strong></div><div class='stat'><span class='muted'>Journal d'activité</span><strong>"+esc((d.usage&&d.usage.log_entries)||0)+"</strong></div>";}async function loadConversations(){const d=await api("/api/projects/"+encodeURIComponent(projectId)+"/conversations"),list=$("conversationList");list.innerHTML=(d.conversations||[]).map(c=>"<button class='conversation "+(c.id===currentConversation?"active":"")+"' data-conversation='"+esc(c.id)+"'><strong>"+esc(c.title)+"</strong><br><small class='muted'>"+esc(new Date(c.updated_at).toLocaleString())+"</small></button>").join("")||"<div class='empty'>Aucune conversation. Clique sur « Nouvelle » pour créer ton premier espace de travail.</div>";list.querySelectorAll("[data-conversation]").forEach(b=>b.onclick=()=>openConversation(b.dataset.conversation));}async function openConversation(id){try{const d=await api("/api/conversations/"+encodeURIComponent(id));currentConversation=id;$("conversationTitle").textContent=d.conversation.title;$("messageForm").classList.remove("hidden");$("messageList").innerHTML=(d.messages||[]).map(m=>"<div class='message "+(m.role==="user"?"user":"assistant")+"'><strong>"+(m.role==="user"?"Tes consignes":"Assistant")+"</strong><br>"+esc(m.content)+"</div>").join("")||"<div class='empty'>Cette conversation est vide. Ajoute la première consigne de travail.</div>";await loadConversations();$("workspaceStatus").textContent="Conversation chargée. Les messages précédents sont conservés.";}catch(e){$("workspaceStatus").textContent=e.message;}}$("newConversation").onclick=async()=>{const title=prompt("Titre de cette conversation ou tâche :","Nouvelle tâche");if(title===null)return;try{const d=await api("/api/projects/"+encodeURIComponent(projectId)+"/conversations",{method:"POST",body:JSON.stringify({title:title.trim()||"Nouvelle tâche"})});await loadConversations();await openConversation(d.conversation.id);}catch(e){$("workspaceStatus").textContent=e.message;}};$("messageForm").onsubmit=async e=>{e.preventDefault();if(!currentConversation)return;const field=$("messageContent"),content=field.value.trim();if(!content)return;const btn=$("sendAiButton");btn.disabled=true;btn.textContent="Analyse en cours…";$("aiRequestStatus").textContent="Transmission sécurisée au moteur privé NKJJEAN…";try{const d=await api("/api/projects/"+encodeURIComponent(projectId)+"/ai",{method:"POST",body:JSON.stringify({conversation_id:currentConversation,prompt:content})});field.value="";await openConversation(currentConversation);$("aiRequestStatus").textContent="Réponse reçue de "+(d.model||"NKJJEAN IA propriétaire")+". Jetons suivis : "+(Number(d.usage&&d.usage.input_tokens||0)+Number(d.usage&&d.usage.output_tokens||0))+".";}catch(x){$("aiRequestStatus").textContent=x.message+" Le texte reste disponible dans la zone de saisie : tu peux le copier ou l'enregistrer comme note.";}finally{btn.disabled=false;btn.textContent="Envoyer à NKJJEAN IA";}};$("saveNoteButton").onclick=async()=>{if(!currentConversation)return;const field=$("messageContent"),content=field.value.trim();if(!content)return;const btn=$("saveNoteButton");btn.disabled=true;try{await api("/api/conversations/"+encodeURIComponent(currentConversation),{method:"POST",body:JSON.stringify({content})});field.value="";await openConversation(currentConversation);$("aiRequestStatus").textContent="Note enregistrée dans l'historique du projet.";}catch(x){$("aiRequestStatus").textContent=x.message;}finally{btn.disabled=false;}};async function loadApiData(){try{const d=await api("/api/projects/"+encodeURIComponent(projectId)+"/api-keys");$("keysList").innerHTML=(d.api_keys||[]).map(k=>"<div class='keyrow'><div><strong>"+esc(k.name)+"</strong><br><small class='muted'>"+esc(k.key_prefix)+"… · "+esc(k.status)+"</small></div>"+(k.status==="active"?"<button class='btn danger' data-revoke='"+esc(k.id)+"'>Révoquer</button>":"<span class='muted'>Inactive</span>")+"</div>").join("")||"Aucune clé API.";$("keysList").querySelectorAll("[data-revoke]").forEach(b=>b.onclick=async()=>{if(!confirm("Révoquer cette clé ? Les clients qui l'utilisent seront bloqués."))return;try{await api("/api/projects/"+encodeURIComponent(projectId)+"/api-keys/"+encodeURIComponent(b.dataset.revoke),{method:"DELETE"});await loadApiData();}catch(x){alert(x.message);}});}catch(e){$("keysList").textContent=e.message;}try{const d=await api("/api/projects/"+encodeURIComponent(projectId)+"/usage");$("usageList").innerHTML=(d.usage||[]).map(u=>"<div class='keyrow'><div><strong>"+esc(u.endpoint)+"</strong><br><small class='muted'>"+esc(u.created_at)+"</small></div><span>HTTP "+esc(u.status_code)+" · "+esc(Number(u.input_tokens||0)+Number(u.output_tokens||0))+" jetons</span></div>").join("")||"Aucune utilisation enregistrée.";}catch(e){$("usageList").textContent=e.message;}}async function init(){if(!token){$("workspaceStatus").textContent="Connecte-toi depuis ton espace personnel pour ouvrir ce projet.";return;}if(!projectId){$("workspaceStatus").textContent="Identifiant de projet manquant.";return;}try{await loadAiStatus();await loadProject();await loadConversations();}catch(e){$("workspaceStatus").textContent=e.message;if(e.message.includes("HTTP 401"))location.href="/app";}}init();})();</script></body></html>`;

const STUDIO_STORE_HTML = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Catalogue public NKJJEAN STUDIO : applications, cours et ressources numériques validés."><meta name="robots" content="index,follow"><title>Catalogue public — NKJJEAN STUDIO</title><style>
:root{color-scheme:dark;--bg:#07111f;--line:#284863;--muted:#a8bbce;--blue:#62b4ff;--cyan:#65e0df}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 0,#14385b 0,transparent 35%),var(--bg);color:#edf6ff;font:15px/1.65 system-ui,sans-serif}.wrap{max-width:1120px;margin:auto;padding:20px 16px 70px}a{color:#8dccff;text-decoration:none}.top,.filters,.actions{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}.top{padding-bottom:18px;border-bottom:1px solid #ffffff1c}.brand{font-weight:950;letter-spacing:.08em}.brand span{color:var(--cyan)}.btn{display:inline-flex;padding:10px 15px;border-radius:9px;background:linear-gradient(110deg,var(--blue),var(--cyan));color:#061321;font-weight:850;border:0;cursor:pointer}.alt{background:#17334d;color:#edf6ff;border:1px solid var(--line)}.muted{color:var(--muted)}.hero{padding:34px 0 22px}.hero h1{font-size:clamp(30px,5vw,44px);margin:6px 0}.search{display:flex;gap:9px;flex:1;min-width:min(100%,300px)}input{flex:1;min-width:0;background:#0c2033;border:1px solid #35516c;border-radius:9px;color:#fff;padding:12px}.filters{justify-content:flex-start;margin:16px 0}.chip{padding:9px 13px;border:1px solid #34516d;background:#10263b;color:#eaf3ff;border-radius:99px;cursor:pointer}.chip.active{background:#56afff;color:#061321}.stats{display:flex;gap:18px;flex-wrap:wrap;color:var(--muted);font-size:13px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(235px,1fr));gap:15px;margin-top:18px}.card,.detail{background:linear-gradient(150deg,#10243a,#0b1b2c);border:1px solid var(--line);border-radius:15px;padding:20px}.tag{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--cyan);font-weight:900}.card h2{font-size:20px;margin:8px 0}.card p{color:var(--muted)}.empty{padding:26px;border:1px dashed #34516d;border-radius:12px;color:var(--muted);grid-column:1/-1}.file{padding:14px;background:#091a2b;border:1px solid #34516d;border-radius:10px;margin:10px 0}.file a{display:inline-block;margin-top:7px}.detail h1{font-size:32px}.footer{margin-top:44px;padding-top:20px;border-top:1px solid #ffffff1c;color:var(--muted)}@media(max-width:600px){.search{flex-direction:column}.search .btn{width:100%}}
</style></head><body><main class="wrap"><header class="top"><a class="brand" href="/">NKJJEAN <span>STUDIO</span></a><div class="actions"><a href="/">Accueil</a><a href="/app">Mon espace</a><a href="/docs">Aide</a></div></header><section class="hero"><div class="tag">Catalogue public</div><h1 id="heading">Applications, cours et contenus</h1><p class="muted" id="description">Recherchez une ressource publiée et validée par l'administration.</p><form id="searchForm" class="search"><input id="search" type="search" placeholder="Rechercher par nom, description ou catégorie…" aria-label="Rechercher"><button class="btn">Rechercher</button></form><div class="stats" id="stats"></div></section><div class="filters" id="filters"><button class="chip active" data-type="all">Tout</button><button class="chip" data-type="application">Applications</button><button class="chip" data-type="course">Cours</button><button class="chip" data-type="content">Autres contenus</button></div><div id="results" class="grid" aria-live="polite"><div class="empty">Chargement…</div></div><footer class="footer">© NKJJEAN STUDIO · Numéro de réception prévu : 0814620569</footer></main><script>(function(){const $=id=>document.getElementById(id);let type="all",items=[];function esc(v){return String(v==null?"":v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}function norm(s){return String(s||"").toLocaleLowerCase("fr").normalize("NFD").replace(/[\u0300-\u036f]/g,"");}function render(){const q=norm($("search").value.trim()),found=items.filter(x=>(type==="all"||x.type===type)&&(!q||norm([x.title,x.description,x.category].join(" ")).includes(q)));$("results").innerHTML=found.length?found.map(x=>{const href=x.type==="application"?"/applications/":x.type==="course"?"/cours/":"/publications/";return "<article class='card'><div class='tag'>"+esc(x.type==="application"?"Application":x.type==="course"?"Cours":"Autre contenu")+" · "+esc(x.category)+"</div><h2>"+esc(x.title)+"</h2><p>"+esc((x.description||"").slice(0,210))+"</p><a class='btn alt' href='"+href+encodeURIComponent(x.slug)+"'>Consulter la fiche</a></article>";}).join(""):"<div class='empty'><h2>Aucun résultat</h2><p>Essayez un autre mot-clé ou un autre filtre.</p><a class='btn alt' href='/app'>Proposer une publication</a></div>";}async function detail(slug,section){$("filters").classList.add("hidden");$("searchForm").classList.add("hidden");const app=section==="applications",r=await fetch(app?"/api/store/apps/"+encodeURIComponent(slug):"/api/store/resources/"+encodeURIComponent(slug)),d=await r.json();if(!r.ok)throw new Error(d.error||"Fiche introuvable.");const item=app?d.app:d.resource;document.title=(item.name||item.title)+" — NKJJEAN STUDIO";const files=app?(d.releases||[]).map(x=>({...x,download_url:"/api/download/app/"+encodeURIComponent(x.id)})):(d.files||[]);$("heading").textContent=item.name||item.title;$("description").textContent=item.description||"Aucune description fournie.";$("results").className="";$("results").innerHTML="<article class='detail'><div class='tag'>"+esc(item.category)+"</div><h1>"+esc(item.name||item.title)+"</h1><p>"+esc(item.description||"Aucune description fournie.")+"</p><p class='muted'>Publié le : "+esc(item.published_at||"Non renseigné")+"</p><h2>Fichiers disponibles</h2>"+(files.length?files.map(f=>"<div class='file'><strong>"+esc(f.version_name||f.file_name)+"</strong><p class='muted'>"+esc(f.file_name||"Fichier")+" · "+(Number(f.file_size||0)/1048576).toFixed(2)+" Mo</p><a class='btn' href='"+esc(f.download_url)+"'>Télécharger</a></div>").join(""):"<p class='muted'>Aucun fichier téléchargeable n'a encore été approuvé pour cette publication.</p>")+"<div class='actions'><a class='btn alt' href='/"+(section==="cours"?"cours":section==="publications"?"publications":"applications")+"'>Retour au catalogue</a><button class='btn alt' id='copyLink'>Copier le lien</button></div></article>";$("copyLink").onclick=async()=>{try{await navigator.clipboard.writeText(location.href);$("copyLink").textContent="Lien copié";}catch(e){$("copyLink").textContent=location.href;}};}async function load(){try{const section=location.pathname.split("/").filter(Boolean)[0]||"applications",params=new URLSearchParams({limit:"100"});$("search").value=new URLSearchParams(location.search).get("q")||"";const r=await fetch("/api/store/catalog?"+params),d=await r.json();if(!r.ok)throw new Error(d.error||"Catalogue indisponible.");items=d.items||[];const c=d.counts||{};$("stats").textContent="Publications : "+(c.publications||0)+" · Applications : "+(c.applications||0)+" · Cours : "+(c.courses||0)+" · Contenus : "+(c.contents||0);if(section==="cours"){type="course";$("heading").textContent="Cours publiés";}else if(section==="publications"){type="content";$("heading").textContent="Autres contenus publiés";}else if(section==="applications"){$("heading").textContent="Applications publiées";}document.querySelectorAll("[data-type]").forEach(b=>b.classList.toggle("active",b.dataset.type===type));const parts=location.pathname.split("/").filter(Boolean);if(parts.length>1)await detail(decodeURIComponent(parts[1]),section);else render();}catch(e){$("results").innerHTML="<div class='empty'>"+esc(e.message)+"</div>";}}document.querySelectorAll("[data-type]").forEach(b=>b.onclick=()=>{type=b.dataset.type;document.querySelectorAll("[data-type]").forEach(x=>x.classList.toggle("active",x===b));render();});$("searchForm").onsubmit=e=>{e.preventDefault();render();};$("search").oninput=render;load();})();</script></body></html>`;

      return new Response(html, {
        status: 200,
        headers: {
          "Content-Type": "text/html;charset=UTF-8",
          "X-Content-Type-Options": "nosniff"
        }
      });
    }

    // ==================== AUTHENTIFICATION ====================

    if (url.pathname.startsWith("/api/auth/")) {

      if (!env.DB) {
        return jsonResponse({
          error: "La base D1 n'est pas liée à ce Worker.",
          code: "D1_BINDING_MISSING",
          required_binding: "DB",
          required_database: "nkjjean-studio-db"
        }, 503);
      }
      if (typeof env.SESSION_SECRET !== "string" || env.SESSION_SECRET.length < 32) {
        return jsonResponse({
          error: "Le secret de session n'est pas configuré correctement dans Production.",
          code: "SESSION_SECRET_MISSING",
          required_secret: "SESSION_SECRET",
          minimum_length: 32
        }, 503);
      }

      const route = url.pathname;
      const method = request.method;

      const allowedRoutes = {
        "/api/auth/register": "POST",
        "/api/auth/login": "POST",
        "/api/auth/me": "GET",
        "/api/auth/logout": "POST"
      };

      if (!Object.prototype.hasOwnProperty.call(allowedRoutes, route)) {
        return jsonResponse({
          error: "Route d'authentification introuvable."
        }, 404);
      }

      if (method !== allowedRoutes[route]) {
        return jsonResponse({
          error: "Méthode non autorisée."
        }, 405);
      }

      // ==================== INSCRIPTION ====================

      if (route === "/api/auth/register") {
        try {
          const body = await request.json();

          const email = typeof body.email === "string"
            ? body.email.trim().toLowerCase()
            : "";

          const password = typeof body.password === "string"
            ? body.password
            : "";

          if (
            email.length < 5 ||
            email.length > 254 ||
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
            password.length < 8 ||
            password.length > 128
          ) {
            return jsonResponse({
              error: "Adresse email ou mot de passe invalide."
            }, 400);
          }

          const existing = await env.DB.prepare(
            "SELECT id FROM users WHERE email = ? LIMIT 1"
          ).bind(email).first();

          if (existing) {
            return jsonResponse({
              error: "Cet email est déjà utilisé."
            }, 409);
          }

          const userId = randomHex(16);
          const encryptedPassword = await passwordHash(password);

          await env.DB.prepare(
            "INSERT INTO users (id, email, password_hash, role, status) VALUES (?, ?, ?, ?, ?)"
          ).bind(
            userId,
            email,
            encryptedPassword,
            "user",
            "active"
          ).run();

          return jsonResponse({
            success: true,
            userId
          }, 201);

        } catch (error) {
          return jsonResponse({
            error: "Impossible de créer le compte."
          }, 500);
        }
      }

      // ==================== CONNEXION ====================

      if (route === "/api/auth/login") {
        try {
          const body = await request.json();

          const email = typeof body.email === "string"
            ? body.email.trim().toLowerCase()
            : "";

          const password = typeof body.password === "string"
            ? body.password
            : "";

          if (!email || !password) {
            return jsonResponse({
              error: "Email ou mot de passe manquant."
            }, 400);
          }

          const user = await env.DB.prepare(
            "SELECT id, email, password_hash, role, status FROM users WHERE email = ? LIMIT 1"
          ).bind(email).first();

          if (!user || user.status !== "active") {
            return jsonResponse({
              error: "Identifiants invalides."
            }, 401);
          }

          const isValid = await verifyPassword(
            password,
            user.password_hash
          );

          if (!isValid) {
            return jsonResponse({
              error: "Identifiants invalides."
            }, 401);
          }

          // Migration silencieuse et sûre des anciens hachages après vérification.
          if (!user.password_hash.includes("$")) {
            const upgradedPasswordHash = await passwordHash(password);
            await env.DB.prepare(
              "UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?"
            ).bind(
              upgradedPasswordHash,
              user.id,
              user.password_hash
            ).run();
          }

          const token = randomHex(32);

          const tokenHash = await sessionTokenHash(
            token,
            env.SESSION_SECRET
          );

          const sessionId = randomHex(16);

          const expiresAt = new Date(Date.now() + SESSION_IDLE_MS).toISOString();

          await env.DB.prepare(
            "INSERT INTO user_sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)"
          ).bind(
            sessionId,
            user.id,
            tokenHash,
            expiresAt
          ).run();

          return jsonResponse({
            success: true,
            token,
            expires_at: expiresAt
          }, 200);

        } catch (error) {
          return jsonResponse({
            error: "Impossible de se connecter."
          }, 500);
        }
      }

      // ==================== VÉRIFICATION DU COMPTE ====================

      if (route === "/api/auth/me") {
        try {
          const authorization =
            request.headers.get("Authorization") || "";

          const match = authorization.match(
            /^Bearer ([a-f0-9]{64})$/i
          );

          if (!match) {
            return jsonResponse({
              error: "Jeton manquant ou invalide."
            }, 401);
          }

          const token = match[1].toLowerCase();

          const tokenHash = await sessionTokenHash(
            token,
            env.SESSION_SECRET
          );

          const session = await env.DB.prepare(
            `SELECT
              s.id AS session_id,
              s.user_id,
              s.expires_at,
              u.email,
              u.role,
              u.status
            FROM user_sessions s
            JOIN users u ON s.user_id = u.id
            WHERE s.token_hash = ?
              AND s.revoked_at IS NULL
              AND s.expires_at > ?
            LIMIT 1`
          ).bind(
            tokenHash,
            new Date().toISOString()
          ).first();

          if (!session || session.status !== "active") {
            return jsonResponse({
              error: "Jeton invalide ou expiré."
            }, 401);
          }

          const refreshedExpiry = new Date(Date.now() + SESSION_IDLE_MS).toISOString();
          await env.DB.prepare(
            "UPDATE user_sessions SET expires_at=? WHERE id=? AND revoked_at IS NULL"
          ).bind(refreshedExpiry, session.session_id).run();

          return jsonResponse({
            success: true,
            user: {
              id: session.user_id,
              email: session.email,
              role: session.role
            },
            expires_at: session.expires_at
          }, 200);

        } catch (error) {
          return jsonResponse({
            error: "Vérification impossible."
          }, 500);
        }
      }

      // ==================== DÉCONNEXION ====================

      if (route === "/api/auth/logout") {
        try {
          const authorization =
            request.headers.get("Authorization") || "";

          const match = authorization.match(
            /^Bearer ([a-f0-9]{64})$/i
          );

          if (!match) {
            return jsonResponse({
              error: "Jeton manquant ou invalide."
            }, 401);
          }

          const token = match[1].toLowerCase();

          const tokenHash = await sessionTokenHash(
            token,
            env.SESSION_SECRET
          );

          await env.DB.prepare(
            `UPDATE user_sessions
             SET revoked_at = ?
             WHERE token_hash = ?
               AND revoked_at IS NULL`
          ).bind(
            new Date().toISOString(),
            tokenHash
          ).run();

          return jsonResponse({
            success: true
          }, 200);

        } catch (error) {
          return jsonResponse({
            error: "Déconnexion impossible."
          }, 500);
        }
      }
    }

    // ==================== ROUTE INCONNUE ====================

    return jsonResponse({
      error: "Route introuvable."
    }, 404);
  }
};
