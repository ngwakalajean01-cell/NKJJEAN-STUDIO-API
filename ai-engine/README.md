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

## Génération d'images et d'affiches

La passerelle expose également les routes privées :

- `POST /v1/images/generations` pour créer une image.
- `POST /v1/images/edits` pour modifier une image à partir de photos de référence.

Le Worker principal transmet ces tâches au binding `NKJ_AI`. Cette passerelle les valide et les relaie vers `NKJ_MODEL` avec les tâches `image_generation` et `image_edit`. Le runtime doit renvoyer `images: [{ mime_type, b64_json }]`.

Le contrat public et les limites sont décrits dans [docs/NKJJEAN-IMAGE-API.md](../docs/NKJJEAN-IMAGE-API.md). Les routes renvoient volontairement 503/502 tant qu'un vrai runtime d'image privé n'est pas raccordé et opérationnel. La présence des routes ne constitue pas une preuve de génération réelle.
