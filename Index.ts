
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

// ==================== WORKER PRINCIPAL ====================

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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
