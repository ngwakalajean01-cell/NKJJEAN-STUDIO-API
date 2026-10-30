
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

const STUDIO_HOME_HTML = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="NKJJEAN STUDIO : recherchez les applications, cours et ressources numériques publiés."><meta name="robots" content="index,follow"><title>NKJJEAN STUDIO — Catalogue numérique</title><style>:root{color-scheme:dark;--bg:#07111f;--line:#284863;--muted:#a8bbce;--blue:#62b4ff;--cyan:#65e0df}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 0,#14385b 0,transparent 35%),var(--bg);color:#edf6ff;font:16px/1.65 system-ui,sans-serif}a{color:inherit;text-decoration:none}.wrap{width:min(1120px,calc(100% - 32px));margin:auto}.top{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:20px 0;border-bottom:1px solid #ffffff1c}.brand{font-weight:950;letter-spacing:.08em}.brand span{color:var(--cyan)}nav{display:flex;gap:18px;flex-wrap:wrap;color:#c1d4e7;font-size:14px}.btn{display:inline-flex;justify-content:center;align-items:center;padding:11px 17px;border-radius:10px;background:linear-gradient(110deg,var(--blue),var(--cyan));color:#061321;font-weight:850;border:0;cursor:pointer}.alt{background:#142d45;color:#eaf3ff;border:1px solid var(--line)}.hero{text-align:center;padding:58px 0 26px}.eyebrow{color:var(--cyan);font-size:12px;font-weight:900;letter-spacing:.17em;text-transform:uppercase}.hero h1{font-size:clamp(34px,6vw,62px);line-height:1.08;margin:12px 0}.hero p{color:var(--muted);max-width:720px;margin:0 auto 24px}.searchbox{display:flex;gap:10px;max-width:780px;margin:26px auto 0;padding:9px;background:#0c2033;border:1px solid #3b6687;border-radius:16px}.searchbox input{flex:1;min-width:0;background:transparent;border:0;outline:0;color:white;padding:12px;font-size:16px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:22px 0 42px}.stat,.card,.panel{background:linear-gradient(150deg,#10243a,#0b1b2c);border:1px solid var(--line);border-radius:15px;padding:18px}.stat strong{display:block;font-size:28px;color:var(--cyan)}.stat span{color:var(--muted);font-size:13px}.section{padding:22px 0 42px}.section h2{margin:5px 0;font-size:28px}.muted{color:var(--muted)}.quick{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.card h3{margin:8px 0}.card p{color:var(--muted);margin:0 0 14px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(235px,1fr));gap:14px;margin-top:18px}.tag{color:var(--cyan);font-size:12px;font-weight:800;text-transform:uppercase}.foot{border-top:1px solid #ffffff1c;padding:25px 0;color:var(--muted);font-size:13px;display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap}@media(max-width:700px){nav{gap:12px}.stats{grid-template-columns:repeat(2,1fr)}.quick{grid-template-columns:1fr}.searchbox{flex-direction:column}.searchbox .btn{width:100%}}</style></head><body><div class="wrap"><header class="top"><a class="brand" href="/">NKJJEAN<span> STUDIO</span></a><nav><a href="/applications">Applications</a><a href="/cours">Cours</a><a href="/publications">Autres contenus</a><a href="/docs">Aide</a><a class="btn alt" href="/app">Mon espace</a></nav></header><main><section class="hero"><div class="eyebrow">Votre bibliothèque numérique</div><h1>Trouvez ce dont vous avez besoin.</h1><p>Recherchez des applications, des cours et des ressources numériques publiés et validés par NKJJEAN STUDIO.</p><form class="searchbox" id="homeSearch"><input id="homeQuery" type="search" placeholder="Rechercher une application, un cours ou un contenu…" aria-label="Rechercher dans le catalogue"><button class="btn">Rechercher</button></form></section><section class="stats"><div class="stat"><strong id="countAll">—</strong><span>Publications disponibles</span></div><div class="stat"><strong id="countApps">—</strong><span>Applications</span></div><div class="stat"><strong id="countCourses">—</strong><span>Cours</span></div><div class="stat"><strong id="countContents">—</strong><span>Autres contenus</span></div></section><section class="section"><div class="eyebrow">Explorer</div><h2>Accès rapides</h2><div class="quick"><a class="card" href="/applications"><div class="tag">Logiciels et outils</div><h3>Applications</h3><p>Découvrez les applications publiées et leurs versions disponibles.</p><span class="btn alt">Voir les applications</span></a><a class="card" href="/cours"><div class="tag">Apprendre</div><h3>Cours</h3><p>Retrouvez les cours et supports pédagogiques validés.</p><span class="btn alt">Voir les cours</span></a><a class="card" href="/publications"><div class="tag">Ressources</div><h3>Autres contenus</h3><p>Consultez les documents et autres ressources numériques.</p><span class="btn alt">Voir les contenus</span></a></div></section><section class="section"><div class="eyebrow">Mise à jour régulièrement</div><h2>Dernières publications</h2><div id="latest" class="grid"><div class="panel muted">Chargement…</div></div></section><section class="panel"><h2>Vous souhaitez proposer une application ou un cours ?</h2><p class="muted">Créez votre compte, déposez votre fiche et suivez la validation administrative. Rien n'est rendu public avant approbation.</p><a class="btn" href="/app">Proposer une publication</a></section></main><footer class="foot"><span>© NKJJEAN STUDIO</span><span>Paiement prévu : 0814620569 · <a href="mailto:ngwakalajean01@gmail.com">Contact</a></span></footer></div><script>(function(){function esc(v){return String(v==null?"":v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}async function load(){try{const r=await fetch("/api/store/catalog?limit=8"),d=await r.json();if(!r.ok)throw new Error();const c=d.counts||{};document.getElementById("countAll").textContent=c.publications||0;document.getElementById("countApps").textContent=c.applications||0;document.getElementById("countCourses").textContent=c.courses||0;document.getElementById("countContents").textContent=c.contents||0;document.getElementById("latest").innerHTML=(d.items||[]).map(x=>"<article class='card'><div class='tag'>"+esc(x.type)+" · "+esc(x.category)+"</div><h3>"+esc(x.title)+"</h3><p>"+esc((x.description||"").slice(0,150))+"</p><a class='btn alt' href='"+(x.type==="application"?"/applications/":x.type==="course"?"/cours/":"/publications/")+encodeURIComponent(x.slug)+"'>Consulter</a></article>").join("")||"<div class='panel muted'>Aucune publication publique pour le moment.</div>";}catch(e){document.getElementById("latest").textContent="Le catalogue sera disponible dès que la base sera configurée.";}}document.getElementById("homeSearch").onsubmit=e=>{e.preventDefault();location.href="/applications?q="+encodeURIComponent(document.getElementById("homeQuery").value.trim());};load();})();</script></body></html>`;

const STUDIO_DOCS_HTML = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>En savoir plus — NKJJEAN STUDIO</title><style>body{margin:0;background:#07111f;color:#e8f1fb;font:16px/1.7 system-ui,sans-serif}.wrap{max-width:900px;margin:auto;padding:30px 22px 70px}a{color:#70c2ff}h1{font-size:40px}h2{margin-top:34px;color:#8fd5ff}.panel{background:#0e2033;border:1px solid #25435f;border-radius:15px;padding:22px;margin:16px 0;color:#b8c9dc}</style></head><body><main class="wrap"><a href="/">← Retour à l’accueil</a><h1>Comprendre NKJJEAN STUDIO</h1><p>Votre environnement numérique pour créer et gérer des projets, des clés API, des quotas et la publication contrôlée d’applications.</p><h2>Comptes et sécurité</h2><div class="panel">Chaque compte possède ses projets. Les mots de passe sont protégés par PBKDF2-SHA-256 et les sessions par des jetons HMAC. Ne partagez jamais votre jeton ni vos clés API.</div><h2>Projets et API</h2><div class="panel">Chaque projet possède ses informations, ses quotas et ses clés API. Une clé complète ne s’affiche qu’une seule fois lors de sa création. Une clé peut être révoquée.</div><h2>IA propriétaire</h2><div class="panel">Le modèle propre à NKJJEAN STUDIO n’est pas encore entraîné ni hébergé. Aucun service Gemini, OpenAI ou autre fournisseur externe n’est appelé. Le modèle nécessitera une infrastructure de calcul et un entraînement dédiés.</div><h2>Publication</h2><div class="panel">Les applications ne deviennent publiques qu’après validation administrative. Le stockage privé des APK et la confirmation automatique des paiements ne sont pas activés dans cette version.</div><h2>Paiements et contact</h2><div class="panel">Numéro de réception prévu : <strong>0814620569</strong>. Son enregistrement ne confirme aucun transfert. Une confirmation réelle nécessite une connexion vérifiée à un opérateur mobile-money.<br>WhatsApp : <a href="https://wa.me/243992049808">0992049808</a><br>Email : <a href="mailto:ngwakalajean01@gmail.com">ngwakalajean01@gmail.com</a></div><p><a href="/app">Ouvrir mon espace</a> · <a href="/applications">Catalogue public</a></p></main></body></html>`

const STUDIO_APP_HTML = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Mon espace — NKJJEAN STUDIO</title><style>:root{color-scheme:dark;--line:#284863;--muted:#a8bbce;--blue:#62b4ff;--cyan:#65e0df}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 85% 0,#14385b 0,transparent 35%),#07111f;color:#edf6ff;font:15px/1.6 system-ui,sans-serif}.wrap{max-width:1120px;margin:auto;padding:22px 16px 65px}a{color:#8dccff}.top,.row,.actions{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}.top{padding-bottom:18px;border-bottom:1px solid #ffffff1c}.brand{font-weight:950;letter-spacing:.08em}.brand span{color:var(--cyan)}.panel,.project{background:linear-gradient(150deg,#10243a,#0b1b2c);border:1px solid var(--line);border-radius:15px;padding:20px;margin:16px 0}.muted{color:var(--muted)}.field{display:block;max-width:620px;margin:12px 0}.field input,.field textarea,.field select{display:block;width:100%;margin-top:6px;padding:12px;border:1px solid #34516d;border-radius:9px;background:#071726;color:#fff}.field textarea{min-height:100px}.btn{border:0;border-radius:9px;background:linear-gradient(110deg,var(--blue),var(--cyan));color:#061321;font-weight:850;padding:11px 16px;cursor:pointer;text-decoration:none;display:inline-flex}.secondary{background:#17334d;color:#edf6ff;border:1px solid var(--line)}.danger{background:#713340;color:#fff}.hidden{display:none!important}.token{background:#06101b;border:1px dashed #65d9c2;padding:12px;overflow-wrap:anywhere;color:#9fe8d2}.project{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px}.project h3{margin:0 0 5px}.project p{margin:0;color:var(--muted)}.tabs{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0}.tabs a{padding:9px 13px;background:#10263b;border:1px solid #34516d;border-radius:9px;text-decoration:none}.status{color:var(--cyan);font-weight:800}.sectionTitle{margin-bottom:5px}.notice{padding:12px;background:#0a1b2b;border-left:3px solid var(--cyan);border-radius:8px}@media(max-width:600px){.wrap{padding:14px 12px 45px}}</style></head><body><main class="wrap"><header class="top"><a class="brand" href="/">NKJJEAN <span>STUDIO</span></a><nav class="row"><a href="/">Accueil</a><a href="/applications">Applications</a><a href="/cours">Cours</a><a href="/publications">Contenus</a><a href="/docs">Aide</a><a id="adminLink" class="hidden" href="/admin">Administration</a></nav></header><section id="auth" class="panel"><h1>Votre espace personnel</h1><p class="muted">Connectez-vous ou créez votre compte.</p><div class="row"><button class="btn" id="showLogin">Connexion</button><button class="btn secondary" id="showRegister">Créer un compte</button></div><form id="loginForm"><h2>Connexion</h2><label class="field">Adresse email<input name="email" type="email" autocomplete="email" required></label><label class="field">Mot de passe<input name="password" type="password" autocomplete="current-password" required></label><button class="btn">Se connecter</button></form><form id="registerForm" class="hidden"><h2>Créer un compte</h2><label class="field">Adresse email<input name="email" type="email" required></label><label class="field">Mot de passe (8 caractères minimum)<input name="password" type="password" minlength="8" required></label><button class="btn">Créer mon compte</button></form><p id="authMessage" class="muted" aria-live="polite"></p></section><section id="dashboard" class="hidden"><section class="panel row"><div><div class="muted">Compte connecté</div><strong id="userEmail"></strong></div><button class="btn secondary" id="logout">Déconnexion</button></section><nav class="tabs"><a href="#projectsSection">Mes projets</a><a href="#appsSection">Mes applications</a><a href="#resourcesSection">Mes cours et contenus</a></nav><section id="projectsSection" class="panel"><h2>Créer un projet</h2><form id="projectForm"><label class="field">Nom du projet<input name="name" maxlength="100" required></label><label class="field">Description<textarea name="description" maxlength="2000"></textarea></label><button class="btn">Créer le projet</button></form><p class="muted">Quotas gratuits initiaux : 1 000 requêtes, 100 000 jetons, 100 requêtes quotidiennes et 1 000 mensuelles par projet.</p><h3>Mes projets</h3><div id="projects" class="muted">Chargement…</div><div id="keyNotice" class="panel hidden"></div></section><section id="appsSection" class="panel"><div class="eyebrow">Publication d'applications</div><h2>Proposer une application Android</h2><p class="muted">Créez la fiche, ajoutez le fichier APK, puis soumettez l'ensemble. L'application sera publique uniquement après validation administrative.</p><form id="appForm"><label class="field">Nom de l’application<input name="name" required maxlength="120"></label><label class="field">Catégorie<input name="category" value="Autres" maxlength="80"></label><label class="field">Description<textarea name="description" maxlength="5000"></textarea></label><button class="btn">Créer la fiche d'application</button></form><div id="myApps"></div></section><section id="resourcesSection" class="panel"><div class="eyebrow">Cours et autres publications</div><h2>Proposer un cours ou un contenu</h2><form id="resourceForm"><label class="field">Type de publication<select name="type"><option value="course">Cours</option><option value="content">Autre contenu</option></select></label><label class="field">Titre<input name="title" required maxlength="140"></label><label class="field">Catégorie<input name="category" value="Autres" maxlength="100"></label><label class="field">Description<textarea name="description" maxlength="8000"></textarea></label><button class="btn">Créer la fiche</button></form><div id="myResources"></div></section></section></main><script>(function(){const auth=document.getElementById("auth"),dash=document.getElementById("dashboard"),msg=document.getElementById("authMessage"),projects=document.getElementById("projects");let token=localStorage.getItem("nkj_session")||sessionStorage.getItem("nkj_session")||"";if(token)localStorage.setItem("nkj_session",token);function esc(v){return String(v==null?"":v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}async function api(path,opt){opt=opt||{};opt.headers=opt.headers||{};if(!(opt.body instanceof FormData))opt.headers["Content-Type"]=opt.headers["Content-Type"]||"application/json";if(token)opt.headers.Authorization="Bearer "+token;const r=await fetch(path,opt);let d={};try{d=await r.json();}catch(e){}if(!r.ok)throw new Error((d.error||"La demande a échoué.")+" (HTTP "+r.status+")");return d;}document.getElementById("showLogin").onclick=()=>{document.getElementById("loginForm").classList.remove("hidden");document.getElementById("registerForm").classList.add("hidden");};document.getElementById("showRegister").onclick=()=>{document.getElementById("registerForm").classList.remove("hidden");document.getElementById("loginForm").classList.add("hidden");};document.getElementById("registerForm").onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target),credentials={email:f.get("email"),password:f.get("password")};try{await api("/api/auth/register",{method:"POST",body:JSON.stringify(credentials)});const s=await api("/api/auth/login",{method:"POST",body:JSON.stringify(credentials)});token=s.token;localStorage.setItem("nkj_session",token);e.target.reset();await loadDashboard();}catch(x){msg.textContent=x.message;}};document.getElementById("loginForm").onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);try{const d=await api("/api/auth/login",{method:"POST",body:JSON.stringify({email:f.get("email"),password:f.get("password")})});token=d.token;localStorage.setItem("nkj_session",token);await loadDashboard();}catch(x){msg.textContent=x.message;}};document.getElementById("logout").onclick=async()=>{try{await api("/api/auth/logout",{method:"POST",body:"{}"});}catch(x){}token="";localStorage.removeItem("nkj_session");auth.classList.remove("hidden");dash.classList.add("hidden");msg.textContent="Vous êtes déconnecté.";};document.getElementById("projectForm").onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);try{await api("/api/projects",{method:"POST",body:JSON.stringify({name:f.get("name"),description:f.get("description")})});e.target.reset();await loadProjects();}catch(x){alert(x.message);}};document.getElementById("appForm").onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);try{await api("/api/publisher",{method:"POST",body:JSON.stringify({name:f.get("name"),category:f.get("category"),description:f.get("description")})});e.target.reset();await loadApps();}catch(x){alert(x.message);}};document.getElementById("resourceForm").onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);try{await api("/api/resources",{method:"POST",body:JSON.stringify({type:f.get("type"),title:f.get("title"),category:f.get("category"),description:f.get("description")})});e.target.reset();await loadResources();}catch(x){alert(x.message);}};async function loadProjects(){const d=await api("/api/projects");if(!d.projects.length){projects.textContent="Aucun projet. Créez votre premier projet ci-dessus.";return;}projects.innerHTML=d.projects.map(p=>"<article class='project'><div><h3>"+esc(p.name)+"</h3><p>"+esc(p.description||"Sans description")+"</p><p>Demandes : "+esc(p.quotas.requests_limit)+" · Jetons : "+esc(p.quotas.tokens_limit)+"</p></div><div class='row'><a class='btn' href='/studio/"+encodeURIComponent(p.id)+"'>Ouvrir le Studio</a></div></article>").join("");}async function loadApps(){const d=await api("/api/publisher"),area=document.getElementById("myApps"),statuses={draft:"Brouillon",pending_review:"En attente",published:"Publiée",rejected:"Refusée",suspended:"Suspendue"};area.innerHTML=(d.apps||[]).map(a=>{const link="/applications/"+encodeURIComponent(a.slug);let controls="";if(["draft","rejected"].includes(a.status))controls="<form class='releaseForm' data-release='"+esc(a.id)+"'><label class='field'>Fichier APK<input type='file' name='file' accept='.apk,application/vnd.android.package-archive' required></label><label class='field'>Version<input name='version_name' placeholder='1.0.0' required></label><label class='field'>Code de version<input name='version_code' type='number' min='1' required></label><label class='field'>Notes de version<textarea name='changelog'></textarea></label><button class='btn secondary'>Envoyer APK pour contrôle</button></form><button class='btn' data-submit-app='"+esc(a.id)+"'>Soumettre la fiche à l'administration</button>";if(a.status==="published")controls="<a class='btn' target='_blank' href='"+link+"'>Voir la page publique</a>";return "<article class='project'><div><strong>"+esc(a.name)+"</strong><p>"+esc(a.category)+" · "+esc(statuses[a.status]||a.status)+"</p><p>"+esc(a.description||"")+"</p>"+(a.rejection_reason?"<p>Motif : "+esc(a.rejection_reason)+"</p>":"")+"</div><div class='row'>"+controls+"</div></article>";}).join("")||"<p class='muted'>Aucune application proposée.</p>";area.querySelectorAll("[data-release]").forEach(form=>form.onsubmit=async e=>{e.preventDefault();const data=new FormData(form);try{await api("/api/publisher/"+encodeURIComponent(form.dataset.release)+"/releases",{method:"POST",body:data});alert("APK transmis pour contrôle.");await loadApps();}catch(x){alert(x.message);}});area.querySelectorAll("[data-submit-app]").forEach(btn=>btn.onclick=async()=>{if(!confirm("Soumettre cette fiche à l'administration ?"))return;try{await api("/api/publisher/"+encodeURIComponent(btn.dataset.submitApp)+"/submit",{method:"POST",body:"{}"});await loadApps();}catch(x){alert(x.message);}});}async function loadResources(){const d=await api("/api/resources"),area=document.getElementById("myResources"),statuses={draft:"Brouillon",pending_review:"En attente",published:"Publiée",rejected:"Refusée",suspended:"Suspendue"};area.innerHTML=(d.resources||[]).map(x=>{const href=(x.type==="course"?"/cours/":"/publications/")+encodeURIComponent(x.slug);let controls="";if(["draft","rejected"].includes(x.status))controls="<form class='resourceFileForm' data-file='"+esc(x.id)+"'><label class='field'>Fichier facultatif (PDF, DOCX, PPTX, ZIP, MP4, JPEG, PNG)<input type='file' name='file'></label><button class='btn secondary'>Ajouter un fichier</button></form><button class='btn' data-submit-resource='"+esc(x.id)+"'>Soumettre pour publication</button>";if(x.status==="published")controls="<a class='btn' target='_blank' href='"+href+"'>Voir la page publique</a>";return "<article class='project'><div><strong>"+esc(x.title)+"</strong><p>"+esc(x.type==="course"?"Cours":"Autre contenu")+" · "+esc(x.category)+" · "+esc(statuses[x.status]||x.status)+"</p><p>"+esc(x.description||"")+"</p>"+(x.rejection_reason?"<p>Motif : "+esc(x.rejection_reason)+"</p>":"")+"</div><div class='row'>"+controls+"</div></article>";}).join("")||"<p class='muted'>Aucun cours ou contenu proposé.</p>";area.querySelectorAll("[data-file]").forEach(form=>form.onsubmit=async e=>{e.preventDefault();const data=new FormData(form);if(!data.get("file")||!data.get("file").size){alert("Choisissez un fichier.");return;}try{await api("/api/resources/"+encodeURIComponent(form.dataset.file)+"/files",{method:"POST",body:data});alert("Fichier envoyé pour contrôle.");await loadResources();}catch(x){alert(x.message);}});area.querySelectorAll("[data-submit-resource]").forEach(btn=>btn.onclick=async()=>{if(!confirm("Soumettre ce cours ou contenu à l'administration ?"))return;try{await api("/api/resources/"+encodeURIComponent(btn.dataset.submitResource)+"/submit",{method:"POST",body:"{}"});await loadResources();}catch(x){alert(x.message);}});}async function loadDashboard(){let account;try{account=await api("/api/auth/me");}catch(x){if(x.message.includes("(HTTP 401)")){token="";localStorage.removeItem("nkj_session");auth.classList.remove("hidden");dash.classList.add("hidden");msg.textContent=x.message;}else{auth.classList.remove("hidden");dash.classList.add("hidden");msg.textContent="Vérification de session impossible : "+x.message;}return;}document.getElementById("userEmail").textContent=account.user.email;if(account.user.role==="admin")document.getElementById("adminLink").classList.remove("hidden");auth.classList.add("hidden");dash.classList.remove("hidden");msg.textContent="Connexion réussie.";try{await loadProjects();}catch(x){projects.textContent=x.message;}try{await loadApps();}catch(x){document.getElementById("myApps").textContent=x.message;}try{await loadResources();}catch(x){document.getElementById("myResources").textContent=x.message;}}if(token)loadDashboard();})();</script></body></html>`;
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

const STUDIO_HOME_HTML = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="NKJJEAN STUDIO : projets, API et applications."><title>NKJJEAN STUDIO</title><style>:root{color-scheme:dark;--line:#203c57;--text:#e8f1fb;--muted:#9db1c8;--blue:#58aaff;--cyan:#65e0df}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 5%,#12365a 0,transparent 34%),linear-gradient(145deg,#06101c,#071629 65%,#08111f);color:var(--text);font:16px/1.65 system-ui,sans-serif}a{color:inherit;text-decoration:none}.wrap{width:min(1120px,calc(100% - 36px));margin:auto}.top{display:flex;align-items:center;justify-content:space-between;padding:22px 0;border-bottom:1px solid #ffffff16}.brand{font-weight:900;letter-spacing:.08em}.brand span{color:var(--cyan)}nav{display:flex;gap:20px;align-items:center;color:var(--muted);font-size:14px}.btn{display:inline-flex;align-items:center;justify-content:center;padding:11px 18px;border-radius:10px;font-weight:800;background:linear-gradient(110deg,var(--blue),var(--cyan));color:#061321}.alt{background:#142a40;color:var(--text);border:1px solid var(--line)}.hero{padding:76px 0 60px;display:grid;grid-template-columns:1.15fr .85fr;gap:40px;align-items:center}.eyebrow{color:var(--cyan);font-size:12px;font-weight:800;letter-spacing:.19em;text-transform:uppercase}.hero h1{font-size:clamp(42px,6vw,70px);line-height:1.04;margin:16px 0 20px;letter-spacing:-.045em}.hero h1 b{color:var(--blue)}.lead{font-size:19px;color:var(--muted)}.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:28px}.visual{min-height:310px;border:1px solid #4c85bb55;border-radius:26px;padding:24px;background:linear-gradient(145deg,#133353aa,#0b1d30dd);box-shadow:0 24px 80px #0006;position:relative;overflow:hidden}.visual:before,.visual:after{content:"";position:absolute;border:1px solid #55a8ff44;border-radius:50%;width:250px;height:250px;right:-70px;top:-75px}.visual:after{width:170px;height:170px;right:70px;top:125px;border-color:#65e0df55}.codebox{position:relative;z-index:1;margin-top:22px;background:#06111fdd;border:1px solid #345372;border-radius:14px;padding:18px;color:#c7e6ff;font:13px/2 ui-monospace,monospace}.green{color:#7de2c2}.blue{color:#73baff}.section{padding:46px 0}.section h2{font-size:clamp(28px,4vw,40px);line-height:1.15;margin:8px 0 14px}.sub{color:var(--muted);max-width:760px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:25px}.card{padding:23px;border:1px solid var(--line);background:linear-gradient(150deg,#10243a,#0b1929);border-radius:17px}.symbol{width:42px;height:42px;display:grid;place-items:center;border-radius:12px;background:#173b5d;color:var(--cyan);font-size:20px}.card h3{margin:14px 0 7px}.card p{color:var(--muted);margin:0}.strip{border:1px solid #315474;background:#0b1d2e;border-radius:20px;padding:27px;display:flex;align-items:center;justify-content:space-between;gap:18px}.steps{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:20px}.step{border-top:2px solid var(--blue);padding:15px 12px;background:#0c1b2b;color:var(--muted)}.step strong{display:block;color:#fff}.foot{border-top:1px solid #ffffff18;margin-top:48px;padding:27px 0;color:var(--muted);font-size:13px;display:flex;flex-wrap:wrap;justify-content:space-between;gap:18px}.foot a{color:#b9d9f6}@media(max-width:780px){nav{gap:12px}nav a:not(.navbtn){display:none}.hero{grid-template-columns:1fr;padding:50px 0 30px}.grid{grid-template-columns:1fr}.steps{grid-template-columns:1fr 1fr}.strip{align-items:flex-start;flex-direction:column}}</style></head><body><div class="wrap"><header class="top"><a class="brand" href="/">NKJJEAN<span> STUDIO</span></a><nav><a href="/docs">En savoir plus</a><a href="/applications">Applications</a><a href="#contact">Contact</a><a class="navbtn btn alt" href="/app">Mon espace</a></nav></header><main><section class="hero"><div><div class="eyebrow">Studio numérique indépendant</div><h1>Vos projets.<br><b>Vos API.</b><br>Vos applications.</h1><p class="lead">Une plateforme pour organiser vos projets numériques, gérer leurs accès API, suivre leur utilisation et préparer la publication de vos applications Android.</p><div class="actions"><a class="btn" href="/app">Créer mon espace</a><a class="btn alt" href="/docs">En savoir plus</a></div></div><div class="visual"><div class="eyebrow">Votre environnement de travail</div><div class="codebox"><span class="green">PROJET</span> / application-mobile<br><span class="blue">API</span> — clé privée par projet<br><span class="blue">QUOTAS</span> — suivi et historique<br><span class="blue">PUBLICATION</span> — validation administrative<br><br><span class="green">✓</span> Données séparées par propriétaire<br><span class="green">✓</span> Accès sécurisés par session</div></div></section><section class="section"><div class="eyebrow">Un environnement organisé</div><h2>Tout commence dans votre espace personnel.</h2><p class="sub">Créez des projets distincts, gérez leurs informations et délivrez des clés API séparées. Chaque compte ne voit que ses propres projets et son historique.</p><div class="grid"><article class="card"><div class="symbol">⌘</div><h3>Gestion des projets</h3><p>Créez, consultez, modifiez et archivez vos projets dans un espace personnel.</p></article><article class="card"><div class="symbol">⌘</div><h3>Clés API privées</h3><p>Une clé par projet, affichée une seule fois à sa création et révocable à tout moment.</p></article><article class="card"><div class="symbol">◷</div><h3>Quotas et activité</h3><p>Suivez les limites d’utilisation et l’historique des requêtes enregistrées.</p></article><article class="card"><div class="symbol">▤</div><h3>Publication d’applications</h3><p>Préparez une fiche, soumettez-la au contrôle et suivez la décision administrative.</p></article><article class="card"><div class="symbol">⬡</div><h3>Catalogue public</h3><p>Les applications approuvées apparaissent avec leurs informations et versions autorisées.</p></article><article class="card"><div class="symbol">✧</div><h3>IA propriétaire NKJJEAN</h3><p>Le modèle devra être entraîné et hébergé sur une infrastructure dédiée avant de générer des réponses. Aucune IA externe n’est utilisée.</p></article></div></section><section class="section"><div class="strip"><div><div class="eyebrow">Parcours de publication</div><h2>Une publication contrôlée.</h2><p class="sub">Fiche, version, confirmation du paiement et validation administrative : une application n’est publique qu’après les contrôles requis.</p></div><a class="btn" href="/applications">Voir les applications</a></div><div class="steps"><div class="step"><strong>1. Préparer</strong>Créer la fiche et ses informations.</div><div class="step"><strong>2. Déposer</strong>Ajouter un APK lorsque le stockage sécurisé sera activé.</div><div class="step"><strong>3. Vérifier</strong>Contrôler les frais et les éléments soumis.</div><div class="step"><strong>4. Décider</strong>Validation ou refus par l’administration.</div></div></section><section class="section"><div class="strip"><div><div class="eyebrow">Démarrer maintenant</div><h2>Créez votre compte NKJJEAN STUDIO.</h2><p class="sub">Les projets commencent avec les quotas gratuits initiaux. Les services payants ne seront activés qu’après leur configuration réelle.</p></div><a class="btn" href="/app">Ouvrir mon espace</a></div></section></main><footer id="contact" class="foot"><div>© NKJJEAN STUDIO — Plateforme numérique.</div><div><a href="https://wa.me/243992049808">WhatsApp</a> · <a href="tel:+243992049808">Téléphone</a> · <a href="mailto:ngwakalajean01@gmail.com">Gmail</a></div></footer></div></body></html>`

const STUDIO_DOCS_HTML = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>En savoir plus — NKJJEAN STUDIO</title><style>body{margin:0;background:#07111f;color:#e8f1fb;font:16px/1.7 system-ui,sans-serif}.wrap{max-width:900px;margin:auto;padding:30px 22px 70px}a{color:#70c2ff}h1{font-size:40px}h2{margin-top:34px;color:#8fd5ff}.panel{background:#0e2033;border:1px solid #25435f;border-radius:15px;padding:22px;margin:16px 0;color:#b8c9dc}</style></head><body><main class="wrap"><a href="/">← Retour à l’accueil</a><h1>Comprendre NKJJEAN STUDIO</h1><p>Votre environnement numérique pour créer et gérer des projets, des clés API, des quotas et la publication contrôlée d’applications.</p><h2>Comptes et sécurité</h2><div class="panel">Chaque compte possède ses projets. Les mots de passe sont protégés par PBKDF2-SHA-256 et les sessions par des jetons HMAC. Ne partagez jamais votre jeton ni vos clés API.</div><h2>Projets et API</h2><div class="panel">Chaque projet possède ses informations, ses quotas et ses clés API. Une clé complète ne s’affiche qu’une seule fois lors de sa création. Une clé peut être révoquée.</div><h2>IA propriétaire</h2><div class="panel">Le modèle propre à NKJJEAN STUDIO n’est pas encore entraîné ni hébergé. Aucun service Gemini, OpenAI ou autre fournisseur externe n’est appelé. Le modèle nécessitera une infrastructure de calcul et un entraînement dédiés.</div><h2>Publication</h2><div class="panel">Les applications ne deviennent publiques qu’après validation administrative. Le stockage privé des APK et la confirmation automatique des paiements ne sont pas activés dans cette version.</div><h2>Paiements et contact</h2><div class="panel">Numéro de réception prévu : <strong>0814620569</strong>. Son enregistrement ne confirme aucun transfert. Une confirmation réelle nécessite une connexion vérifiée à un opérateur mobile-money.<br>WhatsApp : <a href="https://wa.me/243992049808">0992049808</a><br>Email : <a href="mailto:ngwakalajean01@gmail.com">ngwakalajean01@gmail.com</a></div><p><a href="/app">Ouvrir mon espace</a> · <a href="/applications">Catalogue public</a></p></main></body></html>`

const STUDIO_APP_HTML = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mon espace — NKJJEAN STUDIO</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#07111f;color:#eaf3ff;font:15px/1.6 system-ui,sans-serif}.wrap{max-width:1000px;margin:auto;padding:24px 18px 70px}a{color:#85caff}.panel,.project{background:#0e2033;border:1px solid #25435f;border-radius:15px;padding:20px;margin:16px 0}.muted{color:#9db1c8}.row{display:flex;gap:10px;flex-wrap:wrap}.field{display:block;width:100%;max-width:460px;margin:10px 0}.field input,.field textarea{width:100%;padding:12px;border:1px solid #34516d;border-radius:9px;background:#071726;color:#fff}.btn{border:0;border-radius:9px;background:#56afff;color:#061321;font-weight:800;padding:11px 16px;cursor:pointer}.secondary{background:#1b3854;color:#eaf3ff;border:1px solid #34516d}.danger{background:#602d38;color:white}.hidden{display:none}.token{background:#06101b;border:1px dashed #65d9c2;padding:12px;overflow-wrap:anywhere;color:#9fe8d2}.project{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px}.project h3{margin:0 0 5px}.project p{margin:0;color:#a9bdd2}</style></head><body><main class="wrap"><header class="row" style="justify-content:space-between"><strong>NKJJEAN STUDIO</strong><span><a href="/">Accueil</a> · <a href="/applications">Applications</a> · <a href="/docs">Aide</a></span></header><section id="auth" class="panel"><h1>Votre espace personnel</h1><p class="muted">Connectez-vous ou créez votre compte.</p><div class="row"><button class="btn" id="showLogin">Connexion</button><button class="btn secondary" id="showRegister">Créer un compte</button></div><form id="loginForm"><h2>Connexion</h2><label class="field">Adresse email<input name="email" type="email" autocomplete="email" required></label><label class="field">Mot de passe<input name="password" type="password" autocomplete="current-password" required></label><button class="btn">Se connecter</button></form><form id="registerForm" class="hidden"><h2>Créer un compte</h2><label class="field">Adresse email<input name="email" type="email" required></label><label class="field">Mot de passe (8 caractères minimum)<input name="password" type="password" minlength="8" required></label><button class="btn">Créer mon compte</button></form><p id="authMessage" class="muted" aria-live="polite"></p></section><section id="dashboard" class="hidden"><div class="panel row" style="justify-content:space-between"><div><div class="muted">Compte connecté</div><strong id="userEmail"></strong></div><button class="btn secondary" id="logout">Déconnexion</button></div><div class="panel"><h2>Créer un projet</h2><form id="projectForm"><label class="field">Nom du projet<input name="name" maxlength="100" required></label><label class="field">Description<textarea name="description" maxlength="2000"></textarea></label><button class="btn">Créer le projet</button></form><p class="muted">Quotas gratuits initiaux : 1 000 requêtes, 100 000 jetons, 100 requêtes quotidiennes et 1 000 mensuelles par projet.</p></div><div class="panel"><h2>Mes projets</h2><div id="projects" class="muted">Chargement…</div></div><div id="keyNotice" class="panel hidden"></div><div class="panel"><h2>Publication de mes applications</h2><p class="muted">Les fiches peuvent être préparées. Le dépôt APK attend un stockage privé adapté. Le paiement attend une intégration mobile-money vérifiée.</p><form id="appForm"><label class="field">Nom de l’application<input name="name" required maxlength="120"></label><label class="field">Catégorie<input name="category" value="Autres" maxlength="80"></label><label class="field">Description<textarea name="description" maxlength="5000"></textarea></label><button class="btn">Créer la fiche</button></form><div id="myApps"></div></div></section></main><script>(function(){const auth=document.getElementById("auth"),dash=document.getElementById("dashboard"),msg=document.getElementById("authMessage"),projects=document.getElementById("projects");let token=localStorage.getItem("nkj_session")||sessionStorage.getItem("nkj_session")||"";if(token)localStorage.setItem("nkj_session",token);function esc(v){return String(v==null?"":v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}async function api(path,opt){opt=opt||{};opt.headers=opt.headers||{};opt.headers["Content-Type"]=opt.headers["Content-Type"]||"application/json";if(token)opt.headers.Authorization="Bearer "+token;const r=await fetch(path,opt);let d={};try{d=await r.json();}catch(e){}if(!r.ok)throw new Error((d.error||"La demande a échoué.")+" (HTTP "+r.status+")");return d;}document.getElementById("showLogin").onclick=()=>{document.getElementById("loginForm").classList.remove("hidden");document.getElementById("registerForm").classList.add("hidden");};document.getElementById("showRegister").onclick=()=>{document.getElementById("registerForm").classList.remove("hidden");document.getElementById("loginForm").classList.add("hidden");};document.getElementById("registerForm").onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target),credentials={email:f.get("email"),password:f.get("password")};try{await api("/api/auth/register",{method:"POST",body:JSON.stringify(credentials)});const s=await api("/api/auth/login",{method:"POST",body:JSON.stringify(credentials)});token=s.token;localStorage.setItem("nkj_session",token);e.target.reset();msg.textContent="Compte créé. Connexion en cours…";await loadDashboard();}catch(x){msg.textContent=x.message;}};document.getElementById("loginForm").onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);try{const d=await api("/api/auth/login",{method:"POST",body:JSON.stringify({email:f.get("email"),password:f.get("password")})});token=d.token;localStorage.setItem("nkj_session",token);await loadDashboard();}catch(x){msg.textContent=x.message;}};document.getElementById("logout").onclick=async()=>{try{await api("/api/auth/logout",{method:"POST",body:"{}"});}catch(x){}token="";localStorage.removeItem("nkj_session");auth.classList.remove("hidden");dash.classList.add("hidden");msg.textContent="Vous êtes déconnecté.";};document.getElementById("projectForm").onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);try{await api("/api/projects",{method:"POST",body:JSON.stringify({name:f.get("name"),description:f.get("description")})});e.target.reset();await loadProjects();}catch(x){alert(x.message);}};document.getElementById("appForm").onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);try{await api("/api/publisher",{method:"POST",body:JSON.stringify({name:f.get("name"),category:f.get("category"),description:f.get("description")})});e.target.reset();await loadApps();}catch(x){alert(x.message);}};async function loadProjects(){
 const d=await api("/api/projects");
 if(!d.projects.length){projects.textContent="Aucun projet. Créez votre premier projet ci-dessus.";return;}
 projects.innerHTML=d.projects.map(p=>"<article class=\\\"project\\\"><div><h3>"+esc(p.name)+"</h3><p>"+esc(p.description||"Sans description")+"</p><p>Demandes : "+esc(p.quotas.requests_limit)+" · Jetons : "+esc(p.quotas.tokens_limit)+"</p></div><div class=\\\"row\\\"><a class=\\\"btn\\\" href=\\\"/studio/"+encodeURIComponent(p.id)+"\\\">Ouvrir le Studio</a><button class=\\\"btn secondary\\\" data-key=\\\""+esc(p.id)+"\\\">Créer une clé API</button><button class=\\\"btn secondary\\\" data-keylist=\\\""+esc(p.id)+"\\\">Gérer les clés</button><button class=\\\"btn secondary\\\" data-edit=\\\""+esc(p.id)+"\\\" data-name=\\\""+esc(p.name)+"\\\">Modifier</button><button class=\\\"btn danger\\\" data-del=\\\""+esc(p.id)+"\\\">Archiver</button></div></article>").join("");
 projects.querySelectorAll("[data-key]").forEach(b=>b.onclick=async()=>{try{const d=await api("/api/projects/"+encodeURIComponent(b.dataset.key)+"/api-keys",{method:"POST",body:JSON.stringify({name:"Clé API"})});const n=document.getElementById("keyNotice");n.classList.remove("hidden");n.innerHTML="<h3>Nouvelle clé API — copiez-la maintenant</h3><div class=\\\"token\\\">"+esc(d.api_key)+"</div><p class=\\\"muted\\\">Cette clé ne sera plus affichée intégralement. Ne la partagez jamais publiquement.</p><button class=\\\"btn secondary\\\" id=\\\"copyKey\\\">Copier</button>";document.getElementById("copyKey").onclick=()=>navigator.clipboard.writeText(d.api_key);}catch(x){alert(x.message);}});
 projects.querySelectorAll("[data-keylist]").forEach(b=>b.onclick=async()=>{try{const d=await api("/api/projects/"+encodeURIComponent(b.dataset.keylist)+"/api-keys");const n=document.getElementById("keyNotice");n.classList.remove("hidden");n.innerHTML="<h3>Clés API du projet</h3>"+((d.api_keys||[]).length?d.api_keys.map(k=>"<div class=\\\"project\\\"><div><strong>"+esc(k.name)+"</strong><p>"+esc(k.key_prefix)+"… · "+esc(k.status)+"</p></div>"+(k.status==="active"?"<button class=\\\"btn danger\\\" data-revoke=\\\""+esc(b.dataset.keylist)+"|"+esc(k.id)+"\\\">Révoquer</button>":"<span class=\\\"muted\\\">Révoquée</span>")+"</div>").join(""):"<p>Aucune clé API.</p>");n.querySelectorAll("[data-revoke]").forEach(btn=>btn.onclick=async()=>{if(!confirm("Révoquer cette clé API ? Les applications qui l'utilisent ne pourront plus appeler l'API."))return;const pair=btn.dataset.revoke.split("|");try{await api("/api/projects/"+encodeURIComponent(pair[0])+"/api-keys/"+encodeURIComponent(pair[1]),{method:"DELETE"});btn.closest(".project").innerHTML="<strong>Clé API révoquée.</strong>";}catch(x){alert(x.message);}});}catch(x){alert(x.message);}});
 projects.querySelectorAll("[data-edit]").forEach(b=>b.onclick=async()=>{const n=prompt("Nouveau nom",b.dataset.name);if(!n)return;try{await api("/api/projects/"+encodeURIComponent(b.dataset.edit),{method:"PATCH",body:JSON.stringify({name:n})});await loadProjects();}catch(x){alert(x.message);}});
 projects.querySelectorAll("[data-del]").forEach(b=>b.onclick=async()=>{if(!confirm("Archiver ce projet ?"))return;try{await api("/api/projects/"+encodeURIComponent(b.dataset.del),{method:"DELETE"});await loadProjects();}catch(x){alert(x.message);}});
}
async function loadApps(){
 const d=await api("/api/publisher");
 const area=document.getElementById("myApps");
 const statuses={draft:"Brouillon",pending_review:"En attente de validation",published:"Publiée",rejected:"Refusée",suspended:"Suspendue"};
 area.innerHTML=(d.apps||[]).map(a=>{
  const link=location.origin+"/applications/"+encodeURIComponent(a.slug);
  let actions="";
  if(a.status==="draft")actions="<button class=\\\"btn\\\" data-submit-app=\\\""+esc(a.id)+"\\\">Soumettre pour publication</button>";
  if(a.status==="published")actions="<div class=\\\"token\\\"><strong>Adresse publique :</strong><br><a target=\\\"_blank\\\" rel=\\\"noopener\\\" href=\\\""+esc(link)+"\\\">"+esc(link)+"</a><br><button class=\\\"btn secondary\\\" data-copy-link=\\\""+esc(link)+"\\\">Copier le lien</button></div>";
  return "<article class=\\\"project\\\"><div><strong>"+esc(a.name)+"</strong><p>"+esc(a.slug)+" · "+esc(statuses[a.status]||a.status)+"</p>"+(a.rejection_reason?"<p>Motif : "+esc(a.rejection_reason)+"</p>":"")+"</div><div class=\\\"row\\\">"+actions+"</div></article>";
 }).join("")||"<p class=\\\"muted\\\">Aucune fiche créée.</p>";
 area.querySelectorAll("[data-submit-app]").forEach(b=>b.onclick=async()=>{if(!confirm("Soumettre cette fiche à l'administration ? Elle sera visible dans le catalogue public uniquement après approbation."))return;try{await api("/api/publisher/"+encodeURIComponent(b.dataset.submitApp)+"/submit",{method:"POST",body:"{}"});await loadApps();}catch(x){alert(x.message);}});
 area.querySelectorAll("[data-copy-link]").forEach(b=>b.onclick=async()=>{try{await navigator.clipboard.writeText(b.dataset.copyLink);b.textContent="Lien copié";}catch(x){alert("Copiez cette adresse : "+b.dataset.copyLink);}});
}
async function loadDashboard(){let account;try{account=await api("/api/auth/me");}catch(x){if(x.message.includes("(HTTP 401)")){token="";localStorage.removeItem("nkj_session");auth.classList.remove("hidden");dash.classList.add("hidden");msg.textContent="La connexion a été refusée par le serveur : "+x.message;}else{auth.classList.remove("hidden");dash.classList.add("hidden");msg.textContent="Le serveur n'a pas pu vérifier la session : "+x.message+" Vous pouvez réessayer sans recréer votre compte.";}return;}document.getElementById("userEmail").textContent=account.user.email;auth.classList.add("hidden");dash.classList.remove("hidden");msg.textContent="Connexion réussie.";try{await loadProjects();}catch(x){projects.textContent="Connexion établie. Chargement des projets impossible pour le moment : "+x.message;}try{await loadApps();}catch(x){const area=document.getElementById("myApps");if(area)area.textContent="Connexion établie. Chargement des applications impossible pour le moment : "+x.message;}}if(token)loadDashboard();})();</script></body></html>`

const STUDIO_ADMIN_HTML = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Administration — NKJJEAN STUDIO</title><style>:root{color-scheme:dark;--line:#284863;--muted:#a8bbce;--blue:#62b4ff;--cyan:#65e0df}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 85% 0,#14385b 0,transparent 35%),#07111f;color:#edf6ff;font:15px/1.6 system-ui,sans-serif}.wrap{max-width:1200px;margin:auto;padding:22px 16px 65px}.top,.actions{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap}.top{border-bottom:1px solid #ffffff1c;padding-bottom:18px}.brand{font-weight:950;letter-spacing:.08em}.brand span{color:var(--cyan)}a{color:#8dccff}.btn{border:0;border-radius:9px;padding:10px 14px;background:linear-gradient(110deg,var(--blue),var(--cyan));color:#061321;font-weight:850;cursor:pointer;text-decoration:none}.secondary{background:#17334d;color:#edf6ff;border:1px solid var(--line)}.danger{background:#713340;color:#fff}.panel{background:linear-gradient(150deg,#10243a,#0b1b2c);border:1px solid var(--line);border-radius:15px;padding:20px;margin:16px 0}.muted{color:var(--muted)}.eyebrow{color:var(--cyan);font-size:11px;font-weight:900;letter-spacing:.15em;text-transform:uppercase}.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:11px;margin:16px 0}.stat{background:#091a2b;border:1px solid #2a4863;border-radius:12px;padding:13px}.stat strong{display:block;font-size:25px;color:var(--cyan)}.tabs{display:flex;gap:8px;flex-wrap:wrap;margin:20px 0}.tab{background:#112a41;color:#edf6ff;border:1px solid #34516d;padding:10px 14px;border-radius:9px;cursor:pointer}.tab.active{background:#56afff;color:#061321}.item{padding:16px 0;border-bottom:1px solid #ffffff18}.item:last-child{border-bottom:0}.item h3{margin:5px 0}.empty{padding:24px;border:1px dashed #34516d;border-radius:12px;text-align:center;color:var(--muted)}.hidden{display:none!important}.reason{width:100%;max-width:550px;background:#071726;border:1px solid #34516d;border-radius:8px;padding:10px;color:#fff}@media(max-width:850px){.stats{grid-template-columns:repeat(3,1fr)}}@media(max-width:520px){.stats{grid-template-columns:repeat(2,1fr)}}</style></head><body><main class="wrap"><header class="top"><div class="brand">NKJJEAN <span>STUDIO</span> / ADMINISTRATION</div><div class="actions"><a class="btn secondary" href="/">Site public</a><a class="btn secondary" href="/app">Mon espace</a><button class="btn secondary" id="logout">Déconnexion</button></div></header><section class="panel"><div class="eyebrow">Espace protégé</div><h1>Gestion des publications</h1><p class="muted">Les éléments ne deviennent visibles dans le catalogue qu'après approbation administrative.</p><p id="status" class="muted">Vérification de la session…</p></section><section id="adminContent" class="hidden"><div id="overview" class="stats"></div><nav class="tabs"><button class="tab active" data-tab="apps">Applications en attente</button><button class="tab" data-tab="resources">Cours et contenus en attente</button><button class="tab" data-tab="published">Publications en ligne</button><button class="tab" data-tab="payments">Paiements</button></nav><section class="panel" id="appsPanel"><div class="eyebrow">Modération</div><h2>Applications soumises</h2><div id="pendingApps"><div class="empty">Chargement…</div></div></section><section class="panel hidden" id="resourcesPanel"><div class="eyebrow">Modération</div><h2>Cours et autres contenus soumis</h2><div id="pendingResources"><div class="empty">Chargement…</div></div></section><section class="panel hidden" id="publishedPanel"><div class="eyebrow">Visibilité publique</div><h2>Publications en ligne</h2><p class="muted">Les éléments publiés sont accessibles depuis Chrome. Pour les retirer, utilisez la suspension dans la file de modération ou contactez le support d'administration.</p><div id="publishedSummary"></div></section><section class="panel hidden" id="paymentsPanel"><div class="eyebrow">Coordonnées</div><h2>Réception des paiements</h2><p>Numéro communiqué : <strong>0814620569</strong></p><p class="muted">Le numéro est enregistré comme destination prévue. La passerelle Mobile Money n'est pas encore reliée : aucune transaction ne peut être vérifiée automatiquement et aucun paiement ne doit être marqué comme reçu sans confirmation opérateur.</p></section></section></main><script>(function(){const $=id=>document.getElementById(id),token=localStorage.getItem("nkj_session")||"";function esc(v){return String(v==null?"":v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}async function api(path,opt){opt=opt||{};opt.headers=opt.headers||{};if(token)opt.headers.Authorization="Bearer "+token;if(opt.body&&!(opt.body instanceof FormData))opt.headers["Content-Type"]="application/json";const r=await fetch(path,opt);let d={};try{d=await r.json();}catch(e){}if(!r.ok)throw new Error((d.error||"Opération impossible.")+" (HTTP "+r.status+")");return d;}function tab(name){["apps","resources","published","payments"].forEach(x=>$(x+"Panel").classList.toggle("hidden",x!==name));document.querySelectorAll("[data-tab]").forEach(b=>b.classList.toggle("active",b.dataset.tab===name));if(name==="resources")loadResources();if(name==="apps")loadApps();if(name==="published")loadPublished();}document.querySelectorAll("[data-tab]").forEach(b=>b.onclick=()=>tab(b.dataset.tab));$("logout").onclick=async()=>{try{await api("/api/auth/logout",{method:"POST",body:"{}"});}catch(e){}localStorage.removeItem("nkj_session");location.href="/app";};async function loadOverview(){const d=await api("/api/admin/overview"),c=d.counts||{},items=[["Applications",c.total_apps||0],["Applications publiées",c.published_apps||0],["Cours",c.total_courses||0],["Cours publiés",c.published_courses||0],["Autres contenus",c.total_contents||0],["Contenus publiés",c.published_contents||0],["Total public",c.published_total||0],["En attente",c.pending_reviews||0],["Comptes",c.users||0],["Projets actifs",c.active_projects||0]];$("overview").innerHTML=items.map(x=>"<div class='stat'><span class='muted'>"+esc(x[0])+"</span><strong>"+esc(x[1])+"</strong></div>").join("");$("publishedSummary").textContent="En ligne : "+(c.published_total||0)+" publication(s), dont "+(c.published_apps||0)+" application(s), "+(c.published_courses||0)+" cours et "+(c.published_contents||0)+" autres contenus.";}async function loadApps(){try{const d=await api("/api/admin/publications/pending");$("pendingApps").innerHTML=(d.apps||[]).map(a=>"<article class='item'><div class='eyebrow'>Application · "+esc(a.category)+"</div><h3>"+esc(a.name)+"</h3><p>"+esc(a.description||"Sans description")+"</p><p class='muted'>Compte : "+esc(a.owner_email)+" · /applications/"+esc(a.slug)+"</p><p class='muted'>Fichiers APK en attente : "+esc(a.pending_files||0)+"</p><div class='actions'><button class='btn secondary' data-show-files-app='"+esc(a.id)+"'>Voir les fichiers soumis</button><button class='btn' data-approve='"+esc(a.id)+"'>Publier</button><button class='btn danger' data-reject='"+esc(a.id)+"'>Refuser</button><a class='btn secondary' href='/applications/"+encodeURIComponent(a.slug)+"' target='_blank'>Aperçu</a></div></article>").join("")||"<div class='empty'>Aucune application en attente.</div>";$("pendingApps").querySelectorAll("[data-approve]").forEach(b=>b.onclick=()=>decideApp(b.dataset.approve,"approved"));$("pendingApps").querySelectorAll("[data-reject]").forEach(b=>b.onclick=()=>decideApp(b.dataset.reject,"rejected"));$("pendingApps").querySelectorAll("[data-show-files-app]").forEach(b=>b.onclick=async()=>{try{const d=await api("/api/admin/apps/"+encodeURIComponent(b.dataset.showFilesApp)+"/releases"),box=document.createElement("div");box.className="notice";box.innerHTML=(d.releases||[]).map(f=>"<p>"+esc(f.version_name)+" · "+esc(f.file_name)+" · "+(Number(f.file_size)/1048576).toFixed(2)+" Mo · "+esc(f.status)+" <a href='"+esc(f.review_download)+"'>Télécharger pour contrôle</a></p>").join("")||"Aucun APK déposé.";b.closest(".item").appendChild(box);}catch(e){alert(e.message);}});}catch(e){$("pendingApps").textContent=e.message;}}async function decideApp(id,decision){const comment=decision==="rejected"?prompt("Motif du refus :"): "Fiche validée par l'administration.";if(comment===null)return;try{await api("/api/admin/apps/"+encodeURIComponent(id),{method:"POST",body:JSON.stringify({decision,comment})});await refresh();alert(decision==="approved"?"Application publiée.":"Décision enregistrée.");}catch(e){alert(e.message);}}async function loadResources(){try{const d=await api("/api/admin/resources/pending");$("pendingResources").innerHTML=(d.resources||[]).map(x=>"<article class='item'><div class='eyebrow'>"+(x.type==="course"?"Cours":"Autre contenu")+" · "+esc(x.category)+"</div><h3>"+esc(x.title)+"</h3><p>"+esc(x.description||"Sans description")+"</p><p class='muted'>Compte : "+esc(x.owner_email)+" · /"+(x.type==="course"?"cours/":"publications/")+esc(x.slug)+"</p><p class='muted'>Fichiers en attente : "+esc(x.pending_files||0)+"</p><div class='actions'><button class='btn secondary' data-show-files-resource='"+esc(x.id)+"'>Voir les fichiers soumis</button><button class='btn' data-approve-resource='"+esc(x.id)+"'>Publier</button><button class='btn danger' data-reject-resource='"+esc(x.id)+"'>Refuser</button><a class='btn secondary' href='/"+(x.type==="course"?"cours/":"publications/")+encodeURIComponent(x.slug)+"' target='_blank'>Aperçu</a></div></article>").join("")||"<div class='empty'>Aucun cours ou contenu en attente.</div>";$("pendingResources").querySelectorAll("[data-approve-resource]").forEach(b=>b.onclick=()=>decideResource(b.dataset.approveResource,"approved"));$("pendingResources").querySelectorAll("[data-reject-resource]").forEach(b=>b.onclick=()=>decideResource(b.dataset.rejectResource,"rejected"));$("pendingResources").querySelectorAll("[data-show-files-resource]").forEach(b=>b.onclick=async()=>{try{const d=await api("/api/admin/resources/"+encodeURIComponent(b.dataset.showFilesResource)+"/files"),box=document.createElement("div");box.className="notice";box.innerHTML=(d.files||[]).map(f=>"<p>"+esc(f.file_name)+" · "+(Number(f.file_size)/1048576).toFixed(2)+" Mo · "+esc(f.status)+" <a href='"+esc(f.review_download)+"'>Télécharger pour contrôle</a></p>").join("")||"Aucun fichier déposé.";b.closest(".item").appendChild(box);}catch(e){alert(e.message);}});}catch(e){$("pendingResources").textContent=e.message;}}async function decideResource(id,decision){const comment=decision==="rejected"?prompt("Motif du refus :"): "Ressource validée par l'administration.";if(comment===null)return;try{await api("/api/admin/resources/"+encodeURIComponent(id),{method:"POST",body:JSON.stringify({decision,comment})});await refresh();await loadResources();alert(decision==="approved"?"Publication mise en ligne.":"Décision enregistrée.");}catch(e){alert(e.message);}}async function loadPublished(){try{const d=await api("/api/admin/publications/published"),area=$("publishedSummary");area.innerHTML=(d.items||[]).map(x=>"<article class='item'><div class='eyebrow'>"+esc(x.type==="application"?"Application":x.type==="course"?"Cours":"Autre contenu")+" · "+esc(x.category)+"</div><h3>"+esc(x.title)+"</h3><p class='muted'>/"+(x.type==="application"?"applications/":x.type==="course"?"cours/":"publications/")+esc(x.slug)+"</p><div class='actions'><a class='btn secondary' target='_blank' href='/"+(x.type==="application"?"applications/":x.type==="course"?"cours/":"publications/")+encodeURIComponent(x.slug)+"'>Ouvrir la page</a><button class='btn danger' data-suspend='"+esc(x.type)+"|"+esc(x.id)+"'>Suspendre la publication</button></div></article>").join("")||"<div class='empty'>Aucune publication en ligne.</div>";area.querySelectorAll("[data-suspend]").forEach(b=>b.onclick=async()=>{if(!confirm("Retirer cette publication du catalogue public ?"))return;const pair=b.dataset.suspend.split("|"),isApp=pair[0]==="application";try{await api((isApp?"/api/admin/apps/":"/api/admin/resources/")+encodeURIComponent(pair[1]),{method:"POST",body:JSON.stringify({decision:"suspended",comment:"Publication suspendue par l'administration."})});await refresh();await loadPublished();}catch(e){alert(e.message);}});}catch(e){$("publishedSummary").textContent=e.message;}}async function refresh(){await loadOverview();await loadApps();}async function init(){if(!token){$("status").textContent="Connectez-vous avec un compte administrateur depuis /app.";return;}try{const me=await api("/api/auth/me");if(!me.user||me.user.role!=="admin"){$("status").textContent="Accès refusé : compte non administrateur.";return;}$("status").textContent="Administrateur connecté : "+me.user.email;$("adminContent").classList.remove("hidden");await refresh();}catch(e){$("status").textContent=e.message;}}init();})();</script></body></html>`;

const STUDIO_WORKSPACE_HTML = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#07111f"><title>Studio du projet — NKJJEAN STUDIO</title><style>:root{color-scheme:dark;--bg:#07111f;--line:#25435f;--muted:#9db1c8;--blue:#56afff;--cyan:#65e0df}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 85% 0,#12365a 0,transparent 35%),var(--bg);color:#eaf3ff;font:15px/1.6 system-ui,sans-serif}.wrap{max-width:1320px;margin:auto;padding:22px 18px 60px}.top,.hero{display:flex;justify-content:space-between;align-items:center;gap:15px;flex-wrap:wrap}.top{border-bottom:1px solid #ffffff18;padding:10px 0 20px}.brand{font-weight:900;letter-spacing:.08em}.brand span{color:var(--cyan)}a{color:#8dccff}.btn{display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:9px;padding:10px 14px;background:linear-gradient(110deg,var(--blue),var(--cyan));color:#061321;font-weight:800;text-decoration:none;cursor:pointer}.secondary{background:#17334d;color:#eaf3ff;border:1px solid #34516d}.danger{background:#602d38;color:#fff}.muted{color:var(--muted)}.panel{background:linear-gradient(150deg,#10243a,#0b1929);border:1px solid var(--line);border-radius:15px;padding:20px;margin:16px 0}.eyebrow{color:var(--cyan);font-size:11px;font-weight:900;letter-spacing:.16em;text-transform:uppercase}.hero h1{font-size:clamp(28px,4vw,42px);margin:5px 0}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0}.stat{background:#0d2033;border:1px solid var(--line);border-radius:13px;padding:15px}.stat strong{display:block;font-size:22px}.tabs,.actions{display:flex;gap:8px;flex-wrap:wrap;margin:18px 0}.tab{border:1px solid #34516d;background:#10263b;color:#eaf3ff;padding:10px 15px;border-radius:9px;cursor:pointer;font-weight:800}.tab.active{background:#56afff;color:#061321}.layout{display:grid;grid-template-columns:300px minmax(0,1fr);gap:16px}.list{display:grid;gap:9px;margin-top:12px}.conversation{width:100%;text-align:left;background:#091a2b;border:1px solid #2a4863;color:#eaf3ff;border-radius:10px;padding:12px;cursor:pointer}.conversation.active{border-color:var(--cyan);background:#12304a}.field{display:block;margin:10px 0;color:#c7d9eb}.field textarea{display:block;width:100%;margin-top:6px;background:#071726;color:#fff;border:1px solid #34516d;border-radius:9px;padding:12px;font:inherit;min-height:110px;resize:vertical}.messages{display:grid;gap:12px;max-height:54vh;overflow:auto;padding:8px 2px}.message{padding:14px;border-radius:12px;max-width:92%;white-space:pre-wrap;overflow-wrap:anywhere}.message.user{justify-self:end;background:#173b5a;border:1px solid #35658b}.message.assistant{justify-self:start;background:#10283d;border:1px solid #2c506d}.notice{border-left:3px solid #e3b45d;background:#332a17;color:#f5dfb3;padding:12px;border-radius:8px;margin:12px 0}.hidden{display:none!important}.keyrow{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:12px 0;border-bottom:1px solid #ffffff15}.empty{padding:28px;border:1px dashed #34516d;border-radius:12px;color:var(--muted);text-align:center}@media(max-width:850px){.layout{grid-template-columns:1fr}.stats{grid-template-columns:repeat(2,1fr)}}@media(max-width:480px){.stats{grid-template-columns:1fr 1fr}.wrap{padding:14px 12px 40px}}</style></head><body><main class="wrap"><header class="top"><div class="brand">NKJJEAN <span>STUDIO</span> / PROJET</div><div class="actions"><a class="btn secondary" href="/app">← Retour à mes projets</a><a class="btn secondary" href="/docs">Aide</a></div></header><section class="panel"><div class="hero"><div><div class="eyebrow">Espace de travail privé</div><h1 id="projectName">Chargement du projet…</h1><p id="projectDescription" class="muted"></p><p class="muted" id="projectOwner"></p></div><span class="btn secondary">Données privées du propriétaire</span></div><div id="stats" class="stats"><div class="stat"><span class="muted">Requêtes</span><strong>—</strong></div><div class="stat"><span class="muted">Jetons</span><strong>—</strong></div><div class="stat"><span class="muted">Limite quotidienne</span><strong>—</strong></div><div class="stat"><span class="muted">Journal</span><strong>—</strong></div></div></section><nav class="tabs"><button class="tab active" id="workTab">Espace de travail</button><button class="tab" id="apiTab">API et activité</button></nav><section id="workPanel"><div class="layout"><aside class="panel"><div class="hero"><div><div class="eyebrow">Organisation</div><h2>Conversations</h2></div><button class="btn" id="newConversation">+ Nouvelle</button></div><p class="muted">Tes consignes et notes de travail sont sauvegardées dans ton espace privé.</p><div id="conversationList" class="list"><div class="empty">Chargement…</div></div></aside><section class="panel"><div class="hero"><div><div class="eyebrow">Atelier de travail</div><h2 id="conversationTitle">Choisis ou crée une conversation</h2></div><span class="btn secondary">Historique sauvegardé</span></div><div id="aiNotice" class="notice"><strong>NKJJEAN IA — moteur propriétaire.</strong> Le Studio est prêt pour le moteur privé partagé avec TECHNONKJJEAN et les autres applications. <span id="aiStatusLabel">Vérification de la liaison du moteur…</span> Aucun fournisseur IA externe n'est utilisé.</div><div id="messageList" class="messages"><div class="empty">Crée une conversation pour commencer à organiser le travail de ce projet.</div></div><form id="messageForm" class="hidden"><label class="field">Message à NKJJEAN IA<textarea id="messageContent" maxlength="20000" placeholder="Explique le travail à réaliser. NKJJEAN IA analysera la demande lorsque son moteur propriétaire sera relié…" required></textarea></label><div class="actions"><button class="btn" id="sendAiButton">Envoyer à NKJJEAN IA</button><button class="btn secondary" type="button" id="saveNoteButton">Enregistrer comme note</button></div><p id="aiRequestStatus" class="muted">Le Studio est préparé pour le moteur IA propriétaire NKJJEAN.</p></form><p id="workspaceStatus" class="muted" aria-live="polite"></p></section></div></section><section id="apiPanel" class="panel hidden"><div class="eyebrow">Accès développeur</div><h2>Clés API et activité</h2><p class="muted">Gère les clés utilisées par tes applications clientes et consulte les appels enregistrés pour ce projet.</p><div class="layout"><section class="panel"><h3>Clés API</h3><div id="keysList" class="muted">Chargement…</div></section><section class="panel"><h3>Dernières utilisations</h3><div id="usageList" class="muted">Chargement…</div></section></div></section><p class="muted">NKJJEAN STUDIO — L'hébergement du modèle IA propriétaire et le stockage sécurisé des APK sont des étapes séparées.</p></main><script>(function(){const parts=location.pathname.split("/").filter(Boolean),projectId=parts.length>1?decodeURIComponent(parts[1]):"";let token=localStorage.getItem("nkj_session")||"";const $=id=>document.getElementById(id);function esc(v){return String(v==null?"":v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}async function api(path,opt){opt=opt||{};opt.headers=opt.headers||{};opt.headers["Content-Type"]=opt.headers["Content-Type"]||"application/json";if(token)opt.headers.Authorization="Bearer "+token;const r=await fetch(path,opt);let d={};try{d=await r.json();}catch(e){}if(!r.ok)throw new Error((d.error||"La demande a échoué.")+" (HTTP "+r.status+")");return d;}function showTab(which){$("workPanel").classList.toggle("hidden",which!=="work");$("apiPanel").classList.toggle("hidden",which!=="api");$("workTab").classList.toggle("active",which==="work");$("apiTab").classList.toggle("active",which==="api");if(which==="api")loadApiData();}let currentConversation="";$("workTab").onclick=()=>showTab("work");$("apiTab").onclick=()=>showTab("api");async function loadAiStatus(){try{const r=await fetch("/api/health",{headers:{Accept:"application/json"}}),d=await r.json();$("aiStatusLabel").textContent=d.checks&&d.checks.own_ai_engine_connected?"Moteur privé relié. La disponibilité du modèle doit encore être confirmée.":"Moteur privé non relié pour le moment. Les notes et conversations restent disponibles."; }catch(e){$("aiStatusLabel").textContent="État du moteur indisponible. Les notes restent disponibles.";}}async function loadProject(){const d=await api("/api/projects/"+encodeURIComponent(projectId));const p=d.project,q=d.quotas||{};$("projectName").textContent=p.name;$("projectDescription").textContent=p.description||"Aucune description renseignée.";$("projectOwner").textContent="Créé le "+(p.created_at||"date inconnue");$("stats").innerHTML="<div class='stat'><span class='muted'>Limite de requêtes</span><strong>"+esc(q.requests_limit||0)+"</strong></div><div class='stat'><span class='muted'>Limite de jetons</span><strong>"+esc(q.tokens_limit||0)+"</strong></div><div class='stat'><span class='muted'>Limite quotidienne</span><strong>"+esc(q.daily_limit||0)+"</strong></div><div class='stat'><span class='muted'>Journal d'activité</span><strong>"+esc((d.usage&&d.usage.log_entries)||0)+"</strong></div>";}async function loadConversations(){const d=await api("/api/projects/"+encodeURIComponent(projectId)+"/conversations"),list=$("conversationList");list.innerHTML=(d.conversations||[]).map(c=>"<button class='conversation "+(c.id===currentConversation?"active":"")+"' data-conversation='"+esc(c.id)+"'><strong>"+esc(c.title)+"</strong><br><small class='muted'>"+esc(new Date(c.updated_at).toLocaleString())+"</small></button>").join("")||"<div class='empty'>Aucune conversation. Clique sur « Nouvelle » pour créer ton premier espace de travail.</div>";list.querySelectorAll("[data-conversation]").forEach(b=>b.onclick=()=>openConversation(b.dataset.conversation));}async function openConversation(id){try{const d=await api("/api/conversations/"+encodeURIComponent(id));currentConversation=id;$("conversationTitle").textContent=d.conversation.title;$("messageForm").classList.remove("hidden");$("messageList").innerHTML=(d.messages||[]).map(m=>"<div class='message "+(m.role==="user"?"user":"assistant")+"'><strong>"+(m.role==="user"?"Tes consignes":"Assistant")+"</strong><br>"+esc(m.content)+"</div>").join("")||"<div class='empty'>Cette conversation est vide. Ajoute la première consigne de travail.</div>";await loadConversations();$("workspaceStatus").textContent="Conversation chargée. Les messages précédents sont conservés.";}catch(e){$("workspaceStatus").textContent=e.message;}}$("newConversation").onclick=async()=>{const title=prompt("Titre de cette conversation ou tâche :","Nouvelle tâche");if(title===null)return;try{const d=await api("/api/projects/"+encodeURIComponent(projectId)+"/conversations",{method:"POST",body:JSON.stringify({title:title.trim()||"Nouvelle tâche"})});await loadConversations();await openConversation(d.conversation.id);}catch(e){$("workspaceStatus").textContent=e.message;}};$("messageForm").onsubmit=async e=>{e.preventDefault();if(!currentConversation)return;const field=$("messageContent"),content=field.value.trim();if(!content)return;const btn=$("sendAiButton");btn.disabled=true;btn.textContent="Analyse en cours…";$("aiRequestStatus").textContent="Transmission sécurisée au moteur privé NKJJEAN…";try{const d=await api("/api/projects/"+encodeURIComponent(projectId)+"/ai",{method:"POST",body:JSON.stringify({conversation_id:currentConversation,prompt:content})});field.value="";await openConversation(currentConversation);$("aiRequestStatus").textContent="Réponse reçue de "+(d.model||"NKJJEAN IA propriétaire")+". Jetons suivis : "+(Number(d.usage&&d.usage.input_tokens||0)+Number(d.usage&&d.usage.output_tokens||0))+".";}catch(x){$("aiRequestStatus").textContent=x.message+" Le texte reste disponible dans la zone de saisie : tu peux le copier ou l'enregistrer comme note.";}finally{btn.disabled=false;btn.textContent="Envoyer à NKJJEAN IA";}};$("saveNoteButton").onclick=async()=>{if(!currentConversation)return;const field=$("messageContent"),content=field.value.trim();if(!content)return;const btn=$("saveNoteButton");btn.disabled=true;try{await api("/api/conversations/"+encodeURIComponent(currentConversation),{method:"POST",body:JSON.stringify({content})});field.value="";await openConversation(currentConversation);$("aiRequestStatus").textContent="Note enregistrée dans l'historique du projet.";}catch(x){$("aiRequestStatus").textContent=x.message;}finally{btn.disabled=false;}};async function loadApiData(){try{const d=await api("/api/projects/"+encodeURIComponent(projectId)+"/api-keys");$("keysList").innerHTML=(d.api_keys||[]).map(k=>"<div class='keyrow'><div><strong>"+esc(k.name)+"</strong><br><small class='muted'>"+esc(k.key_prefix)+"… · "+esc(k.status)+"</small></div>"+(k.status==="active"?"<button class='btn danger' data-revoke='"+esc(k.id)+"'>Révoquer</button>":"<span class='muted'>Inactive</span>")+"</div>").join("")||"Aucune clé API.";$("keysList").querySelectorAll("[data-revoke]").forEach(b=>b.onclick=async()=>{if(!confirm("Révoquer cette clé ? Les clients qui l'utilisent seront bloqués."))return;try{await api("/api/projects/"+encodeURIComponent(projectId)+"/api-keys/"+encodeURIComponent(b.dataset.revoke),{method:"DELETE"});await loadApiData();}catch(x){alert(x.message);}});}catch(e){$("keysList").textContent=e.message;}try{const d=await api("/api/projects/"+encodeURIComponent(projectId)+"/usage");$("usageList").innerHTML=(d.usage||[]).map(u=>"<div class='keyrow'><div><strong>"+esc(u.endpoint)+"</strong><br><small class='muted'>"+esc(u.created_at)+"</small></div><span>HTTP "+esc(u.status_code)+" · "+esc(Number(u.input_tokens||0)+Number(u.output_tokens||0))+" jetons</span></div>").join("")||"Aucune utilisation enregistrée.";}catch(e){$("usageList").textContent=e.message;}}async function init(){if(!token){$("workspaceStatus").textContent="Connecte-toi depuis ton espace personnel pour ouvrir ce projet.";return;}if(!projectId){$("workspaceStatus").textContent="Identifiant de projet manquant.";return;}try{await loadAiStatus();await loadProject();await loadConversations();}catch(e){$("workspaceStatus").textContent=e.message;if(e.message.includes("HTTP 401"))location.href="/app";}}init();})();</script></body></html>`;

const STUDIO_STORE_HTML = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Catalogue public NKJJEAN STUDIO : applications, cours et ressources numériques validés."><meta name="robots" content="index,follow"><title>Catalogue public — NKJJEAN STUDIO</title><style>:root{color-scheme:dark;--bg:#07111f;--line:#284863;--muted:#a8bbce;--blue:#62b4ff;--cyan:#65e0df}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 0,#14385b 0,transparent 35%),var(--bg);color:#edf6ff;font:15px/1.65 system-ui,sans-serif}.wrap{max-width:1120px;margin:auto;padding:20px 16px 70px}a{color:#8dccff;text-decoration:none}.top,.filters,.actions{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}.top{padding-bottom:18px;border-bottom:1px solid #ffffff1c}.brand{font-weight:950;letter-spacing:.08em}.brand span{color:var(--cyan)}.btn{display:inline-flex;padding:10px 15px;border-radius:9px;background:linear-gradient(110deg,var(--blue),var(--cyan));color:#061321;font-weight:850;border:0;cursor:pointer}.alt{background:#17334d;color:#edf6ff;border:1px solid var(--line)}.muted{color:var(--muted)}.hero{padding:34px 0 22px}.hero h1{font-size:clamp(30px,5vw,44px);margin:6px 0}.search{display:flex;gap:9px;flex:1;min-width:min(100%,300px)}input{flex:1;min-width:0;background:#0c2033;border:1px solid #35516c;border-radius:9px;color:#fff;padding:12px}.filters{justify-content:flex-start;margin:16px 0}.chip{padding:9px 13px;border:1px solid #34516d;background:#10263b;color:#eaf3ff;border-radius:99px;cursor:pointer}.chip.active{background:#56afff;color:#061321}.stats{display:flex;gap:18px;flex-wrap:wrap;color:var(--muted);font-size:13px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(235px,1fr));gap:15px;margin-top:18px}.card,.detail{background:linear-gradient(150deg,#10243a,#0b1b2c);border:1px solid var(--line);border-radius:15px;padding:20px}.tag{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--cyan);font-weight:900}.card h2{font-size:20px;margin:8px 0}.card p{color:var(--muted)}.empty{padding:26px;border:1px dashed #34516d;border-radius:12px;color:var(--muted);grid-column:1/-1}.file{padding:14px;background:#091a2b;border:1px solid #34516d;border-radius:10px;margin:10px 0}.file a{display:inline-block;margin-top:7px}.detail h1{font-size:32px}.footer{margin-top:44px;padding-top:20px;border-top:1px solid #ffffff1c;color:var(--muted)}@media(max-width:600px){.search{flex-direction:column}.search .btn{width:100%}}</style></head><body><main class="wrap"><header class="top"><a class="brand" href="/">NKJJEAN <span>STUDIO</span></a><div class="actions"><a href="/">Accueil</a><a href="/app">Mon espace</a><a href="/docs">Aide</a></div></header><section class="hero"><div class="tag">Catalogue public</div><h1 id="heading">Applications, cours et contenus</h1><p class="muted" id="description">Recherchez une ressource publiée et validée par l'administration.</p><form id="searchForm" class="search"><input id="search" type="search" placeholder="Rechercher par nom, description ou catégorie…" aria-label="Rechercher"><button class="btn">Rechercher</button></form><div class="stats" id="stats"></div></section><div class="filters" id="filters"><button class="chip active" data-type="all">Tout</button><button class="chip" data-type="application">Applications</button><button class="chip" data-type="course">Cours</button><button class="chip" data-type="content">Autres contenus</button></div><div id="results" class="grid" aria-live="polite"><div class="empty">Chargement…</div></div><footer class="footer">© NKJJEAN STUDIO · Numéro de réception prévu : 0814620569</footer></main><script>(function(){const $=id=>document.getElementById(id);let type="all",items=[];function esc(v){return String(v==null?"":v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}function norm(s){return String(s||"").toLocaleLowerCase("fr").normalize("NFD").replace(/[\u0300-\u036f]/g,"");}function render(){const q=norm($("search").value.trim()),found=items.filter(x=>(type==="all"||x.type===type)&&(!q||norm([x.title,x.description,x.category].join(" ")).includes(q)));$("results").innerHTML=found.length?found.map(x=>{const href=x.type==="application"?"/applications/":x.type==="course"?"/cours/":"/publications/";return "<article class='card'><div class='tag'>"+esc(x.type==="application"?"Application":x.type==="course"?"Cours":"Autre contenu")+" · "+esc(x.category)+"</div><h2>"+esc(x.title)+"</h2><p>"+esc((x.description||"").slice(0,210))+"</p><a class='btn alt' href='"+href+encodeURIComponent(x.slug)+"'>Consulter la fiche</a></article>";}).join(""):"<div class='empty'><h2>Aucun résultat</h2><p>Essayez un autre mot-clé ou un autre filtre.</p><a class='btn alt' href='/app'>Proposer une publication</a></div>";}async function detail(slug,section){$("filters").classList.add("hidden");$("searchForm").classList.add("hidden");const app=section==="applications",r=await fetch(app?"/api/store/apps/"+encodeURIComponent(slug):"/api/store/resources/"+encodeURIComponent(slug)),d=await r.json();if(!r.ok)throw new Error(d.error||"Fiche introuvable.");const item=app?d.app:d.resource;document.title=(item.name||item.title)+" — NKJJEAN STUDIO";const files=app?(d.releases||[]).map(x=>({...x,download_url:"/api/download/app/"+encodeURIComponent(x.id)})):(d.files||[]);$("heading").textContent=item.name||item.title;$("description").textContent=item.description||"Aucune description fournie.";$("results").className="";$("results").innerHTML="<article class='detail'><div class='tag'>"+esc(item.category)+"</div><h1>"+esc(item.name||item.title)+"</h1><p>"+esc(item.description||"Aucune description fournie.")+"</p><p class='muted'>Publié le : "+esc(item.published_at||"Non renseigné")+"</p><h2>Fichiers disponibles</h2>"+(files.length?files.map(f=>"<div class='file'><strong>"+esc(f.version_name||f.file_name)+"</strong><p class='muted'>"+esc(f.file_name||"Fichier")+" · "+(Number(f.file_size||0)/1048576).toFixed(2)+" Mo</p><a class='btn' href='"+esc(f.download_url)+"'>Télécharger</a></div>").join(""):"<p class='muted'>Aucun fichier téléchargeable n'a encore été approuvé pour cette publication.</p>")+"<div class='actions'><a class='btn alt' href='/"+(section==="cours"?"cours":section==="publications"?"publications":"applications")+"'>Retour au catalogue</a><button class='btn alt' id='copyLink'>Copier le lien</button></div></article>";$("copyLink").onclick=async()=>{try{await navigator.clipboard.writeText(location.href);$("copyLink").textContent="Lien copié";}catch(e){$("copyLink").textContent=location.href;}};}async function load(){try{const section=location.pathname.split("/").filter(Boolean)[0]||"applications",params=new URLSearchParams({limit:"60"}),initial=new URLSearchParams(location.search).get("q")||"";$("search").value=initial;if(initial)params.set("q",initial);const r=await fetch("/api/store/catalog?"+params),d=await r.json();if(!r.ok)throw new Error(d.error||"Catalogue indisponible.");items=d.items||[];const c=d.counts||{};$("stats").textContent="Publications : "+(c.publications||0)+" · Applications : "+(c.applications||0)+" · Cours : "+(c.courses||0)+" · Contenus : "+(c.contents||0);if(section==="cours"){type="course";$("heading").textContent="Cours publiés";}else if(section==="publications"){type="content";$("heading").textContent="Autres contenus publiés";}else if(section==="applications"){$("heading").textContent="Applications publiées";}document.querySelectorAll("[data-type]").forEach(b=>b.classList.toggle("active",b.dataset.type===type));const parts=location.pathname.split("/").filter(Boolean);if(parts.length>1)await detail(decodeURIComponent(parts[1]),section);else render();}catch(e){$("results").innerHTML="<div class='empty'>"+esc(e.message)+"</div>";}}document.querySelectorAll("[data-type]").forEach(b=>b.onclick=()=>{type=b.dataset.type;document.querySelectorAll("[data-type]").forEach(x=>x.classList.toggle("active",x===b));render();});$("searchForm").onsubmit=e=>{e.preventDefault();const q=$("search").value.trim();location.href=location.pathname+(q?"?q="+encodeURIComponent(q):"");};$("search").oninput=render;load();})();</script></body></html>`;

const STUDIO_STORE_HTML = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Catalogue public des applications NKJJEAN STUDIO."><title>Applications — NKJJEAN STUDIO</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#07111f;color:#eaf3ff;font:15px/1.65 system-ui,sans-serif}.wrap{max-width:1100px;margin:auto;padding:25px 18px 70px}a{color:#80caff}.muted{color:#9db1c8}.toolbar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px}.toolbar a{margin-right:10px}input{width:min(100%,480px);padding:13px;border-radius:9px;border:1px solid #35516c;background:#0c2033;color:white}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px;margin-top:24px}.card,.detail{background:#0e2033;border:1px solid #25435f;border-radius:14px;padding:21px}.btn{display:inline-block;padding:9px 14px;background:#55aaff;color:#061321;border-radius:8px;font-weight:800;text-decoration:none}.secondary{background:#1b3854;color:#eaf3ff;border:1px solid #34516d}.empty{padding:27px;border:1px dashed #34516d;border-radius:12px;color:#a9bdd2;grid-column:1/-1}.versions{display:grid;gap:12px;margin-top:18px}.version{padding:15px;border:1px solid #2a4965;border-radius:10px;background:#0a1b2b}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}</style></head><body><main class="wrap"><header class="toolbar"><div><a href="/">Accueil</a><a href="/app">Mon espace</a><a href="/docs">Aide</a></div><strong>NKJJEAN STUDIO</strong></header><h1 id="pageTitle">Catalogue public des applications</h1><p class="muted" id="intro">Découvrez les applications validées et publiées par leurs développeurs.</p><div id="catalogueControls"><input id="search" type="search" placeholder="Rechercher une application…" aria-label="Rechercher une application"></div><div id="apps" class="grid" aria-live="polite">Chargement du catalogue…</div></main><script>(function(){const root=document.getElementById("apps"),search=document.getElementById("search"),controls=document.getElementById("catalogueControls"),title=document.getElementById("pageTitle"),intro=document.getElementById("intro");let list=[];function esc(v){return String(v==null?"":v).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c];});}function render(){const q=search.value.toLowerCase().trim(),matches=list.filter(function(a){return (a.name+" "+a.description+" "+a.category+" "+a.developer).toLowerCase().includes(q);});root.innerHTML=matches.length?matches.map(function(a){return "<article class=\"card\"><p class=\"muted\">"+esc(a.category)+"</p><h2>"+esc(a.name)+"</h2><p>"+esc(a.description)+"</p><p class=\"muted\">Développeur : "+esc(a.developer)+"</p><a class=\"btn\" href=\""+esc(a.url)+"\">Consulter la fiche</a></article>";}).join(""):"<div class=\"empty\"><h2>"+(q?"Aucun résultat correspondant":"Aucune application publiée pour le moment")+"</h2><p>"+(q?"Essayez un autre mot-clé.":"Les applications apparaissent ici après publication et approbation de leur version. Vous pouvez déjà préparer votre propre fiche depuis votre espace personnel.")+"</p><div class=\"actions\"><a class=\"btn\" href=\"/app\">Créer une fiche d’application</a><a class=\"btn secondary\" href=\"/docs\">Comprendre la publication</a></div></div>";}async function loadCatalogue(){try{const r=await fetch("/api/store/apps",{headers:{Accept:"application/json"}});const d=await r.json();if(!r.ok)throw new Error(d.error||"Le catalogue est temporairement indisponible.");list=Array.isArray(d.apps)?d.apps:[];render();}catch(e){root.innerHTML="<div class=\"empty\">"+esc(e.message)+"<p><a href=\"/\">Retour à l’accueil</a></p></div>";}}async function loadDetails(slug){controls.classList.add("hidden");title.textContent="Fiche de l’application";intro.textContent="Informations publiques et versions approuvées.";try{const r=await fetch("/api/store/apps/"+encodeURIComponent(slug),{headers:{Accept:"application/json"}});const d=await r.json();if(!r.ok)throw new Error(d.error||"Cette application est introuvable.");const a=d.app||{},versions=Array.isArray(d.versions)?d.versions:[],publicLink=location.origin+"/applications/"+encodeURIComponent(a.slug||slug);root.className="";root.innerHTML="<article class=\\\"detail\\\"><p class=\\\"muted\\\">"+esc(a.category)+"</p><h2>"+esc(a.name)+"</h2><p>"+esc(a.description||"Aucune description fournie.")+"</p><p class=\\\"muted\\\">Publié le : "+esc(a.published_at||"Date non renseignée")+"</p><section class=\\\"version\\\"><strong>Adresse publique à partager</strong><p><a href=\\\""+esc(publicLink)+"\\\">"+esc(publicLink)+"</a></p><button class=\\\"btn secondary\\\" id=\\\"copyPublicLink\\\">Copier le lien public</button></section><h3>Informations de version</h3><div class=\\\"versions\\\">"+(versions.length?versions.map(function(v){return "<section class=\\\"version\\\"><strong>"+esc(v.version_name)+"</strong><p class=\\\"muted\\\">Code : "+esc(v.version_code)+" · Taille : "+(Number(v.file_size)>0?(Number(v.file_size)/1048576).toFixed(2)+" Mo":"Non renseignée")+"</p><p>"+esc(v.changelog||"Aucune note de version.")+"</p></section>";}).join(""):"<p>Cette page de présentation est publique. Le téléchargement APK sera proposé lorsque le stockage privé sera activé.</p>")+"</div><div class=\\\"actions\\\"><a class=\\\"btn secondary\\\" href=\\\"/applications\\\">Retour au catalogue</a></div></article>";const copyButton=document.getElementById("copyPublicLink");if(copyButton)copyButton.onclick=async function(){try{await navigator.clipboard.writeText(publicLink);copyButton.textContent="Lien copié";}catch(e){copyButton.textContent=publicLink;}};}catch(e){root.className="grid";root.innerHTML="<div class=\"empty\">"+esc(e.message)+"<p><a href=\"/applications\">Retour au catalogue</a></p></div>";}}if(search)search.addEventListener("input",render);const pathParts=location.pathname.split("/").filter(Boolean);if(pathParts.length>1){let slug="";try{slug=decodeURIComponent(pathParts[1]);}catch(e){}if(slug)loadDetails(slug);else loadCatalogue();}else{loadCatalogue();}})();</script></body></html>`

async function studioHandleApi(request, env, url) {
  const path = url.pathname;
  if (path === "/api/health" && request.method === "GET") {
    let databaseConnected = false;
    if (env.DB) {
      try {
        const ping = await env.DB.prepare("SELECT 1 AS ok").first();
        databaseConnected = !!ping && Number(ping.ok) === 1;
      } catch (error) {
        databaseConnected = false;
      }
    }
    const [usersReady, sessionsReady, appsReady, versionsReady, resourcesReady, resourceFilesReady, releaseFilesReady] = env.DB
      ? await Promise.all([
          studioHasColumns(env, "users", ["id", "email", "password_hash", "role", "status"]),
          studioHasColumns(env, "user_sessions", ["id", "user_id", "token_hash", "expires_at", "revoked_at"]),
          studioHasColumns(env, "published_apps", ["id", "user_id", "name", "slug", "description", "category", "status", "published_at"]),
          studioHasColumns(env, "app_versions", ["id", "app_id", "version_name", "version_code", "file_size", "file_type", "changelog", "status", "created_at"]),
          studioHasColumns(env, "published_resources", ["id", "user_id", "resource_type", "title", "slug", "description", "category", "status", "published_at"]),
          studioHasColumns(env, "resource_files", ["id", "resource_id", "file_name", "mime_type", "file_size", "object_key", "status"]),
          studioHasColumns(env, "app_release_files", ["id", "app_id", "version_name", "version_code", "object_key", "status"])
        ])
      : [false, false, false, false, false, false, false];

    return jsonResponse({
      success: true,
      service: "NKJJEAN STUDIO",
      release: "2026-10-30-public-catalog-v1",
      checks: {
        database_connected: databaseConnected,
        session_secret_configured: typeof env.SESSION_SECRET === "string" && env.SESSION_SECRET.length >= 32,
        account_creation_and_login_ready: databaseConnected && !!env.SESSION_SECRET && usersReady && sessionsReady,
        public_catalog_schema_ready: databaseConnected && appsReady && versionsReady && resourcesReady && resourceFilesReady && releaseFilesReady,
        conversation_tables_ready: databaseConnected ? await studioWorkspaceReady(env) : false,
        own_ai_engine_connected: !!(env.NKJ_AI && typeof env.NKJ_AI.fetch === "function")
      },
      services: {
        private_file_storage: !!env.APP_FILES,
        payment_gateway: "not_configured",
        own_ai_model: env.NKJ_AI && typeof env.NKJ_AI.fetch === "function" ? "engine_connected_model_readiness_unverified" : "not_deployed"
      }
    });
  }

  if (path === "/api/store/apps" && request.method === "GET") {
    const query = studioText(url.searchParams.get("q") || "", 100);
    const result = await env.DB.prepare(
      "SELECT a.id,a.name,a.slug,a.description,a.category,a.published_at,u.email AS developer FROM published_apps a JOIN users u ON u.id=a.user_id WHERE a.status='published' AND (?='' OR a.name LIKE '%'||?||'%' OR a.description LIKE '%'||?||'%' OR a.category LIKE '%'||?||'%') ORDER BY a.published_at DESC LIMIT 100"
    ).bind(query,query,query,query).all();
    return jsonResponse({ success:true, apps:(result.results||[]).map(a=>({
      id:a.id,name:a.name,slug:a.slug,description:a.description,category:a.category,
      developer:a.developer,published_at:a.published_at,url:"/applications/"+encodeURIComponent(a.slug)
    })) });
  }

  if (path.startsWith("/api/store/apps/") && request.method === "GET") {
    const parts = path.split("/").filter(Boolean);
    if (parts.length === 4) {
      const slug = decodeURIComponent(parts[3]);
      const app = await env.DB.prepare(
        "SELECT id,name,slug,description,category,published_at FROM published_apps WHERE slug=? AND status='published' LIMIT 1"
      ).bind(slug).first();
      if (!app) return jsonResponse({ error:"Application introuvable ou non publiée." },404);
      const versions = await env.DB.prepare("SELECT id,version_name,version_code,file_size,changelog,created_at FROM app_versions WHERE app_id=? AND status='approved' ORDER BY version_code DESC").bind(app.id).all();
      const releases = await env.DB.prepare("SELECT id,version_name,version_code,file_name,file_size,changelog,created_at FROM app_release_files WHERE app_id=? AND status='approved' ORDER BY version_code DESC").bind(app.id).all();
      return jsonResponse({ success:true,app,versions:versions.results||[],releases:(releases.results||[]).map(x=>({...x,download_url:"/api/download/app/"+encodeURIComponent(x.id)})) });
    }
    return jsonResponse({ error:"Route publique introuvable." },404);
  }


  // Catalogue public unifié : applications, cours et autres contenus.
  if (path === "/api/store/catalog" && request.method === "GET") {
    const q = studioText(url.searchParams.get("q") || "", 100);
    const type = ["application","course","content"].includes(url.searchParams.get("type")) ? url.searchParams.get("type") : "all";
    const category = studioText(url.searchParams.get("category") || "", 80);
    const limit = Math.max(1,Math.min(60,Number(url.searchParams.get("limit"))||24));
    const offset = Math.max(0,Math.min(10000,Number(url.searchParams.get("offset"))||0));
    const query = "SELECT * FROM ("+
      "SELECT id,'application' AS type,name AS title,slug,description,category,published_at FROM published_apps WHERE status='published' "+
      "UNION ALL SELECT id,resource_type AS type,title,slug,description,category,published_at FROM published_resources WHERE status='published'"+
      ") WHERE (?='' OR lower(title) LIKE '%'||lower(?)||'%' OR lower(description) LIKE '%'||lower(?)||'%' OR lower(category) LIKE '%'||lower(?)||'%') "+
      "AND (?='all' OR type=?) AND (?='' OR lower(category)=lower(?)) ORDER BY published_at DESC LIMIT ? OFFSET ?";
    const rows = await env.DB.prepare(query).bind(q,q,q,q,type,type,category,category,limit,offset).all();
    const stats = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS n FROM published_apps WHERE status='published'").first(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM published_resources WHERE status='published' AND resource_type='course'").first(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM published_resources WHERE status='published' AND resource_type='content'").first()
    ]);
    const countRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM ("+
      "SELECT id,'application' AS type,name AS title,slug,description,category,published_at FROM published_apps WHERE status='published' "+
      "UNION ALL SELECT id,resource_type AS type,title,slug,description,category,published_at FROM published_resources WHERE status='published'"+
      ") WHERE (?='' OR lower(title) LIKE '%'||lower(?)||'%' OR lower(description) LIKE '%'||lower(?)||'%' OR lower(category) LIKE '%'||lower(?)||'%') "+
      "AND (?='all' OR type=?) AND (?='' OR lower(category)=lower(?))").bind(q,q,q,q,type,type,category,category).first();
    return jsonResponse({success:true,items:rows.results||[],total:Number(countRow&&countRow.n||0),limit,offset,counts:{
      applications:Number(stats[0]&&stats[0].n||0),courses:Number(stats[1]&&stats[1].n||0),
      contents:Number(stats[2]&&stats[2].n||0),publications:Number(stats.reduce((n,x)=>n+Number(x&&x.n||0),0))
    }});
  }

  if (path.startsWith("/api/store/resources/") && request.method === "GET") {
    const slug = decodeURIComponent(path.slice("/api/store/resources/".length));
    const resource = await env.DB.prepare("SELECT id,resource_type AS type,title,slug,description,category,published_at FROM published_resources WHERE slug=? AND status='published' LIMIT 1").bind(slug).first();
    if (!resource) return jsonResponse({error:"Cours ou contenu introuvable ou non publié."},404);
    const files = await env.DB.prepare("SELECT id,file_name,mime_type,file_size,created_at FROM resource_files WHERE resource_id=? AND status='approved' ORDER BY created_at DESC").bind(resource.id).all();
    return jsonResponse({success:true,resource,files:(files.results||[]).map(x=>({...x,download_url:"/api/download/resource/"+encodeURIComponent(x.id)}))});
  }

  if (path.startsWith("/api/download/") && request.method === "GET") {
    if (!env.APP_FILES || typeof env.APP_FILES.get !== "function") return jsonResponse({error:"Le stockage sécurisé des fichiers n'est pas encore configuré.",code:"PRIVATE_STORAGE_NOT_CONFIGURED"},503);
    const parts = path.split("/").filter(Boolean);
    if (parts.length !== 4 || !["app","resource"].includes(parts[2])) return jsonResponse({error:"Lien de téléchargement invalide."},404);
    const fileId = parts[3];
    let file = null;
    if (parts[2] === "resource") {
      file = await env.DB.prepare("SELECT f.object_key,f.file_name,f.mime_type,f.file_size FROM resource_files f JOIN published_resources r ON r.id=f.resource_id WHERE f.id=? AND f.status='approved' AND r.status='published' LIMIT 1").bind(fileId).first();
    } else {
      file = await env.DB.prepare("SELECT f.object_key,f.file_name,f.mime_type,f.file_size FROM app_release_files f JOIN published_apps a ON a.id=f.app_id WHERE f.id=? AND f.status='approved' AND a.status='published' LIMIT 1").bind(fileId).first();
    }
    if (!file) return jsonResponse({error:"Fichier introuvable ou non publié."},404);
    const object = await env.APP_FILES.get(file.object_key);
    if (!object) return jsonResponse({error:"Le fichier n'est plus disponible dans le stockage."},404);
    const safeName = String(file.file_name||"telechargement").replace(/[\\r\\n"]/g,"_");
    return new Response(object.body,{status:200,headers:{
      "Content-Type":file.mime_type||"application/octet-stream",
      "Content-Length":String(file.file_size||object.size||0),
      "Content-Disposition":"attachment; filename*=UTF-8''"+encodeURIComponent(safeName),
      "Cache-Control":"private, no-store",
      "X-Content-Type-Options":"nosniff"
    }});
  }

  // API de suivi d'utilisation destinée aux applications clientes.
  if (path === "/v1/project" && request.method === "GET") {
    const key = await studioApiKey(request,env);
    if (!key) return jsonResponse({ error:"Clé API invalide, révoquée ou projet indisponible." },401);
    const project = await env.DB.prepare("SELECT id,name,description FROM projects WHERE id=? LIMIT 1").bind(key.project_id).first();
    const quota = await env.DB.prepare("SELECT * FROM project_quotas WHERE project_id=?").bind(key.project_id).first();
    return jsonResponse({ success:true,project,quotas:quota||null });
  }
  if (path === "/v1/ai" && request.method === "POST") {
    const key = await studioApiKey(request,env);
    if (!key) return jsonResponse({error:"Clé API invalide, révoquée ou projet indisponible."},401);
    const body = await studioReadBody(request);
    const result = await studioGenerateWithOwnAI(env,{
      projectId:key.project_id,
      userId:key.user_id,
      apiKeyId:key.api_key_id,
      prompt:body.prompt || body.message,
      context:body.context || {}
    });
    return jsonResponse(result,result.success?200:result.status);
  }

  if (path === "/v1/usage" && request.method === "POST") {
    const key = await studioApiKey(request,env);
    if (!key) return jsonResponse({ error:"Clé API invalide, révoquée ou projet indisponible." },401);
    const body = await studioReadBody(request);
    const endpoint = studioText(body.endpoint || "application",120);
    const inputTokens = Math.max(0,Math.min(10000000,Number(body.input_tokens)||0));
    const outputTokens = Math.max(0,Math.min(10000000,Number(body.output_tokens)||0));
    const quota = await env.DB.prepare("SELECT * FROM project_quotas WHERE project_id=?").bind(key.project_id).first();
    if (!quota) return jsonResponse({ error:"Quota du projet introuvable." },403);
    const daily = await env.DB.prepare("SELECT COALESCE(SUM(requests_count),0) AS requests,COALESCE(SUM(input_tokens+output_tokens),0) AS tokens FROM usage_logs WHERE project_id=? AND created_at>=strftime('%Y-%m-%dT00:00:00Z','now')").bind(key.project_id).first();
    const month = await env.DB.prepare("SELECT COALESCE(SUM(requests_count),0) AS requests FROM usage_logs WHERE project_id=? AND substr(created_at,1,7)=strftime('%Y-%m','now')").bind(key.project_id).first();
    if ((quota.daily_limit > 0 && daily.requests >= quota.daily_limit) ||
        (quota.monthly_limit > 0 && month.requests >= quota.monthly_limit) ||
        (quota.tokens_limit > 0 && daily.tokens + inputTokens + outputTokens > quota.tokens_limit)) {
      return jsonResponse({ error:"Quota gratuit atteint. La demande n'a pas été enregistrée.",quota_exceeded:true },429);
    }
    const id = randomHex(16), now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO usage_logs (id,project_id,api_key_id,endpoint,requests_count,input_tokens,output_tokens,status_code,created_at) VALUES (?,?,?,?,1,?,?,200,?)").bind(id,key.project_id,key.api_key_id,endpoint,inputTokens,outputTokens,now),
      env.DB.prepare("UPDATE api_keys SET last_used_at=? WHERE id=?").bind(now,key.api_key_id)
    ]);
    return jsonResponse({ success:true,recorded:true,remaining_daily_requests:quota.daily_limit>0?Math.max(0,quota.daily_limit-daily.requests-1):null });
  }

  if (path === "/api/auth/register" || path === "/api/auth/login" ||
      path === "/api/auth/me" || path === "/api/auth/logout") {
    return jsonResponse({ error:"Utilisez les routes d'authentification existantes." },405);
  }

  if (typeof env.SESSION_SECRET !== "string" || env.SESSION_SECRET.length < 32) {
    return jsonResponse({
      error: "Le secret de session n'est pas configuré correctement dans l'environnement Production du Worker.",
      code: "SESSION_SECRET_MISSING",
      required_secret: "SESSION_SECRET",
      minimum_length: 32
    }, 503);
  }

  const user = await studioGetUser(request,env);
  if (!user) return jsonResponse({ error:"Session invalide ou connexion requise." },401);
  const parts = path.split("/").filter(Boolean);

  // Projets personnels.
  if (path === "/api/projects" && request.method === "GET") {
    const result = await env.DB.prepare(
      "SELECT p.id,p.name,p.description,p.status,p.created_at,p.updated_at,q.requests_limit,q.tokens_limit,q.daily_limit,q.monthly_limit,q.free_access,q.valid_until FROM projects p LEFT JOIN project_quotas q ON q.project_id=p.id WHERE p.user_id=? AND p.status='active' ORDER BY p.created_at DESC"
    ).bind(user.id).all();
    return jsonResponse({ success:true,projects:(result.results||[]).map(p=>({
      id:p.id,name:p.name,description:p.description,status:p.status,created_at:p.created_at,updated_at:p.updated_at,
      quotas:{requests_limit:p.requests_limit,tokens_limit:p.tokens_limit,daily_limit:p.daily_limit,monthly_limit:p.monthly_limit,free_access:p.free_access,valid_until:p.valid_until}
    })) });
  }
  if (path === "/api/projects" && request.method === "POST") {
    const body = await studioReadBody(request);
    const name = studioText(body.name,100), description = studioText(body.description,2000);
    if (name.length < 2) return jsonResponse({ error:"Le nom du projet doit contenir au moins 2 caractères." },400);
    const id = randomHex(16), now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO projects (id,user_id,name,description,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)").bind(id,user.id,name,description,now,now),
      env.DB.prepare("INSERT OR IGNORE INTO project_quotas (project_id,requests_limit,tokens_limit,daily_limit,monthly_limit,free_access) VALUES (?,?,?,?,?,?)").bind(id,STUDIO_DEFAULT_QUOTAS.requests_limit,STUDIO_DEFAULT_QUOTAS.tokens_limit,STUDIO_DEFAULT_QUOTAS.daily_limit,STUDIO_DEFAULT_QUOTAS.monthly_limit,STUDIO_DEFAULT_QUOTAS.free_access)
    ]);
    return jsonResponse({ success:true,project:{id,name,description,status:"active"},quotas:STUDIO_DEFAULT_QUOTAS },201);
  }

  if (parts[0] === "api" && parts[1] === "projects" && parts.length >= 3) {
    const projectId = parts[2];
    const project = await studioProjectOwner(env,projectId,user.id);
    if (!project) return jsonResponse({ error:"Projet introuvable ou accès refusé." },404);
    if (parts.length === 3 && request.method === "GET") {
      const quota=await env.DB.prepare("SELECT * FROM project_quotas WHERE project_id=?").bind(projectId).first();
      const usage=await env.DB.prepare("SELECT COUNT(*) AS total FROM usage_logs WHERE project_id=?").bind(projectId).first();
      return jsonResponse({ success:true,project,quotas:quota||null,usage:{log_entries:usage?usage.total:0} });
    }
    if (parts.length === 3 && request.method === "PATCH") {
      const body=await studioReadBody(request);
      const name=body.name===undefined?project.name:studioText(body.name,100);
      const description=body.description===undefined?project.description:studioText(body.description,2000);
      if(name.length<2)return jsonResponse({error:"Nom de projet invalide."},400);
      await env.DB.prepare("UPDATE projects SET name=?,description=?,updated_at=? WHERE id=? AND user_id=?").bind(name,description,new Date().toISOString(),projectId,user.id).run();
      return jsonResponse({success:true,project:{id:projectId,name,description}});
    }
    if (parts.length === 3 && request.method === "DELETE") {
      await env.DB.prepare("UPDATE projects SET status='deleted',updated_at=? WHERE id=? AND user_id=?").bind(new Date().toISOString(),projectId,user.id).run();
      return jsonResponse({success:true,message:"Projet archivé. Ses données restent conservées."});
    }
    if (parts.length === 4 && parts[3] === "api-keys" && request.method === "GET") {
      const result=await env.DB.prepare("SELECT id,name,key_prefix,status,last_used_at,expires_at,created_at,revoked_at FROM api_keys WHERE project_id=? ORDER BY created_at DESC").bind(projectId).all();
      return jsonResponse({success:true,api_keys:result.results||[]});
    }
    if (parts.length === 4 && parts[3] === "api-keys" && request.method === "POST") {
      const body=await studioReadBody(request), name=studioText(body.name||"Clé API",80)||"Clé API";
      const key="nkj_live_"+randomHex(32), hash=await studioHash(key), id=randomHex(16);
      await env.DB.prepare("INSERT INTO api_keys (id,project_id,name,key_prefix,key_hash,status) VALUES (?,?,?,?,?,'active')").bind(id,projectId,name,key.slice(0,16),hash).run();
      return jsonResponse({success:true,id,api_key:key,warning:"Copiez cette clé maintenant. Elle ne sera plus affichée intégralement."},201);
    }
    if (parts.length === 5 && parts[3] === "api-keys" && request.method === "DELETE") {
      const result=await env.DB.prepare("UPDATE api_keys SET status='revoked',revoked_at=? WHERE id=? AND project_id=? AND status='active'").bind(new Date().toISOString(),parts[4],projectId).run();
      if(!result.meta||!result.meta.changes)return jsonResponse({error:"Clé API active introuvable."},404);
      return jsonResponse({success:true,message:"Clé API révoquée."});
    }
    if (parts.length === 4 && parts[3] === "usage" && request.method === "GET") {
      const result=await env.DB.prepare("SELECT id,api_key_id,endpoint,requests_count,input_tokens,output_tokens,status_code,created_at FROM usage_logs WHERE project_id=? ORDER BY created_at DESC LIMIT 100").bind(projectId).all();
      return jsonResponse({success:true,usage:result.results||[]});
    }
    if (parts.length === 4 && parts[3] === "conversations" &&
        (request.method === "GET" || request.method === "POST")) {
      if (!(await studioWorkspaceReady(env))) return jsonResponse({error:"Espace de conversation non initialisé. Exécutez migrations/0002_project_workspace.sql dans la base D1."},503);
      if(request.method==="GET"){
        const r=await env.DB.prepare("SELECT id,title,created_at,updated_at FROM project_conversations WHERE project_id=? AND user_id=? ORDER BY updated_at DESC LIMIT 100").bind(projectId,user.id).all();
        return jsonResponse({success:true,conversations:r.results||[]});
      }
      const body=await studioReadBody(request),title=studioText(body.title||"Nouvelle conversation",120)||"Nouvelle conversation",id=randomHex(16),now=new Date().toISOString();
      await env.DB.prepare("INSERT INTO project_conversations (id,project_id,user_id,title,created_at,updated_at) VALUES (?,?,?,?,?,?)").bind(id,projectId,user.id,title,now,now).run();
      return jsonResponse({success:true,conversation:{id,title,created_at:now}},201);
    }
    if (parts.length === 4 && parts[3] === "ai" && request.method === "POST") {
      if (!(await studioWorkspaceReady(env))) return jsonResponse({error:"L'espace de conversations n'est pas initialisé.",code:"WORKSPACE_NOT_READY"},503);
      const body=await studioReadBody(request),conversationId=studioText(body.conversation_id,80),prompt=studioText(body.prompt || body.message,20000);
      if(!conversationId)return jsonResponse({error:"Sélectionne d'abord une conversation."},400);
      if(!prompt)return jsonResponse({error:"Écris un message avant de l'envoyer à l'IA."},400);
      const conversation=await env.DB.prepare("SELECT id,title FROM project_conversations WHERE id=? AND project_id=? AND user_id=? LIMIT 1").bind(conversationId,projectId,user.id).first();
      if(!conversation)return jsonResponse({error:"Conversation introuvable ou accès refusé."},404);
      const historyResult=await env.DB.prepare("SELECT role,content FROM project_messages WHERE conversation_id=? AND user_id=? ORDER BY created_at DESC LIMIT 20").bind(conversationId,user.id).all();
      const history=(historyResult.results||[]).reverse().map(m=>({role:m.role,content:m.content}));
      const generated=await studioGenerateWithOwnAI(env,{projectId,userId:user.id,prompt,conversationId,history,context:{project_name:project.name,conversation_title:conversation.title}});
      if(!generated.success)return jsonResponse(generated,generated.status||503);
      const now=new Date().toISOString(),userMessageId=randomHex(16),assistantMessageId=randomHex(16);
      await env.DB.batch([
        env.DB.prepare("INSERT INTO project_messages (id,conversation_id,project_id,user_id,role,content,created_at) VALUES (?,?,?,?, 'user',?,?)").bind(userMessageId,conversationId,projectId,user.id,prompt,now),
        env.DB.prepare("INSERT INTO project_messages (id,conversation_id,project_id,user_id,role,content,created_at) VALUES (?,?,?,?, 'assistant',?,?)").bind(assistantMessageId,conversationId,projectId,user.id,generated.answer,now),
        env.DB.prepare("UPDATE project_conversations SET updated_at=? WHERE id=? AND user_id=?").bind(now,conversationId,user.id)
      ]);
      return jsonResponse({success:true,answer:generated.answer,model:generated.model,usage:generated.usage,request_id:generated.request_id},200);
    }
  }

  if (parts[0] === "api" && parts[1] === "conversations" && parts.length === 3) {
    if (!(await studioWorkspaceReady(env))) return jsonResponse({error:"Espace de conversation non initialisé. Exécutez migrations/0002_project_workspace.sql dans D1."},503);
    const conversationId=parts[2];
    const conversation=await env.DB.prepare("SELECT c.id,c.project_id,c.title FROM project_conversations c JOIN projects p ON p.id=c.project_id WHERE c.id=? AND c.user_id=? AND p.user_id=? AND p.status='active' LIMIT 1").bind(conversationId,user.id,user.id).first();
    if(!conversation)return jsonResponse({error:"Conversation introuvable."},404);
    if(request.method==="GET"){
      const r=await env.DB.prepare("SELECT id,role,content,created_at FROM project_messages WHERE conversation_id=? AND user_id=? ORDER BY created_at ASC LIMIT 500").bind(conversationId,user.id).all();
      return jsonResponse({success:true,conversation,messages:r.results||[]});
    }
    if(request.method==="POST"){
      const body=await studioReadBody(request),content=studioText(body.content,20000);
      if(!content)return jsonResponse({error:"Le message ne peut pas être vide."},400);
      const id=randomHex(16),now=new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO project_messages (id,conversation_id,project_id,user_id,role,content,created_at) VALUES (?,?,?,?, 'user',?,?)").bind(id,conversationId,conversation.project_id,user.id,content,now),
        env.DB.prepare("UPDATE project_conversations SET updated_at=? WHERE id=? AND user_id=?").bind(now,conversationId,user.id)
      ]);
      return jsonResponse({success:true,message:{id,role:"user",content,created_at:now},ai_status:"modele_proprietaire_non_deploye",information:"Message enregistré. Le modèle IA propriétaire NKJJEAN devra être entraîné et hébergé avant de répondre."},201);
    }
  }


  // Soumission des cours et autres contenus.
  if (path === "/api/resources" && request.method === "GET") {
    const r = await env.DB.prepare("SELECT id,resource_type AS type,title,slug,description,category,status,rejection_reason,created_at,updated_at,published_at FROM published_resources WHERE user_id=? ORDER BY created_at DESC").bind(user.id).all();
    return jsonResponse({success:true,resources:r.results||[]});
  }
  if (path === "/api/resources" && request.method === "POST") {
    const body=await studioReadBody(request),type=body.type==="course"?"course":body.type==="content"?"content":"";
    const title=studioText(body.title,140),description=studioText(body.description,8000),category=studioText(body.category||"Autres",100),slug=studioSlug(body.slug||title);
    if(!type||title.length<2||slug.length<2)return jsonResponse({error:"Type, titre ou adresse publique invalide."},400);
    const id=randomHex(16);
    try{
      await env.DB.prepare("INSERT INTO published_resources (id,user_id,resource_type,title,slug,description,category,status) VALUES (?,?,?,?,?,?,?,'draft')").bind(id,user.id,type,title,slug,description,category).run();
      return jsonResponse({success:true,resource:{id,type,title,slug,status:"draft"}},201);
    }catch(error){return jsonResponse({error:"Impossible de créer cette fiche. Son adresse existe peut-être déjà."},409);}
  }
  if(parts[0]==="api"&&parts[1]==="resources"&&parts.length>=3){
    const resourceId=parts[2];
    const resource=await env.DB.prepare("SELECT id,user_id,resource_type,title,slug,description,category,status FROM published_resources WHERE id=? AND user_id=? LIMIT 1").bind(resourceId,user.id).first();
    if(!resource)return jsonResponse({error:"Ressource introuvable ou accès refusé."},404);
    if(parts.length===3&&request.method==="PATCH"){
      if(!["draft","rejected"].includes(resource.status))return jsonResponse({error:"Cette ressource ne peut plus être modifiée dans son état actuel."},409);
      const body=await studioReadBody(request),title=body.title===undefined?resource.title:studioText(body.title,140),description=body.description===undefined?resource.description:studioText(body.description,8000),category=body.category===undefined?resource.category:studioText(body.category,100),slug=body.slug===undefined?resource.slug:studioSlug(body.slug);
      if(title.length<2||slug.length<2)return jsonResponse({error:"Titre ou adresse publique invalide."},400);
      try{await env.DB.prepare("UPDATE published_resources SET title=?,slug=?,description=?,category=?,status='draft',rejection_reason=NULL,updated_at=? WHERE id=? AND user_id=?").bind(title,slug,description,category,new Date().toISOString(),resourceId,user.id).run();return jsonResponse({success:true,status:"draft"});}
      catch(error){return jsonResponse({error:"Cette adresse publique est déjà utilisée."},409);}
    }
    if(parts.length===4&&parts[3]==="files"&&request.method==="POST"){
      if(!["draft","rejected"].includes(resource.status))return jsonResponse({error:"Ajoute les fichiers avant de soumettre la ressource."},409);
      if(!env.APP_FILES||typeof env.APP_FILES.put!=="function")return jsonResponse({error:"Le stockage sécurisé des fichiers n'est pas configuré.",code:"PRIVATE_STORAGE_NOT_CONFIGURED"},503);
      const form=await request.formData(),file=form.get("file");
      if(!file||typeof file.arrayBuffer!=="function")return jsonResponse({error:"Sélectionne un fichier à envoyer."},400);
      if(file.size<1||file.size>50*1024*1024)return jsonResponse({error:"Le fichier doit peser au maximum 50 Mo."},413);
      const allowed=new Set(["application/pdf","application/zip","application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/vnd.openxmlformats-officedocument.presentationml.presentation","video/mp4","image/jpeg","image/png"]);
      const mime=String(file.type||"application/octet-stream").toLowerCase();
      if(!allowed.has(mime))return jsonResponse({error:"Format non accepté. Utilise PDF, DOCX, PPTX, ZIP, MP4, JPEG ou PNG."},415);
      const id=randomHex(16),key="resources/"+user.id+"/"+resourceId+"/"+id;
      await env.APP_FILES.put(key,await file.arrayBuffer(),{httpMetadata:{contentType:mime}});
      try{
        await env.DB.prepare("INSERT INTO resource_files (id,resource_id,file_name,mime_type,file_size,object_key,status) VALUES (?,?,?,?,?,?,'pending_review')").bind(id,resourceId,String(file.name||"fichier").slice(0,180),mime,file.size,key).run();
      }catch(error){await env.APP_FILES.delete(key);throw error;}
      return jsonResponse({success:true,file:{id,name:String(file.name||"fichier"),size:file.size,status:"pending_review"}},201);
    }
    if(parts.length===4&&parts[3]==="submit"&&request.method==="POST"){
      if(!["draft","rejected"].includes(resource.status))return jsonResponse({error:"Cette ressource n'est pas dans un état permettant une nouvelle soumission."},409);
      const now=new Date().toISOString();
      await env.DB.prepare("UPDATE published_resources SET status='pending_review',rejection_reason=NULL,updated_at=? WHERE id=? AND user_id=?").bind(now,resourceId,user.id).run();
      return jsonResponse({success:true,status:"pending_review",message:"Votre cours ou contenu a été transmis à l'administration. Il sera public après validation."},202);
    }
    if(parts.length===3&&request.method==="DELETE"){
      if(["published","pending_review","suspended"].includes(resource.status))return jsonResponse({error:"Cette ressource doit d'abord être clôturée par l'administration."},409);
      const files=await env.DB.prepare("SELECT object_key FROM resource_files WHERE resource_id=?").bind(resourceId).all();
      if(env.APP_FILES)for(const file of files.results||[])await env.APP_FILES.delete(file.object_key);
      await env.DB.prepare("DELETE FROM published_resources WHERE id=? AND user_id=?").bind(resourceId,user.id).run();
      return jsonResponse({success:true});
    }
  }

  // Fiches de publication.
  if(path==="/api/publisher"&&request.method==="GET"){
    const r=await env.DB.prepare("SELECT id,name,slug,description,category,status,rejection_reason,created_at,updated_at,published_at FROM published_apps WHERE user_id=? ORDER BY created_at DESC").bind(user.id).all();
    return jsonResponse({success:true,apps:r.results||[]});
  }
  if(path==="/api/publisher"&&request.method==="POST"){
    const body=await studioReadBody(request),name=studioText(body.name,120),description=studioText(body.description,5000),category=studioText(body.category||"Autres",80),slug=studioSlug(body.slug||name);
    if(name.length<2||slug.length<2)return jsonResponse({error:"Nom ou adresse publique invalide."},400);
    const id=randomHex(16);
    try{
      await env.DB.prepare("INSERT INTO published_apps (id,user_id,name,slug,description,category,status) VALUES (?,?,?,?,?,?,'draft')").bind(id,user.id,name,slug,description,category||"Autres").run();
      return jsonResponse({success:true,app:{id,name,slug,status:"draft"}},201);
    }catch(error){return jsonResponse({error:"Impossible de créer la fiche. Cette adresse publique existe peut-être déjà."},409);}
  }
  if(parts[0]==="api"&&parts[1]==="publisher"&&parts.length>=3){
    const appId=parts[2];
    const app=await env.DB.prepare("SELECT id,user_id,name,slug,description,category,status,rejection_reason FROM published_apps WHERE id=? AND user_id=? LIMIT 1").bind(appId,user.id).first();
    if(!app)return jsonResponse({error:"Application introuvable ou accès refusé."},404);
    if(parts.length===3&&request.method==="PATCH"){
      if(app.status!=="draft"&&app.status!=="rejected")return jsonResponse({error:"Cette fiche ne peut pas être modifiée dans son état actuel."},409);
      const body=await studioReadBody(request),name=body.name===undefined?app.name:studioText(body.name,120),description=body.description===undefined?app.description:studioText(body.description,5000),category=body.category===undefined?app.category:studioText(body.category,80),slug=body.slug===undefined?app.slug:studioSlug(body.slug);
      if(name.length<2||slug.length<2)return jsonResponse({error:"Nom ou adresse publique invalide."},400);
      try{
        await env.DB.prepare("UPDATE published_apps SET name=?,slug=?,description=?,category=?,status='draft',rejection_reason=NULL,updated_at=? WHERE id=? AND user_id=?").bind(name,slug,description,category,new Date().toISOString(),appId,user.id).run();
        return jsonResponse({success:true,app:{id:appId,name,slug,status:"draft"}});
      }catch(error){return jsonResponse({error:"Cette adresse publique est déjà utilisée."},409);}
    }
    if(parts.length===3&&request.method==="DELETE"){
      if(["published","pending_review","suspended"].includes(app.status))return jsonResponse({error:"Cette fiche doit d'abord être clôturée par l'administration."},409);
      await env.DB.prepare("DELETE FROM published_apps WHERE id=? AND user_id=?").bind(appId,user.id).run();
      return jsonResponse({success:true,message:"Fiche supprimée."});
    }
    if(parts.length===4&&parts[3]==="payment-order"&&request.method==="POST"){
      return jsonResponse({error:"Le paiement de publication est désactivé tant qu'un opérateur mobile-money n'est pas intégré et vérifié. Aucun transfert ne sera demandé.",receiving_number:"0814620569",payment_gateway:"not_configured"},503);
    }
    if(parts.length===4&&parts[3]==="versions"&&request.method==="GET"){
      const r=await env.DB.prepare("SELECT id,version_name,version_code,file_size,file_type,changelog,status,created_at FROM app_versions WHERE app_id=? ORDER BY version_code DESC").bind(appId).all();
      return jsonResponse({success:true,versions:r.results||[]});
    }

    if(parts.length===4&&parts[3]==="releases"&&request.method==="POST"){
      if(!["draft","rejected"].includes(app.status))return jsonResponse({error:"Dépose une nouvelle version avant de soumettre la fiche."},409);
      if(!env.APP_FILES||typeof env.APP_FILES.put!=="function")return jsonResponse({error:"Le stockage sécurisé des APK n'est pas configuré.",code:"PRIVATE_STORAGE_NOT_CONFIGURED"},503);
      const form=await request.formData(),file=form.get("file"),versionName=studioText(form.get("version_name"),40),versionCode=Number(form.get("version_code")),changelog=studioText(form.get("changelog"),2000);
      if(!file||typeof file.arrayBuffer!=="function"||!String(file.name||"").toLowerCase().endsWith(".apk"))return jsonResponse({error:"Sélectionne un fichier APK valide."},400);
      if(!Number.isInteger(versionCode)||versionCode<1||!versionName)return jsonResponse({error:"Nom et code de version valides obligatoires."},400);
      if(file.size<1||file.size>100*1024*1024)return jsonResponse({error:"L'APK doit peser au maximum 100 Mo."},413);
      const mime="application/vnd.android.package-archive",id=randomHex(16),key="apps/"+user.id+"/"+appId+"/"+id+".apk";
      await env.APP_FILES.put(key,await file.arrayBuffer(),{httpMetadata:{contentType:mime}});
      try{await env.DB.prepare("INSERT INTO app_release_files (id,app_id,version_name,version_code,file_name,mime_type,file_size,changelog,object_key,status) VALUES (?,?,?,?,?,?,?,?,?,'pending_review')").bind(id,appId,versionName,versionCode,String(file.name||"application.apk").slice(0,180),mime,file.size,changelog,key).run();}
      catch(error){await env.APP_FILES.delete(key);return jsonResponse({error:"Cette version existe déjà ou n'a pas pu être enregistrée."},409);}
      return jsonResponse({success:true,release:{id,version_name:versionName,version_code:versionCode,status:"pending_review"}},201);
    }
    if(parts.length===4&&parts[3]==="versions"&&request.method==="POST"){
      return jsonResponse({error:"Le stockage privé des APK n'est pas activé. Aucun fichier ne peut être téléversé dans cette version.",storage:"not_configured"},503);
    }
    if(parts.length===4&&parts[3]==="submit"&&request.method==="POST"){
      if(app.status!=="draft")return jsonResponse({error:"Seule une fiche en brouillon peut être soumise."},409);
      const now=new Date().toISOString();
      await env.DB.prepare("UPDATE published_apps SET status='pending_review',rejection_reason=NULL,updated_at=? WHERE id=? AND user_id=? AND status='draft'").bind(now,appId,user.id).run();
      return jsonResponse({success:true,status:"pending_review",message:"Votre fiche de présentation a été transmise à l'administration. Elle sera visible publiquement après validation."},202);
    }
  }

  // Administration : compte administrateur défini explicitement dans D1.
  if(parts[0]==="api"&&parts[1]==="admin"){
    if(user.role!=="admin")return jsonResponse({error:"Accès réservé à l'administration."},403);
    if(parts.length===5&&parts[2]==="apps"&&parts[4]==="releases"&&request.method==="GET"){
      const r=await env.DB.prepare("SELECT id,version_name,version_code,file_name,file_size,changelog,status,created_at FROM app_release_files WHERE app_id=? ORDER BY version_code DESC").bind(parts[3]).all();
      return jsonResponse({success:true,releases:(r.results||[]).map(x=>({...x,review_download:"/api/admin/download/app/"+encodeURIComponent(x.id)}))});
    }
    if(parts.length===5&&parts[2]==="resources"&&parts[4]==="files"&&request.method==="GET"){
      const r=await env.DB.prepare("SELECT id,file_name,mime_type,file_size,status,created_at FROM resource_files WHERE resource_id=? ORDER BY created_at DESC").bind(parts[3]).all();
      return jsonResponse({success:true,files:(r.results||[]).map(x=>({...x,review_download:"/api/admin/download/resource/"+encodeURIComponent(x.id)}))});
    }
    if(parts.length===5&&parts[2]==="download"&&["app","resource"].includes(parts[3])&&request.method==="GET"){
      if(!env.APP_FILES||typeof env.APP_FILES.get!=="function")return jsonResponse({error:"Stockage R2 non configuré."},503);
      const file=parts[3]==="app"
        ? await env.DB.prepare("SELECT object_key,file_name,mime_type,file_size FROM app_release_files WHERE id=? LIMIT 1").bind(parts[4]).first()
        : await env.DB.prepare("SELECT object_key,file_name,mime_type,file_size FROM resource_files WHERE id=? LIMIT 1").bind(parts[4]).first();
      if(!file)return jsonResponse({error:"Fichier introuvable."},404);
      const object=await env.APP_FILES.get(file.object_key);
      if(!object)return jsonResponse({error:"Fichier absent du stockage."},404);
      const safeName=String(file.file_name||"fichier").replace(/[\\r\\n"]/g,"_");
      return new Response(object.body,{headers:{"Content-Type":file.mime_type||"application/octet-stream","Content-Length":String(file.file_size||object.size||0),"Content-Disposition":"attachment; filename*=UTF-8''"+encodeURIComponent(safeName),"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
    }
    if(parts.length===3&&parts[2]==="overview"&&request.method==="GET"){
      const c=await Promise.all([
        env.DB.prepare("SELECT COUNT(*) AS n FROM users").first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM projects WHERE status='active'").first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM published_apps WHERE status='published'").first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM published_apps WHERE status='pending_review'").first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM published_resources WHERE resource_type='course'").first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM published_resources WHERE resource_type='course' AND status='published'").first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM published_resources WHERE resource_type='course' AND status='pending_review'").first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM published_resources WHERE resource_type='content'").first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM published_resources WHERE resource_type='content' AND status='published'").first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM published_resources WHERE resource_type='content' AND status='pending_review'").first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM published_apps").first()
      ]);
      return jsonResponse({success:true,counts:{
        users:c[0].n,active_projects:c[1].n,published_apps:c[2].n,pending_reviews:Number(c[3].n)+Number(c[6].n)+Number(c[9].n),
        total_apps:c[10].n,total_courses:c[4].n,published_courses:c[5].n,pending_courses:c[6].n,
        total_contents:c[7].n,published_contents:c[8].n,pending_contents:c[9].n,
        published_total:Number(c[2].n)+Number(c[5].n)+Number(c[8].n)
      }});
    }
    if(parts.length===4&&parts[2]==="resources"&&parts[3]==="pending"&&request.method==="GET"){
      const r=await env.DB.prepare("SELECT r.id,r.user_id,r.resource_type AS type,r.title,r.slug,r.description,r.category,r.status,r.created_at,u.email AS owner_email,(SELECT COUNT(*) FROM resource_files f WHERE f.resource_id=r.id AND f.status='pending_review') AS pending_files FROM published_resources r JOIN users u ON u.id=r.user_id WHERE r.status='pending_review' ORDER BY r.created_at").all();
      return jsonResponse({success:true,resources:r.results||[]});
    }
    if(parts.length===4&&parts[2]==="resources"&&request.method==="POST"){
      const resourceId=parts[3],body=await studioReadBody(request),decision=studioText(body.decision,20),comment=studioText(body.comment||"",2000);
      if(!["approved","rejected","suspended"].includes(decision))return jsonResponse({error:"Décision invalide."},400);
      const resource=await env.DB.prepare("SELECT id,slug,status FROM published_resources WHERE id=? LIMIT 1").bind(resourceId).first();
      if(!resource)return jsonResponse({error:"Ressource introuvable."},404);
      if(decision==="approved"&&resource.status!=="pending_review")return jsonResponse({error:"Seules les ressources en attente peuvent être approuvées."},409);
      const now=new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare("UPDATE published_resources SET status=?,rejection_reason=?,published_at=CASE WHEN ?='approved' THEN ? ELSE published_at END,updated_at=? WHERE id=?").bind(decision,decision==="approved"?null:comment,decision,now,now,resourceId),
        env.DB.prepare("UPDATE resource_files SET status=? WHERE resource_id=? AND status='pending_review'").bind(decision==="approved"?"approved":"rejected",resourceId),
        env.DB.prepare("INSERT INTO resource_reviews (id,resource_id,reviewed_by,decision,comment) VALUES (?,?,?,?,?)").bind(randomHex(16),resourceId,user.id,decision,comment)
      ]);
      return jsonResponse({success:true,status:decision,public_url:decision==="approved"?"/publications/"+encodeURIComponent(resource.slug):null});
    }
    if(parts.length===4&&parts[2]==="publications"&&parts[3]==="published"&&request.method==="GET"){
      const [apps,resources]=await Promise.all([
        env.DB.prepare("SELECT id,name AS title,slug,category,'application' AS type,published_at FROM published_apps WHERE status='published' ORDER BY published_at DESC").all(),
        env.DB.prepare("SELECT id,title,slug,category,resource_type AS type,published_at FROM published_resources WHERE status='published' ORDER BY published_at DESC").all()
      ]);
      return jsonResponse({success:true,items:[...(apps.results||[]),...(resources.results||[])].sort((a,b)=>String(b.published_at||"").localeCompare(String(a.published_at||"")))});
    }
    if(parts.length===4&&parts[2]==="publications"&&parts[3]==="pending"&&request.method==="GET"){
      const r=await env.DB.prepare("SELECT a.id,a.user_id,a.name,a.slug,a.description,a.category,a.status,a.created_at,u.email AS owner_email,(SELECT COUNT(*) FROM app_release_files f WHERE f.app_id=a.id AND f.status='pending_review') AS pending_files FROM published_apps a JOIN users u ON u.id=a.user_id WHERE a.status='pending_review' ORDER BY a.created_at").all();
      return jsonResponse({success:true,apps:r.results||[]});
    }
    if(parts.length===3&&parts[2]==="publication-orders"&&request.method==="GET"){
      const r=await env.DB.prepare("SELECT o.id,o.app_id,o.user_id,o.country,o.phone_number,o.receiving_number,o.amount_minor,o.currency,o.payment_provider,o.provider_reference,o.status,o.verified_at,o.created_at FROM app_publication_orders o ORDER BY o.created_at DESC LIMIT 200").all();
      return jsonResponse({success:true,orders:r.results||[],note:"Une commande en attente ne constitue jamais une preuve de paiement."});
    }
    if(parts.length===4&&parts[2]==="apps"&&request.method==="POST"){
      const appId=parts[3],body=await studioReadBody(request),decision=studioText(body.decision,20),comment=studioText(body.comment||"",2000);
      if(!["approved","rejected","suspended"].includes(decision))return jsonResponse({error:"Décision invalide."},400);
      const app=await env.DB.prepare("SELECT id,slug,status FROM published_apps WHERE id=? LIMIT 1").bind(appId).first();
      if(!app)return jsonResponse({error:"Application introuvable."},404);
      if(decision==="approved"&&app.status!=="pending_review")return jsonResponse({error:"Seules les fiches en attente peuvent être approuvées."},409);
      const now=new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare("UPDATE published_apps SET status=?,rejection_reason=?,published_at=CASE WHEN ?='approved' THEN ? ELSE published_at END,updated_at=? WHERE id=?").bind(decision,decision==="approved"?null:comment,decision,now,now,appId),
        env.DB.prepare("UPDATE app_release_files SET status=?,approved_at=CASE WHEN ?='approved' THEN ? ELSE approved_at END WHERE app_id=? AND status='pending_review'").bind(decision==="approved"?"approved":"rejected",decision,now,appId),
        env.DB.prepare("INSERT INTO app_publication_reviews (id,app_id,version_id,reviewed_by,decision,comment) VALUES (?,?,NULL,?,?,?)").bind(randomHex(16),appId,user.id,decision,comment)
      ]);
      return jsonResponse({success:true,status:decision,public_url:decision==="approved"?"/applications/"+encodeURIComponent(app.slug):null,message:decision==="approved"?"La fiche de présentation est maintenant publique.":"La décision administrative a été enregistrée."});
    }
  }

  return jsonResponse({error:"Route API introuvable."},404);
}


// ==================== WORKER PRINCIPAL ====================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type,Authorization,X-API-Key",
        "Access-Control-Max-Age": "86400"
      }});
    }


    if (url.pathname === "/robots.txt" && request.method === "GET") {
      return new Response("User-agent: *\nAllow: /\nDisallow: /app\nDisallow: /admin\nDisallow: /studio/\nDisallow: /api/\nSitemap: "+url.origin+"/sitemap.xml\\n",{headers:{"Content-Type":"text/plain;charset=UTF-8","Cache-Control":"public, max-age=3600"}});
    }
    if (url.pathname === "/sitemap.xml" && request.method === "GET") {
      if (!env.DB) return new Response("<?xml version=\"1.0\" encoding=\"UTF-8\"?><urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\"></urlset>",{headers:{"Content-Type":"application/xml;charset=UTF-8"}});
      const [apps,resources]=await Promise.all([
        env.DB.prepare("SELECT slug,published_at FROM published_apps WHERE status='published'").all(),
        env.DB.prepare("SELECT slug,resource_type,published_at FROM published_resources WHERE status='published'").all()
      ]);
      const xmlEscape=value=>String(value||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
      const entries=[["/",new Date().toISOString()],["/applications",new Date().toISOString()],["/cours",new Date().toISOString()],["/publications",new Date().toISOString()]];
      for(const item of apps.results||[])entries.push(["/applications/"+encodeURIComponent(item.slug),item.published_at]);
      for(const item of resources.results||[])entries.push([(item.resource_type==="course"?"/cours/":"/publications/")+encodeURIComponent(item.slug),item.published_at]);
      const body='<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+entries.map(x=>"<url><loc>"+xmlEscape(url.origin+x[0])+"</loc>"+(x[1]?"<lastmod>"+xmlEscape(x[1])+"</lastmod>":"")+"</url>").join("")+"</urlset>";
      return new Response(body,{headers:{"Content-Type":"application/xml;charset=UTF-8","Cache-Control":"public, max-age=900"}});
    }

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(STUDIO_HOME_HTML, { headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/docs" && request.method === "GET") {
      return new Response(STUDIO_DOCS_HTML, { headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/admin" && request.method === "GET") {
      return new Response(STUDIO_ADMIN_HTML, { headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/app" && request.method === "GET") {
      return new Response(STUDIO_APP_HTML, { headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "no-store" } });
    }
    if (url.pathname.startsWith("/studio/") && request.method === "GET") {
      return new Response(STUDIO_WORKSPACE_HTML, { headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "no-store" } });
    }
    if ((url.pathname === "/applications" || url.pathname.startsWith("/applications/") ||
         url.pathname === "/cours" || url.pathname.startsWith("/cours/") ||
         url.pathname === "/publications" || url.pathname.startsWith("/publications/")) && request.method === "GET") {
      let html=STUDIO_STORE_HTML;
      const pageParts=url.pathname.split("/").filter(Boolean);
      if(pageParts.length===2){
        const slug=decodeURIComponent(pageParts[1]);
        const isApp=pageParts[0]==="applications";
        const item=isApp
          ? await env.DB.prepare("SELECT name AS title,description,slug FROM published_apps WHERE slug=? AND status='published' LIMIT 1").bind(slug).first()
          : await env.DB.prepare("SELECT title,description,slug FROM published_resources WHERE slug=? AND status='published' LIMIT 1").bind(slug).first();
        if(item){
          const safeTitle=String(item.title||"NKJJEAN STUDIO").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
          const safeDescription=String(item.description||"Publication NKJJEAN STUDIO").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])).slice(0,300);
          html=html.replace("<title>Catalogue public — NKJJEAN STUDIO</title>","<title>"+safeTitle+" — NKJJEAN STUDIO</title>")
            .replace('content="Catalogue public NKJJEAN STUDIO : applications, cours et ressources numériques validés."','content="'+safeDescription+'"')
            .replace('<meta name="robots" content="index,follow">','<meta name="robots" content="index,follow"><link rel="canonical" href="'+url.origin+url.pathname+'">');
        }
      }
      return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "no-store", "X-Content-Type-Options":"nosniff" } });
    }
    if ((url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/auth/")) ||
        url.pathname === "/v1/project" || url.pathname === "/v1/usage" || url.pathname === "/v1/ai") {
      // D1 est nécessaire aux API métier ; le secret de session n'est requis
      // que pour les routes authentifiées par session et non pour le catalogue,
      // la santé du service ou les requêtes signées par clé API.
      if (!env.DB) return jsonResponse({
        error: "La base D1 n'est pas liée à ce Worker.",
        code: "D1_BINDING_MISSING",
        required_binding: "DB",
        required_database: "nkjjean-studio-db"
      }, 503);
      try { return await studioHandleApi(request, env, url); }
      catch (error) {
        if (error && error.message === "INVALID_JSON") return jsonResponse({ error: "Corps JSON invalide." }, 400);
        if (error && error.message === "PAYLOAD_TOO_LARGE") return jsonResponse({ error: "Requête trop volumineuse." }, 413);
        return jsonResponse({ error: "Une erreur interne est survenue. Réessayez plus tard." }, 500);
      }
    }

    // ==================== PAGE D'ACCUEIL ====================

    if (url.pathname === "/") {
      const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="description" content="Plateforme de développement et de gestion des API">
<title>NKJJEAN-STUDIO | Construisez vos applications</title>

<style>
:root {
  --bg-color: #07111f;
  --text-color: #c9d1d9;
  --panel-bg: #0d1117;
  --line-color: rgba(157, 190, 230, 0.16);
}

* {
  box-sizing: border-box;
}

html {
  scroll-behavior: smooth;
}

body {
  margin: 0;
  background: var(--bg-color);
  color: var(--text-color);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  line-height: 1.65;
}

.content {
  max-width: 840px;
  margin: 0 auto;
  padding: 56px 24px;
}

.hero {
  text-align: center;
  padding-bottom: 56px;
}

h1 {
  font-size: 3rem;
  line-height: 1.1;
  margin-bottom: 1.5rem;
  background: linear-gradient(135deg, #58a6ff 0%, #1f6feb 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.panel {
  background-color: var(--panel-bg);
  border: 1px solid var(--line-color);
  border-radius: 12px;
  padding: 40px;
  margin: 40px 0;
}

.btn {
  display: inline-block;
  background-color: #58a6ff;
  color: #0d1117;
  font-weight: 750;
  padding: 12px 24px;
  border-radius: 8px;
  text-decoration: none;
  transition: background-color 0.2s ease;
}

.btn:hover {
  background-color: #79c0ff;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 24px;
  margin-top: 40px;
}

@media (max-width: 600px) {
  .content {
    padding: 32px 16px;
  }

  h1 {
    font-size: 2.2rem;
  }

  .panel {
    padding: 24px;
  }
}
</style>
</head>

<body>
<div class="content">

  <div class="hero">
    <h1>NKJJEAN-STUDIO</h1>
    <p>Plateforme de développement et de gestion des API pour vos applications.</p>
  </div>

  <div class="panel">
    <h2>Prêt à commencer ?</h2>
    <p>Découvrez notre documentation et intégrez nos outils puissants.</p>
    <a href="/docs" class="btn">En savoir plus</a>
  </div>

  <div class="grid">

    <div class="panel">
      <h3>Haute Sécurité</h3>
      <p>Authentification robuste avec hachage sécurisé des mots de passe.</p>
    </div>

    <div class="panel">
      <h3>Performance Cloud</h3>
      <p>Déploiement rapide sur le réseau mondial Cloudflare.</p>
    </div>

    <div class="panel">
      <h3>Évolutif</h3>
      <p>Conçu pour accompagner la montée en charge de vos projets.</p>
    </div>

  </div>
</div>
</body>
</html>`;

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
