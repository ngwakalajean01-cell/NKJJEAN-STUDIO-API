// NKJJEAN AI ENGINE — passerelle privée vers le runtime du modèle auto-hébergé.
// Cette Worker ne prétend pas exécuter un LLM : elle valide les requêtes,
// applique les limites et transmet au service privé NKJ_MODEL.

interface Env {
  NKJ_MODEL?: Fetcher;
  NKJ_MODEL_NAME?: string;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });

const text = (value: unknown, max: number) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

async function readJson(request: Request) {
  const length = Number(request.headers.get("Content-Length") || "0");
  if (length > 160_000) throw new Error("PAYLOAD_TOO_LARGE");
  const body = await request.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("INVALID_JSON");
  }
  return body as Record<string, unknown>;
}

function normalizeHistory(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(-20).map((item) => {
    const row = item && typeof item === "object"
      ? item as Record<string, unknown>
      : {};
    const role = row.role === "assistant" ? "assistant" : "user";
    return { role, content: text(row.content ?? row.message, 6000) };
  }).filter((item) => item.content.length > 0);
}

async function generate(request: Request, env: Env) {
  if (request.method !== "POST") {
    return json({ success: false, error: "Méthode non autorisée." }, 405);
  }
  const requestId = text(request.headers.get("X-NKJJEAN-REQUEST-ID"), 64);
  if (!/^[a-f0-9]{16,64}$/i.test(requestId)) {
    return json({ success: false, error: "Identifiant de requête invalide." }, 400);
  }

  let body: Record<string, unknown>;
  try {
    body = await readJson(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return message === "PAYLOAD_TOO_LARGE"
      ? json({ success: false, error: "Requête trop volumineuse." }, 413)
      : json({ success: false, error: "Corps JSON invalide." }, 400);
  }

  const prompt = text(body.prompt, 20_000);
  if (!prompt) return json({ success: false, error: "Le prompt est vide." }, 400);
  if (!env.NKJ_MODEL || typeof env.NKJ_MODEL.fetch !== "function") {
    return json({
      success: false,
      code: "NKJ_MODEL_RUNTIME_NOT_CONNECTED",
      error: "Le runtime privé du modèle NKJJEAN n'est pas encore raccordé."
    }, 503);
  }

  const routePath = new URL(request.url).pathname;
  const imageTask = routePath === "/v1/images/generations" ? "image_generation"
    : (routePath === "/v1/images/edits" ? "image_edit" : "");
  const images = Array.isArray(body.images) ? body.images.slice(0, 6) : [];
  if (imageTask && (images.length > 6 || images.some((item) => !item || typeof item.data !== "string" || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i.test(item.data)))) {
    return json({ success: false, code: "INVALID_REFERENCE_IMAGES", error: "Photos de référence invalides." }, 400);
  }
  if (imageTask === "image_edit" && images.length === 0) {
    return json({ success: false, code: "REFERENCE_IMAGE_REQUIRED", error: "Une photo est nécessaire pour la modification." }, 400);
  }
  const payload = {
    model: text(env.NKJ_MODEL_NAME, 100) || "nkjjean-model",
    task: imageTask || text(body.task, 40) || "chat",
    prompt,
    images: imageTask ? images : [],
    size: text(body.size, 20) || "1024x1024",
    style: text(body.style, 80) || "professional",
    context: body.context && typeof body.context === "object" ? body.context : {},
    history: normalizeHistory(body.history),
    conversation_id: text(body.conversation_id, 120) || null,
    request_id: requestId
  };

  let upstream: Response;
  try {
    upstream = await env.NKJ_MODEL.fetch(new Request(
      "https://nkjjean-model.internal/v1/infer",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "X-NKJJEAN-REQUEST-ID": requestId
        },
        body: JSON.stringify(payload)
      }
    ));
  } catch {
    return json({
      success: false,
      code: "NKJ_MODEL_UNREACHABLE",
      error: "Le runtime privé NKJJEAN est momentanément injoignable."
    }, 502);
  }

  if (!upstream.ok) {
    return json({
      success: false,
      code: "NKJ_MODEL_ERROR",
      error: "Le runtime privé NKJJEAN n'a pas pu traiter la demande."
    }, 502);
  }

  let result: Record<string, unknown>;
  try {
    const value = await upstream.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    result = value as Record<string, unknown>;
  } catch {
    return json({
      success: false,
      code: "NKJ_MODEL_INVALID_RESPONSE",
      error: "Le runtime NKJJEAN a renvoyé une réponse invalide."
    }, 502);
  }

  if (imageTask) {
    const rows = Array.isArray(result.images) ? result.images : (Array.isArray(result.data) ? result.data : []);
    const output = rows.map((item) => {
      const row = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const b64 = text(row.b64_json ?? row.image_base64, 20_000_000);
      const mime = text(row.mime_type, 40) || "image/png";
      return b64 && /^image\/(png|jpeg|webp)$/i.test(mime) ? { b64_json: b64, mime_type: mime } : null;
    }).filter(Boolean).slice(0, 1);
    if (!output.length) return json({ success: false, code: "NKJ_MODEL_EMPTY_IMAGE", error: "Le runtime n'a renvoyé aucune image." }, 502);
    return json({ success: true, images: output, model: text(result.model, 100) || payload.model, request_id: requestId });
  }

  const answer = text(result.answer ?? result.output_text ?? result.response, 60_000);
  if (!answer) {
    return json({
      success: false,
      code: "NKJ_MODEL_EMPTY_RESPONSE",
      error: "Le modèle NKJJEAN n'a pas produit de réponse."
    }, 502);
  }

  const usage = result.usage && typeof result.usage === "object"
    ? result.usage as Record<string, unknown>
    : {};
  const inputTokens = Math.max(0, Math.min(10_000_000, Number(usage.input_tokens) || 0));
  const outputTokens = Math.max(0, Math.min(10_000_000, Number(usage.output_tokens) || 0));

  return json({
    success: true,
    answer,
    model: text(result.model, 100) || payload.model,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    request_id: requestId
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && request.method === "GET") {
      return json({
        service: "NKJJEAN AI Engine",
        status: "online",
        model_runtime: !!env.NKJ_MODEL
      });
    }
    if (url.pathname === "/v1/generate" || url.pathname === "/v1/images/generations" || url.pathname === "/v1/images/edits") return generate(request, env);
    return json({ success: false, error: "Route introuvable." }, 404);
  }
};
