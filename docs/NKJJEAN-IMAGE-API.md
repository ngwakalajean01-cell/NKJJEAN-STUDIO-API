# API NKJJEAN AI — génération d'images et d'affiches

Cette API appartient à l'écosystème NKJJEAN-STUDIO. Elle ne fait appel ni à Gemini, ni à OpenAI, ni à une API publique de génération d'images.

## Routes publiques

Toutes les routes nécessitent une clé de projet active dans l'en-tête `X-API-Key: nkj_live_...`.

### Générer une affiche

`POST /v1/images/generations`

JSON :
```json
{
  "prompt": "Créer une affiche professionnelle pour...",
  "size": "1024x1024",
  "style": "professional",
  "images": []
}
```

### Modifier une image avec des photos de référence

`POST /v1/images/edits`

Même format JSON, mais `images` doit contenir au moins une photo :
```json
{
  "prompt": "Créer une affiche en conservant les éléments importants de cette photo...",
  "size": "1024x1024",
  "style": "professional",
  "images": [
    {
      "mime_type": "image/jpeg",
      "data": "data:image/jpeg;base64,BASE64_IMAGE"
    }
  ]
}
```

## Limites appliquées par l'API

- Clé API de projet active obligatoire.
- Jusqu'à 6 photos de référence.
- Formats acceptés : PNG, JPEG et WEBP.
- 6 Mio maximum par photo et 20 Mio au total (taille binaire estimée après décodage).
- Corps JSON limité à 28 Mio.
- Vérification des quotas du projet : limite globale, quotidienne et mensuelle.
- Journalisation des générations réussies dans `usage_logs`.
- Une seule image finale est retournée par requête.

## Réponse de succès

```json
{
  "success": true,
  "model": "NKJJEAN IA — images",
  "images": [
    {
      "mime_type": "image/png",
      "b64_json": "BASE64_IMAGE_GENERATED"
    }
  ],
  "request_id": "..."
}
```

Le client transforme `b64_json` en image PNG/JPEG/WEBP selon `mime_type`. Il doit conserver la clé API côté serveur ou dans un stockage sécurisé ; ne jamais l'inscrire en dur dans une application publique.

## État du moteur et indisponibilité

Les routes publiques et les passerelles sont préparées dans le code. Elles ne signifient pas que le modèle d'image est déjà installé ou entraîné. Tant que le runtime privé ne fournit pas le service d'inférence, l'API renvoie une erreur explicite `503` ou `502`, sans inventer une image.

## Contrat requis pour le serveur privé

Le runtime privé configuré par `INFERENCE_ORIGIN` doit exposer :

`POST /v1/nkjjean/images/generations`

Il reçoit un JSON avec `model`, `task` (`image_generation` ou `image_edit`), `prompt`, `images`, `size`, `style` et `request_id`. Il doit renvoyer `images: [{ mime_type, b64_json }]` et éventuellement `model`.

Le serveur doit contrôler les fichiers, les formats, les dimensions, la charge et les droits avant toute inférence. Le secret `INFERENCE_TOKEN` est configuré comme secret du Worker runtime, jamais dans Git.

## Architecture

`TECHNONKJJEAN (plus tard) → Supabase (relais plus tard) → NKJJEAN-STUDIO API → NKJJEAN AI Engine → NKJJEAN Model Runtime → modèle d'image auto-hébergé`

Aucun changement Supabase n'est inclus dans cette étape. Aucun déploiement ou fusion Production n'est effectué par cette modification.

## Génération depuis l'espace Studio

Le propriétaire du projet peut également utiliser le générateur visuel directement depuis `/studio/{project_id}`, après connexion à son compte NKJJEAN-STUDIO. Les routes de session sont :

- `POST /api/projects/{project_id}/images/generations`
- `POST /api/projects/{project_id}/images/edits`

Elles appliquent les mêmes limites, quotas et validations que les routes publiques avec clé API. Le formulaire du Studio permet de joindre jusqu'à six photos, de suivre l'état de la demande et d'enregistrer l'image retournée.

## Création du projet dans la plateforme

Dans « Mes projets », le bouton « Créer mon projet NKJJEAN AI » crée un projet préconfiguré nommé « NKJJEAN AI — Génération d'affiches » et ouvre son Studio. Les clés API peuvent ensuite être créées depuis le Studio, onglet « API et activité ».

Ces fonctionnalités créent l'espace de projet et l'interface de génération. Elles ne déploient pas le modèle d'image : tant que le runtime privé n'est pas raccordé à un vrai modèle, une demande de génération retourne explicitement une indisponibilité.

Depuis le Studio, le propriétaire peut créer une clé API dans l'onglet « API et activité ». La clé complète est affichée une seule fois avec une action de copie ; seule son empreinte et son préfixe sont conservés pour la gestion ultérieure. En cas de perte, il faut révoquer la clé et en créer une nouvelle.
