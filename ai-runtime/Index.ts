// NKJJEAN AI Runtime Gateway
// Cette passerelle ne contient aucun modèle et n'appelle aucune API d'IA tierce.
// Elle relaie uniquement les requêtes du Worker principal vers le serveur GPU
// NKJJEAN auto-hébergé, via HTTPS et un jeton privé.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function safeText(value, max = 12000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

async function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(left));
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(right));
  const aa = new Uint8Array(a);
  const bb = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

function configuredGpuOrigin(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password ||
        url.search || url.hash) return null;
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function buildMessages(body) {
  const messages = [{
    role: "system",
    content: "Tu es NKJJEAN AI, l'assistant propriétaire de NKJJEAN STUDIO. Réponds clairement en français sauf demande contraire. N'invente pas les faits et signale les incertitudes."
  }];

  const context = body.context && typeof body.context === "object"
    ? JSON.stringify(body.context).slice(0, 6000) : "";
  if (context) messages.push({ role: "system", content: "Contexte du projet : " + context });

  if (Array.isArray(body.history)) {
    for (const item of body.history.slice(-20)) {
      if (!item || !["user", "assistant"].includes(item.role)) continue;
      const content = safeText(item.content, 6000);
      if (content) messages.push({ role: item.role, content });
    }
  }

  const prompt = safeText(body.prompt, 20000);
  if (prompt) messages.push({ role: "user", content: prompt });
  return messages;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      const origin = configuredGpuOrigin(env.GPU_ORIGIN);
      return json({
        success: true,
        service: "NKJJEAN AI Runtime Gateway",
        gateway_configured: Boolean(origin && env.GPU_TOKEN),
        model_configured: Boolean(env.MODEL_NAME),
        inference_provider: "self_hosted_gpu",
        external_ai_api: false
      });
    }

    if (url.pathname !== "/v1/generate" || request.method !== "POST") {
      return json({ success: false, error: "Route introuvable." }, 404);
    }

    const origin = configuredGpuOrigin(env.GPU_ORIGIN);
    if (!origin || typeof env.GPU_TOKEN !== "string" || env.GPU_TOKEN.length < 32) {
      return json({
        success: false,
        error: "Le serveur GPU NKJJEAN n'est pas configuré.",
        code: "GPU_RUNTIME_NOT_CONFIGURED"
      }, 503);
    }

    let body;
    try {
      const length = Number(request.headers.get("Content-Length") || "0");
      if (length > 1024 * 1024) return json({ error: "Requête trop volumineuse." }, 413);
      body = await request.json();
    } catch {
      return json({ error: "JSON invalide." }, 400);
    }

    if (!body || typeof body !== "object" || Array.isArray(body) ||
        !safeText(body.prompt, 20000)) {
      return json({ error: "Le prompt est obligatoire." }, 400);
    }

    const messages = buildMessages(body);
    const gpuRequest = new Request(origin + "/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + env.GPU_TOKEN
      },
      body: JSON.stringify({
        model: safeText(env.MODEL_NAME, 120) || "nkjjean-local-model",
        messages,
        temperature: 0.7,
        stream: false
      })
    });

    let gpuResponse;
    try {
      gpuResponse = await fetch(gpuRequest);
    } catch {
      return json({
        success: false,
        error: "Le serveur GPU NKJJEAN est injoignable.",
        code: "GPU_SERVER_UNREACHABLE"
      }, 502);
    }

    if (!gpuResponse.ok) {
      return json({
        success: false,
        error: "Le serveur GPU a refusé la génération.",
        code: "GPU_INFERENCE_FAILED",
        upstream_status: gpuResponse.status
      }, 502);
    }

    let result;
    try {
      result = await gpuResponse.json();
    } catch {
      return json({ success: false, error: "Réponse GPU illisible.", code: "GPU_INVALID_JSON" }, 502);
    }

    const answer = safeText(result?.choices?.[0]?.message?.content, 30000);
    if (!answer) {
      return json({ success: false, error: "Le modèle n'a pas fourni de réponse.", code: "GPU_EMPTY_ANSWER" }, 502);
    }

    return json({
      answer,
      model: safeText(result.model, 120) || safeText(env.MODEL_NAME, 120) || "NKJJEAN AI local",
      usage: {
        input_tokens: Math.max(0, Number(result?.usage?.prompt_tokens) || 0),
        output_tokens: Math.max(0, Number(result?.usage?.completion_tokens) || 0)
      }
    });
  }
};
