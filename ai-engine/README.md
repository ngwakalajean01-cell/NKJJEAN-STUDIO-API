# NKJJEAN AI Engine

Worker privé intermédiaire entre NKJJEAN-STUDIO et le runtime du modèle NKJJEAN auto-hébergé.

## Architecture

`NKJJEAN-STUDIO` → Service Binding `NKJ_AI` → `nkjjean-ai-engine` → Service Binding `NKJ_MODEL` → `nkjjean-model-runtime` → modèle open-weight hébergé sur une infrastructure contrôlée par NKJJEAN.

Aucun appel à Gemini, OpenAI ou à une API publique de modèle n'est prévu dans cette architecture.

## Contrat du runtime privé

Le Worker `nkjjean-model-runtime` doit exposer `POST /v1/infer` et recevoir :

- `model`, `task`, `prompt`
- `context`, `history`
- `conversation_id`, `request_id`

Il doit renvoyer du JSON contenant `answer` (ou `output_text`) et, si disponibles, `model` et `usage.input_tokens` / `usage.output_tokens`.

## Déploiement

Depuis la racine du dépôt, après avoir créé et testé le Worker runtime privé :

```sh
npx wrangler deploy --config ai-engine/wrangler.jsonc
```

Le Worker principal doit ensuite déclarer un Service Binding nommé `NKJ_AI` vers le Worker `nkjjean-ai-engine`.

## État réel

Cette passerelle est le composant d'orchestration et de validation ; elle n'est pas un modèle de langage. Le runtime d'inférence et l'hébergement du modèle ne sont pas inclus et doivent être installés sur une infrastructure privée disposant des ressources CPU/GPU nécessaires. Tant que le binding `NKJ_MODEL` n'est pas configuré et que le runtime ne répond pas, `/v1/generate` renvoie volontairement une erreur 503/502 au lieu de fabriquer une réponse.

Ne pas déployer en Production ni fusionner la branche de travail sans validation explicite.
