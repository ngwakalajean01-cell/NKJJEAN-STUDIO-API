
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
      iterations: 250000,
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

  return `pbkdf2-sha256$250000$${saltHex}$${hashHex}`;
}

async function verifyPassword(password, stored) {
  if (typeof stored !== "string") return false;

  const parts = stored.split("$");

  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") {
    return false;
  }

  const iterations = Number(parts[1]);
  const saltHex = parts[2];
  const expectedHex = parts[3];

  if (
    !Number.isInteger(iterations) ||
    iterations < 100000 ||
    iterations > 1000000 ||
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
    "SELECT s.user_id,s.expires_at,u.email,u.role,u.status FROM user_sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? LIMIT 1"
  ).bind(hash, new Date().toISOString()).first();
  if (!session || session.status !== "active") return null;
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

const STUDIO_HOME_HTML = '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="NKJJEAN STUDIO : projets, API et applications."><title>NKJJEAN STUDIO</title><style>:root{color-scheme:dark;--line:#203c57;--text:#e8f1fb;--muted:#9db1c8;--blue:#58aaff;--cyan:#65e0df}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 80% 5%,#12365a 0,transparent 34%),linear-gradient(145deg,#06101c,#071629 65%,#08111f);color:var(--text);font:16px/1.65 system-ui,sans-serif}a{color:inherit;text-decoration:none}.wrap{width:min(1120px,calc(100% - 36px));margin:auto}.top{display:flex;align-items:center;justify-content:space-between;padding:22px 0;border-bottom:1px solid #ffffff16}.brand{font-weight:900;letter-spacing:.08em}.brand span{color:var(--cyan)}nav{display:flex;gap:20px;align-items:center;color:var(--muted);font-size:14px}.btn{display:inline-flex;align-items:center;justify-content:center;padding:11px 18px;border-radius:10px;font-weight:800;background:linear-gradient(110deg,var(--blue),var(--cyan));color:#061321}.alt{background:#142a40;color:var(--text);border:1px solid var(--line)}.hero{padding:76px 0 60px;display:grid;grid-template-columns:1.15fr .85fr;gap:40px;align-items:center}.eyebrow{color:var(--cyan);font-size:12px;font-weight:800;letter-spacing:.19em;text-transform:uppercase}.hero h1{font-size:clamp(42px,6vw,70px);line-height:1.04;margin:16px 0 20px;letter-spacing:-.045em}.hero h1 b{color:var(--blue)}.lead{font-size:19px;color:var(--muted)}.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:28px}.visual{min-height:310px;border:1px solid #4c85bb55;border-radius:26px;padding:24px;background:linear-gradient(145deg,#133353aa,#0b1d30dd);box-shadow:0 24px 80px #0006;position:relative;overflow:hidden}.visual:before,.visual:after{content:"";position:absolute;border:1px solid #55a8ff44;border-radius:50%;width:250px;height:250px;right:-70px;top:-75px}.visual:after{width:170px;height:170px;right:70px;top:125px;border-color:#65e0df55}.codebox{position:relative;z-index:1;margin-top:22px;background:#06111fdd;border:1px solid #345372;border-radius:14px;padding:18px;color:#c7e6ff;font:13px/2 ui-monospace,monospace}.green{color:#7de2c2}.blue{color:#73baff}.section{padding:46px 0}.section h2{font-size:clamp(28px,4vw,40px);line-height:1.15;margin:8px 0 14px}.sub{color:var(--muted);max-width:760px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:25px}.card{padding:23px;border:1px solid var(--line);background:linear-gradient(150deg,#10243a,#0b1929);border-radius:17px}.symbol{width:42px;height:42px;display:grid;place-items:center;border-radius:12px;background:#173b5d;color:var(--cyan);font-size:20px}.card h3{margin:14px 0 7px}.card p{color:var(--muted);margin:0}.strip{border:1px solid #315474;background:#0b1d2e;border-radius:20px;padding:27px;display:flex;align-items:center;justify-content:space-between;gap:18px}.steps{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:20px}.step{border-top:2px solid var(--blue);padding:15px 12px;background:#0c1b2b;color:var(--muted)}.step strong{display:block;color:#fff}.foot{border-top:1px solid #ffffff18;margin-top:48px;padding:27px 0;color:var(--muted);font-size:13px;display:flex;flex-wrap:wrap;justify-content:space-between;gap:18px}.foot a{color:#b9d9f6}@media(max-width:780px){nav{gap:12px}nav a:not(.navbtn){display:none}.hero{grid-template-columns:1fr;padding:50px 0 30px}.grid{grid-template-columns:1fr}.steps{grid-template-columns:1fr 1fr}.strip{align-items:flex-start;flex-direction:column}}</style></head><body><div class="wrap"><header class="top"><a class="brand" href="/">NKJJEAN<span> STUDIO</span></a><nav><a href="/docs">En savoir plus</a><a href="/applications">Applications</a><a href="#contact">Contact</a><a class="navbtn btn alt" href="/app">Mon espace</a></nav></header><main><section class="hero"><div><div class="eyebrow">Studio numérique indépendant</div><h1>Vos projets.<br><b>Vos API.</b><br>Vos applications.</h1><p class="lead">Une plateforme pour organiser vos projets numériques, gérer leurs accès API, suivre leur utilisation et préparer la publication de vos applications Android.</p><div class="actions"><a class="btn" href="/app">Créer mon espace</a><a class="btn alt" href="/docs">En savoir plus</a></div></div><div class="visual"><div class="eyebrow">Votre environnement de travail</div><div class="codebox"><span class="green">PROJET</span> / application-mobile<br><span class="blue">API</span> — clé privée par projet<br><span class="blue">QUOTAS</span> — suivi et historique<br><span class="blue">PUBLICATION</span> — validation administrative<br><br><span class="green">✓</span> Données séparées par propriétaire<br><span class="green">✓</span> Accès sécurisés par session</div></div></section><section class="section"><div class="eyebrow">Un environnement organisé</div><h2>Tout commence dans votre espace personnel.</h2><p class="sub">Créez des projets distincts, gérez leurs informations et délivrez des clés API séparées. Chaque compte ne voit que ses propres projets et son historique.</p><div class="grid"><article class="card"><div class="symbol">⌘</div><h3>Gestion des projets</h3><p>Créez, consultez, modifiez et archivez vos projets dans un espace personnel.</p></article><article class="card"><div class="symbol">⌘</div><h3>Clés API privées</h3><p>Une clé par projet, affichée une seule fois à sa création et révocable à tout moment.</p></article><article class="card"><div class="symbol">◷</div><h3>Quotas et activité</h3><p>Suivez les limites d’utilisation et l’historique des requêtes enregistrées.</p></article><article class="card"><div class="symbol">▤</div><h3>Publication d’applications</h3><p>Préparez une fiche, soumettez-la au contrôle et suivez la décision administrative.</p></article><article class="card"><div class="symbol">⬡</div><h3>Catalogue public</h3><p>Les applications approuvées apparaissent avec leurs informations et versions autorisées.</p></article><article class="card"><div class="symbol">✧</div><h3>IA propriétaire NKJJEAN</h3><p>Le modèle devra être entraîné et hébergé sur une infrastructure dédiée avant de générer des réponses. Aucune IA externe n’est utilisée.</p></article></div></section><section class="section"><div class="strip"><div><div class="eyebrow">Parcours de publication</div><h2>Une publication contrôlée.</h2><p class="sub">Fiche, version, confirmation du paiement et validation administrative : une application n’est publique qu’après les contrôles requis.</p></div><a class="btn" href="/applications">Voir les applications</a></div><div class="steps"><div class="step"><strong>1. Préparer</strong>Créer la fiche et ses informations.</div><div class="step"><strong>2. Déposer</strong>Ajouter un APK lorsque le stockage sécurisé sera activé.</div><div class="step"><strong>3. Vérifier</strong>Contrôler les frais et les éléments soumis.</div><div class="step"><strong>4. Décider</strong>Validation ou refus par l’administration.</div></div></section><section class="section"><div class="strip"><div><div class="eyebrow">Démarrer maintenant</div><h2>Créez votre compte NKJJEAN STUDIO.</h2><p class="sub">Les projets commencent avec les quotas gratuits initiaux. Les services payants ne seront activés qu’après leur configuration réelle.</p></div><a class="btn" href="/app">Ouvrir mon espace</a></div></section></main><footer id="contact" class="foot"><div>© NKJJEAN STUDIO — Plateforme numérique.</div><div><a href="https://wa.me/243992049808">WhatsApp</a> · <a href="tel:+243992049808">Téléphone</a> · <a href="mailto:ngwakalajean01@gmail.com">Gmail</a></div></footer></div></body></html>';

const STUDIO_DOCS_HTML = '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>En savoir plus — NKJJEAN STUDIO</title><style>body{margin:0;background:#07111f;color:#e8f1fb;font:16px/1.7 system-ui,sans-serif}.wrap{max-width:900px;margin:auto;padding:30px 22px 70px}a{color:#70c2ff}h1{font-size:40px}h2{margin-top:34px;color:#8fd5ff}.panel{background:#0e2033;border:1px solid #25435f;border-radius:15px;padding:22px;margin:16px 0;color:#b8c9dc}</style></head><body><main class="wrap"><a href="/">← Retour à l’accueil</a><h1>Comprendre NKJJEAN STUDIO</h1><p>Votre environnement numérique pour créer et gérer des projets, des clés API, des quotas et la publication contrôlée d’applications.</p><h2>Comptes et sécurité</h2><div class="panel">Chaque compte possède ses projets. Les mots de passe sont protégés par PBKDF2-SHA-256 et les sessions par des jetons HMAC. Ne partagez jamais votre jeton ni vos clés API.</div><h2>Projets et API</h2><div class="panel">Chaque projet possède ses informations, ses quotas et ses clés API. Une clé complète ne s’affiche qu’une seule fois lors de sa création. Une clé peut être révoquée.</div><h2>IA propriétaire</h2><div class="panel">Le modèle propre à NKJJEAN STUDIO n’est pas encore entraîné ni hébergé. Aucun service Gemini, OpenAI ou autre fournisseur externe n’est appelé. Le modèle nécessitera une infrastructure de calcul et un entraînement dédiés.</div><h2>Publication</h2><div class="panel">Les applications ne deviennent publiques qu’après validation administrative. Le stockage privé des APK et la confirmation automatique des paiements ne sont pas activés dans cette version.</div><h2>Paiements et contact</h2><div class="panel">Numéro de réception prévu : <strong>0814620569</strong>. Son enregistrement ne confirme aucun transfert. Une confirmation réelle nécessite une connexion vérifiée à un opérateur mobile-money.<br>WhatsApp : <a href="https://wa.me/243992049808">0992049808</a><br>Email : <a href="mailto:ngwakalajean01@gmail.com">ngwakalajean01@gmail.com</a></div><p><a href="/app">Ouvrir mon espace</a> · <a href="/applications">Catalogue public</a></p></main></body></html>';

const STUDIO_APP_HTML = '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mon espace — NKJJEAN STUDIO</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:#07111f;color:#eaf3ff;font:15px/1.6 system-ui,sans-serif}.wrap{max-width:1000px;margin:auto;padding:24px 18px 70px}a{color:#85caff}.panel,.project{background:#0e2033;border:1px solid #25435f;border-radius:15px;padding:20px;margin:16px 0}.muted{color:#9db1c8}.row{display:flex;gap:10px;flex-wrap:wrap}.field{display:block;width:100%;max-width:460px;margin:10px 0}.field input,.field textarea{width:100%;padding:12px;border:1px solid #34516d;border-radius:9px;background:#071726;color:#fff}.btn{border:0;border-radius:9px;background:#56afff;color:#061321;font-weight:800;padding:11px 16px;cursor:pointer}.secondary{background:#1b3854;color:#eaf3ff;border:1px solid #34516d}.danger{background:#602d38;color:white}.hidden{display:none}.token{background:#06101b;border:1px dashed #65d9c2;padding:12px;overflow-wrap:anywhere;color:#9fe8d2}.project{display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px}.project h3{margin:0 0 5px}.project p{margin:0;color:#a9bdd2}</style></head><body><main class="wrap"><header class="row" style="justify-content:space-between"><strong>NKJJEAN STUDIO</strong><span><a href="/">Accueil</a> · <a href="/applications">Applications</a> · <a href="/docs">Aide</a></span></header><section id="auth" class="panel"><h1>Votre espace personnel</h1><p class="muted">Connectez-vous ou créez votre compte.</p><div class="row"><button class="btn" id="showLogin">Connexion</button><button class="btn secondary" id="showRegister">Créer un compte</button></div><form id="loginForm"><h2>Connexion</h2><label class="field">Adresse email<input name="email" type="email" autocomplete="email" required></label><label class="field">Mot de passe<input name="password" type="password" autocomplete="current-password" required></label><button class="btn">Se connecter</button></form><form id="registerForm" class="hidden"><h2>Créer un compte</h2><label class="field">Adresse email<input name="email" type="email" required></label><label class="field">Mot de passe (8 caractères minimum)<input name="password" type="password" minlength="8" required></label><button class="btn">Créer mon compte</button></form><p id="authMessage" class="muted" aria-live="polite"></p></section><section id="dashboard" class="hidden"><div class="panel row" style="justify-content:space-between"><div><div class="muted">Compte connecté</div><strong id="userEmail"></strong></div><button class="btn secondary" id="logout">Déconnexion</button></div><div class="panel"><h2>Créer un projet</h2><form id="projectForm"><label class="field">Nom du projet<input name="name" maxlength="100" required></label><label class="field">Description<textarea name="description" maxlength="2000"></textarea></label><button class="btn">Créer le projet</button></form><p class="muted">Quotas gratuits initiaux : 1 000 requêtes, 100 000 jetons, 100 requêtes quotidiennes et 1 000 mensuelles par projet.</p></div><div class="panel"><h2>Mes projets</h2><div id="projects" class="muted">Chargement…</div></div><div id="keyNotice" class="panel hidden"></div><div class="panel"><h2>Publication de mes applications</h2><p class="muted">Les fiches peuvent être préparées. Le dépôt APK attend un stockage privé adapté. Le paiement attend une intégration mobile-money vérifiée.</p><form id="appForm"><label class="field">Nom de l’application<input name="name" required maxlength="120"></label><label class="field">Catégorie<input name="category" value="Autres" maxlength="80"></label><label class="field">Description<textarea name="description" maxlength="5000"></textarea></label><button class="btn">Créer la fiche</button></form><div id="myApps"></div></div></section></main><script>(function(){const auth=document.getElementById("auth"),dash=document.getElementById("dashboard"),msg=document.getElementById("authMessage"),projects=document.getElementById("projects");let token=sessionStorage.getItem("nkj_session")||"";function esc(v){return String(v==null?"":v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c]));}async function api(path,opt){opt=opt||{};opt.headers=opt.headers||{};opt.headers["Content-Type"]=opt.headers["Content-Type"]||"application/json";if(token)opt.headers.Authorization="Bearer "+token;const r=await fetch(path,opt);let d={};try{d=await r.json();}catch(e){}if(!r.ok)throw new Error(d.error||"La demande a échoué.");return d;}document.getElementById("showLogin").onclick=()=>{document.getElementById("loginForm").classList.remove("hidden");document.getElementById("registerForm").classList.add("hidden");};document.getElementById("showRegister").onclick=()=>{document.getElementById("registerForm").classList.remove("hidden");document.getElementById("loginForm").classList.add("hidden");};document.getElementById("registerForm").onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);try{await api("/api/auth/register",{method:"POST",body:JSON.stringify({email:f.get("email"),password:f.get("password")})});msg.textContent="Compte créé. Connectez-vous.";document.getElementById("loginForm").classList.remove("hidden");document.getElementById("registerForm").classList.add("hidden");e.target.reset();}catch(x){msg.textContent=x.message;}};document.getElementById("loginForm").onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);try{const d=await api("/api/auth/login",{method:"POST",body:JSON.stringify({email:f.get("email"),password:f.get("password")})});token=d.token;sessionStorage.setItem("nkj_session",token);await loadDashboard();}catch(x){msg.textContent=x.message;}};document.getElementById("logout").onclick=async()=>{try{await api("/api/auth/logout",{method:"POST",body:"{}"});}catch(x){}token="";sessionStorage.removeItem("nkj_session");auth.classList.remove("hidden");dash.classList.add("hidden");msg.textContent="Vous êtes déconnecté.";};document.getElementById("projectForm").onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);try{await api("/api/projects",{method:"POST",body:JSON.stringify({name:f.get("name"),description:f.get("description")})});e.target.reset();await loadProjects();}catch(x){alert(x.message);}};document.getElementById("appForm").onsubmit=async e=>{e.preventDefault();const f=new FormData(e.target);try{await api("/api/publisher",{method:"POST",body:JSON.stringify({name:f.get("name"),category:f.get("category"),description:f.get("description")})});e.target.reset();await loadApps();}catch(x){alert(x.message);}};async function loadProjects(){const d=await api("/api/projects");if(!d.projects.length){projects.textContent="Aucun projet. Créez votre premier projet ci-dessus.";return;}projects.innerHTML=d.projects.map(p=>"<article class=\\"project\\"><div><h3>"+esc(p.name)+"</h3><p>"+esc(p.description||"Sans description")+"</p><p>Demandes : "+esc(p.quotas.requests_limit)+" · Jetons : "+esc(p.quotas.tokens_limit)+"</p></div><div class=\\"row\\"><button class=\\"btn secondary\\" data-key=\\""+esc(p.id)+"\\">Créer une clé API</button><button class=\\"btn secondary\\" data-edit=\\""+esc(p.id)+"\\" data-name=\\""+esc(p.name)+"\\">Modifier</button><button class=\\"btn danger\\" data-del=\\""+esc(p.id)+"\\">Archiver</button></div></article>").join("");projects.querySelectorAll("[data-key]").forEach(b=>b.onclick=async()=>{try{const d=await api("/api/projects/"+encodeURIComponent(b.dataset.key)+"/api-keys",{method:"POST",body:JSON.stringify({name:"Clé API"})});const n=document.getElementById("keyNotice");n.classList.remove("hidden");n.innerHTML="<h3>Nouvelle clé API — copiez-la maintenant</h3><div class=\\"token\\">"+esc(d.api_key)+"</div><button class=\\"btn secondary\\" id=\\"copyKey\\">Copier</button>";document.getElementById("copyKey").onclick=()=>navigator.clipboard.writeText(d.api_key);}catch(x){alert(x.message);}});projects.querySelectorAll("[data-edit]").forEach(b=>b.onclick=async()=>{const n=prompt("Nouveau nom",b.dataset.name);if(!n)return;try{await api("/api/projects/"+encodeURIComponent(b.dataset.edit),{method:"PATCH",body:JSON.stringify({name:n})});await loadProjects();}catch(x){alert(x.message);}});projects.querySelectorAll("[data-del]").forEach(b=>b.onclick=async()=>{if(!confirm("Archiver ce projet ?"))return;try{await api("/api/projects/"+encodeURIComponent(b.dataset.del),{method:"DELETE"});await loadProjects();}catch(x){alert(x.message);}});}async function loadApps(){const d=await api("/api/publisher");document.getElementById("myApps").innerHTML=(d.apps||[]).map(a=>"<article class=\\"project\\"><div><strong>"+esc(a.name)+"</strong><p>"+esc(a.slug)+" · "+esc(a.status)+"</p></div></article>").join("")||"<p class=\\"muted\\">Aucune fiche créée.</p>";}async function loadDashboard(){try{const d=await api("/api/auth/me");document.getElementById("userEmail").textContent=d.user.email;auth.classList.add("hidden");dash.classList.remove("hidden");await loadProjects();await loadApps();}catch(x){token="";sessionStorage.removeItem("nkj_session");auth.classList.remove("hidden");dash.classList.add("hidden");msg.textContent="Votre session a expiré. Reconnectez-vous.";}}if(token)loadDashboard();})();</script></body></html>';

const STUDIO_STORE_HTML = '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Catalogue — NKJJEAN STUDIO</title><style>body{margin:0;background:#07111f;color:#eaf3ff;font:15px/1.6 system-ui,sans-serif}.wrap{max-width:1100px;margin:auto;padding:25px 18px}a{color:#80caff}.muted{color:#9db1c8}input{width:min(100%,480px);padding:13px;border-radius:9px;border:1px solid #35516c;background:#0c2033;color:white}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:16px;margin-top:24px}.card{background:#0e2033;border:1px solid #25435f;border-radius:14px;padding:19px}.btn{display:inline-block;padding:9px 14px;background:#55aaff;color:#061321;border-radius:8px;font-weight:800}.empty{padding:25px;border:1px dashed #34516d;border-radius:12px;color:#a9bdd2}</style></head><body><main class="wrap"><p><a href="/">Accueil</a> · <a href="/app">Mon espace</a></p><h1>Catalogue public des applications</h1><p class="muted">Seules les applications publiées après validation sont présentées ici.</p><input id="search" type="search" placeholder="Rechercher une application…"><div id="apps" class="grid">Chargement…</div></main><script>(function(){const root=document.getElementById("apps"),search=document.getElementById("search");let list=[];function esc(v){return String(v==null?"":v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c]));}function render(){const q=search.value.toLowerCase().trim(),matches=list.filter(a=>(a.name+" "+a.description+" "+a.category).toLowerCase().includes(q));root.innerHTML=matches.length?matches.map(a=>"<article class=\\"card\\"><p class=\\"muted\\">"+esc(a.category)+"</p><h2>"+esc(a.name)+"</h2><p>"+esc(a.description)+"</p><p class=\\"muted\\">Développeur : "+esc(a.developer)+"</p><a class=\\"btn\\" href=\\""+esc(a.url)+"\\">Voir la fiche</a></article>").join(""):"<div class=\\"empty\\">Aucune application publiée pour le moment.</div>";}fetch("/api/store/apps").then(r=>r.json()).then(d=>{list=d.apps||[];render();}).catch(()=>{root.textContent="Catalogue indisponible.";});search.addEventListener("input",render);})();</script></body></html>';

async function studioHandleApi(request, env, url) {
  const path = url.pathname;
  if (path === "/api/health" && request.method === "GET") {
    return jsonResponse({ success:true, service:"NKJJEAN STUDIO", database:!!env.DB,
      private_file_storage:!!env.APP_FILES, payment_gateway:"not_configured", own_ai_model:"not_deployed" });
  }

  if (path === "/api/store/apps" && request.method === "GET") {
    const query = studioText(url.searchParams.get("q") || "", 100);
    const result = await env.DB.prepare(
      "SELECT a.id,a.name,a.slug,a.description,a.category,a.published_at,u.email AS developer FROM published_apps a JOIN users u ON u.id=a.user_id WHERE a.status='published' AND EXISTS (SELECT 1 FROM app_versions v WHERE v.app_id=a.id AND v.status='approved') AND (?='' OR a.name LIKE '%'||?||'%' OR a.description LIKE '%'||?||'%' OR a.category LIKE '%'||?||'%') ORDER BY a.published_at DESC LIMIT 100"
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
        "SELECT id,name,slug,description,category,published_at FROM published_apps WHERE slug=? AND status='published' AND EXISTS (SELECT 1 FROM app_versions v WHERE v.app_id=published_apps.id AND v.status='approved') LIMIT 1"
      ).bind(slug).first();
      if (!app) return jsonResponse({ error:"Application introuvable ou non publiée." },404);
      const versions = await env.DB.prepare("SELECT id,version_name,version_code,file_size,changelog,created_at FROM app_versions WHERE app_id=? AND status='approved' ORDER BY version_code DESC").bind(app.id).all();
      return jsonResponse({ success:true,app,versions:versions.results||[] });
    }
    return jsonResponse({ error:"Route publique introuvable." },404);
  }

  // API de suivi d'utilisation destinée aux applications clientes.
  if (path === "/v1/project" && request.method === "GET") {
    const key = await studioApiKey(request,env);
    if (!key) return jsonResponse({ error:"Clé API invalide, révoquée ou projet indisponible." },401);
    const project = await env.DB.prepare("SELECT id,name,description FROM projects WHERE id=? LIMIT 1").bind(key.project_id).first();
    const quota = await env.DB.prepare("SELECT * FROM project_quotas WHERE project_id=?").bind(key.project_id).first();
    return jsonResponse({ success:true,project,quotas:quota||null });
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
      return jsonResponse({error:"Le modèle IA propriétaire NKJJEAN n'est pas encore entraîné ni hébergé. Aucun fournisseur IA externe ne sera appelé.",model_status:"not_deployed"},503);
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
    if(parts.length===4&&parts[3]==="versions"&&request.method==="POST"){
      return jsonResponse({error:"Le stockage privé des APK n'est pas activé. Aucun fichier ne peut être téléversé dans cette version.",storage:"not_configured"},503);
    }
    if(parts.length===4&&parts[3]==="submit"&&request.method==="POST"){
      return jsonResponse({error:"La soumission attend un fichier APK et une confirmation de paiement vérifiée. Ces services ne sont pas activés."},503);
    }
  }

  // Administration : compte administrateur défini explicitement dans D1.
  if(parts[0]==="api"&&parts[1]==="admin"){
    if(user.role!=="admin")return jsonResponse({error:"Accès réservé à l'administration."},403);
    if(parts.length===3&&parts[2]==="overview"&&request.method==="GET"){
      const c=await Promise.all([
        env.DB.prepare("SELECT COUNT(*) AS n FROM users").first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM projects WHERE status='active'").first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM published_apps WHERE status='published'").first(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM published_apps WHERE status='pending_review'").first()
      ]);
      return jsonResponse({success:true,counts:{users:c[0].n,active_projects:c[1].n,published_apps:c[2].n,pending_reviews:c[3].n}});
    }
    if(parts.length===4&&parts[2]==="publications"&&parts[3]==="pending"&&request.method==="GET"){
      const r=await env.DB.prepare("SELECT a.id,a.user_id,a.name,a.slug,a.description,a.category,a.status,a.created_at,u.email AS owner_email FROM published_apps a JOIN users u ON u.id=a.user_id WHERE a.status='pending_review' ORDER BY a.created_at").all();
      return jsonResponse({success:true,apps:r.results||[]});
    }
    if(parts.length===3&&parts[2]==="publication-orders"&&request.method==="GET"){
      const r=await env.DB.prepare("SELECT o.id,o.app_id,o.user_id,o.country,o.phone_number,o.receiving_number,o.amount_minor,o.currency,o.payment_provider,o.provider_reference,o.status,o.verified_at,o.created_at FROM app_publication_orders o ORDER BY o.created_at DESC LIMIT 200").all();
      return jsonResponse({success:true,orders:r.results||[],note:"Une commande en attente ne constitue jamais une preuve de paiement."});
    }
    if(parts.length===4&&parts[2]==="apps"&&request.method==="POST"){
      const appId=parts[3],body=await studioReadBody(request),decision=studioText(body.decision,20),comment=studioText(body.comment||"",2000);
      if(!["rejected","suspended"].includes(decision))return jsonResponse({error:"La publication ne peut pas être approuvée tant que le stockage APK et la confirmation du paiement ne sont pas actifs."},409);
      const app=await env.DB.prepare("SELECT id FROM published_apps WHERE id=? LIMIT 1").bind(appId).first();
      if(!app)return jsonResponse({error:"Application introuvable."},404);
      await env.DB.batch([
        env.DB.prepare("UPDATE published_apps SET status=?,rejection_reason=?,updated_at=? WHERE id=?").bind(decision,comment,new Date().toISOString(),appId),
        env.DB.prepare("INSERT INTO app_publication_reviews (id,app_id,version_id,reviewed_by,decision,comment) VALUES (?,?,NULL,?,?,?)").bind(randomHex(16),appId,user.id,decision,comment)
      ]);
      return jsonResponse({success:true,status:decision});
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

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(STUDIO_HOME_HTML, { headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/docs" && request.method === "GET") {
      return new Response(STUDIO_DOCS_HTML, { headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "no-store" } });
    }
    if (url.pathname === "/app" && request.method === "GET") {
      return new Response(STUDIO_APP_HTML, { headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "no-store" } });
    }
    if ((url.pathname === "/applications" || url.pathname.startsWith("/applications/")) && request.method === "GET") {
      return new Response(STUDIO_STORE_HTML, { headers: { "Content-Type": "text/html;charset=UTF-8", "Cache-Control": "no-store" } });
    }
    if (url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/auth/")) {
      if (!env.DB || !env.SESSION_SECRET) return jsonResponse({ error: "Service indisponible." }, 503);
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

      if (!env.DB || !env.SESSION_SECRET) {
        return jsonResponse({
          error: "Service d'authentification indisponible."
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

          const token = randomHex(32);

          const tokenHash = await sessionTokenHash(
            token,
            env.SESSION_SECRET
          );

          const sessionId = randomHex(16);

          const expiresAt = new Date(
            Date.now() + 7 * 24 * 60 * 60 * 1000
          ).toISOString();

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
