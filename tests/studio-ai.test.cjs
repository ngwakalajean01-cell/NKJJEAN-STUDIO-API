const assert = require("node:assert/strict");
const fs = require("node:fs");

const worker = fs.readFileSync("Index.ts", "utf8");

assert.ok(worker.includes("async function studioGenerateWithOwnAI"), "Passerelle IA propriétaire absente.");
assert.ok(worker.includes("env.NKJ_AI.fetch"), "La liaison Worker privée NKJ_AI n'est pas utilisée.");
assert.ok(worker.includes("https://nkjjean-ai.internal/v1/generate"), "Contrat HTTP interne du moteur absent.");
assert.ok(worker.includes('path === "/v1/ai"'), "Route IA pour les applications clientes absente.");
assert.ok(worker.includes('parts[3] === "ai"'), "Route IA du Studio projet absente.");
assert.ok(worker.includes("Envoyer à NKJJEAN IA"), "Le Studio n'affiche pas le compositeur IA.");
assert.ok(worker.includes("AI_ENGINE_NOT_CONFIGURED"), "Le statut moteur indisponible n'est pas explicite.");
assert.ok(worker.includes("PROJECT_QUOTA_EXCEEDED"), "Le contrôle des quotas de requêtes est absent.");
assert.ok(worker.includes("own_ai_engine_connected"), "Le diagnostic ne signale pas la liaison IA.");
assert.ok(!worker.includes("api.openai.com"), "Un appel direct à OpenAI ne doit pas être présent.");
assert.ok(!worker.includes("generativelanguage.googleapis.com"), "Un appel direct à Gemini ne doit pas être présent.");

console.log("Tests IA réussis : passerelle privée, routes Studio et applications, quotas et absence d'API IA externe.");
