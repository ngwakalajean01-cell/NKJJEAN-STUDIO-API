const assert = require("node:assert/strict");
const fs = require("node:fs");

const runtime = fs.readFileSync("ai-runtime/Index.ts", "utf8");
const compose = fs.readFileSync("ai-runtime/docker-compose.yml", "utf8");

assert.ok(runtime.includes('url.pathname === "/v1/generate"'), "Route de génération runtime absente.");
assert.ok(runtime.includes('origin + "/v1/chat/completions"'), "Adaptateur llama.cpp absent.");
assert.ok(runtime.includes('env.GPU_TOKEN'), "Authentification GPU absente.");
assert.ok(runtime.includes('env.GPU_ORIGIN'), "Destination GPU configurable absente.");
assert.ok(runtime.includes('protocol !== "https:"'), "HTTPS obligatoire non vérifié.");
assert.ok(runtime.includes('inference_provider: "self_hosted_gpu"'), "Mode GPU auto-hébergé non déclaré.");
assert.ok(!runtime.includes("api.openai.com"), "Aucun endpoint OpenAI ne doit être appelé.");
assert.ok(!runtime.includes("generativelanguage.googleapis.com"), "Aucun endpoint Gemini ne doit être appelé.");
assert.ok(compose.includes("127.0.0.1:8080:8080"), "Le serveur modèle ne doit pas exposer son port publiquement.");
assert.ok(compose.includes("--api-key"), "L'authentification du serveur modèle est absente.");

console.log("Tests runtime NKJJEAN AI réussis : HTTPS, jeton privé, adaptateur local et port non public.");
