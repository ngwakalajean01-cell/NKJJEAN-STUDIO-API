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
