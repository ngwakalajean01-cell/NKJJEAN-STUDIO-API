const assert = require("node:assert/strict");
const fs = require("node:fs");

const worker = fs.readFileSync("Index.ts", "utf8");
const engine = fs.readFileSync("ai-engine/Index.ts", "utf8");
const runtime = fs.readFileSync("model-runtime/Index.ts", "utf8");
const contract = fs.readFileSync("docs/NKJJEAN-IMAGE-API.md", "utf8");

assert.ok(worker.includes('path === "/v1/images/generations"'), "Route publique de génération d'images absente.");
assert.ok(worker.includes('path === "/v1/images/edits"'), "Route publique de modification d'images absente.");
assert.ok(worker.includes("studioGenerateImageWithOwnAI"), "Fonction de génération d'images absente.");
assert.ok(worker.includes("env.NKJ_AI.fetch"), "La passerelle privée NKJ_AI n'est pas utilisée.");
assert.ok(worker.includes("PROJECT_QUOTA_EXCEEDED"), "Le contrôle de quotas est absent.");
assert.ok(worker.includes("TOO_MANY_REFERENCE_IMAGES"), "La limite de photos n'est pas appliquée.");
assert.ok(worker.includes("REFERENCE_IMAGES_TOO_LARGE"), "La limite de taille totale des photos n'est pas appliquée.");
assert.ok(worker.includes("IMAGE_ENGINE_NOT_CONFIGURED"), "Le statut moteur non configuré n'est pas explicite.");

assert.ok(engine.includes('url.pathname === "/v1/images/generations"'), "Route privée de génération d'images absente.");
assert.ok(engine.includes('url.pathname === "/v1/images/edits"'), "Route privée de modification d'images absente.");
assert.ok(engine.includes('task: imageTask ||'), "Le type de tâche image n'est pas transmis au runtime.");
assert.ok(engine.includes("NKJ_MODEL_RUNTIME_NOT_CONNECTED"), "Le runtime absent ne renvoie pas un état explicite.");

assert.ok(runtime.includes('body.task === "image_generation"'), "Le runtime ne distingue pas la génération d'images.");
assert.ok(runtime.includes("/v1/nkjjean/images/generations"), "Le contrat du serveur privé d'images est absent.");
assert.ok(runtime.includes("PRIVATE_IMAGE_MODEL_NOT_READY"), "Le runtime privé indisponible n'est pas signalé.");

assert.ok(contract.includes("POST /v1/images/generations"), "La documentation de l'API publique est incomplète.");
assert.ok(contract.includes("POST /v1/images/edits"), "La documentation de l'édition d'images est incomplète.");
assert.ok(worker.includes('parts[3] === "images"') && worker.includes('parts[4] === "generations"'), "Le générateur authentifié du Studio est absent.");
assert.ok(worker.includes('parts[4] === "edits"'), "L'édition authentifiée depuis le Studio est absente.");
assert.ok(worker.includes('id="createNkjAiProject"'), "Le bouton de création du projet NKJJEAN AI est absent.");
assert.ok(worker.includes('NKJJEAN AI — Génération d’affiches'), "Le modèle de projet NKJJEAN AI est absent.");
assert.ok(worker.includes('id="imageForm"') && worker.includes('id="imageFiles"'), "Le formulaire de génération d'affiches dans le Studio est absent.");
assert.ok(worker.includes('readImageFile(file)'), "Le Studio ne prépare pas les photos de référence.");
assert.ok(worker.includes('id="generatedImageArea"'), "La zone de résultat des affiches est absente.");

assert.ok(!worker.includes("api.openai.com"), "Aucun appel direct à OpenAI ne doit être présent.");
assert.ok(!worker.includes("generativelanguage.googleapis.com"), "Aucun appel direct à Gemini ne doit être présent.");

console.log("Tests statiques NKJJEAN AI Images réussis : routes, quotas, limites, runtime privé et absence de fournisseur externe.");
