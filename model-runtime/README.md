# NKJJEAN Model Runtime

Ce Worker est un adaptateur sécurisé vers le serveur d'inférence qui héberge le modèle open-weight choisi et contrôlé par NKJJEAN.

## Configuration Cloudflare

Configurer dans les variables/secrets du Worker :

- `INFERENCE_ORIGIN` : URL HTTPS du serveur privé d'inférence, sans chemin final.
- `INFERENCE_TOKEN` : secret d'accès au serveur privé (à enregistrer comme secret, jamais dans Git).
- `INFERENCE_MODEL` : identifiant du modèle servi, ici `nkjjean` par défaut.

Le serveur doit exposer une API compatible avec `POST /v1/chat/completions`, accepter les messages Chat Completions et renvoyer `choices[0].message.content` et idéalement `usage.prompt_tokens` / `usage.completion_tokens`.

## Déploiement

Après installation et sécurisation du serveur d'inférence :

```sh
npx wrangler deploy --config model-runtime/wrangler.jsonc
```

Puis déployer `ai-engine`, et enfin déclarer les Service Bindings dans les Workers appelants.

## Important

Ce Worker n'est pas le modèle et ne crée pas d'intelligence artificielle à lui seul. Le serveur privé GPU/CPU et le modèle open-weight doivent être choisis, installés, configurés et testés. Aucun fournisseur d'IA tiers n'est appelé par ce code ; seule l'URL privée configurée par l'administrateur est utilisée.

## Génération d'images

Pour les tâches `image_generation` et `image_edit`, l'adaptateur appelle exclusivement le serveur privé configuré par `INFERENCE_ORIGIN` sur :

`POST /v1/nkjjean/images/generations`

Le serveur reçoit `model`, `task`, `prompt`, `images` (photos base64), `size`, `style` et `request_id`. Il doit répondre avec `images: [{ mime_type: "image/png", b64_json: "..." }]`.

Ce contrat est volontairement propre à NKJJEAN. Il ne redirige pas les images vers une API publique tierce. Si le serveur privé n'expose pas cette route, la passerelle renvoie une erreur et n'annonce aucune génération réussie.
