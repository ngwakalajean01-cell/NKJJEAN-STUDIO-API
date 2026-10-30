# NKJJEAN AI — préparation RTX 3090

Ce dossier prépare une passerelle et un serveur de modèle auto-hébergé. Il ne déploie rien et ne crée aucune ressource facturable.

## Architecture prévue

1. Le Worker principal `nkjjean-studio-api` conserve l'authentification, D1, les projets, les quotas et l'historique.
2. Une liaison Cloudflare Service Binding nommée `NKJ_AI` appellera le Worker `nkjjean-ai-runtime`.
3. Le Worker runtime relaiera uniquement vers le serveur GPU NKJJEAN, par HTTPS et avec un jeton privé.
4. Le serveur GPU exécutera un modèle GGUF local via llama.cpp, sur RTX 3090 24 Go.

Aucune API Gemini, OpenAI ou autre API d'inférence tierce n'est utilisée. Le runtime est une passerelle, pas le modèle lui-même.

## Secrets et variables à configurer plus tard

Sur le Worker runtime, après autorisation explicite :
- Secret `GPU_TOKEN` : jeton aléatoire d'au moins 32 caractères, identique au jeton configuré sur le serveur GPU.
- Secret/variable `GPU_ORIGIN` : origine HTTPS du serveur GPU, sans chemin, identifiants, paramètres ni fragment.
- Variable `MODEL_NAME` : nom déclaré du modèle local.

Sur le serveur GPU :
- `GPU_API_TOKEN` dans l'environnement sécurisé du serveur, jamais dans Git.
- Fichier GGUF du modèle approuvé dans `./models`.

Ne jamais placer de secret dans GitHub, dans ce dépôt, dans le code client ou dans une conversation.

## Configuration à finaliser

Le fichier `docker-compose.yml` est un gabarit. Il contient volontairement un nom de fichier modèle à remplacer après sélection et validation de la licence du modèle. Le port du modèle est lié à localhost ; il ne doit pas être publié directement sur Internet. Une terminaison HTTPS et une règle réseau restrictive seront nécessaires.

La configuration Cloudflare du Worker principal devra ensuite ajouter un Service Binding :
```json
"services": [
  {
    "binding": "NKJ_AI",
    "service": "nkjjean-ai-runtime"
  }
]
```
Cette modification n'est pas encore appliquée au Worker principal.

## Budget strict

Plafond approuvé pour la planification : 150 USD/mois, tous frais compris.
La cible de calcul doit rester sous ce plafond après ajout du stockage, du trafic, des frais de fournisseur et d'une marge. Une RTX 3090 affichée à 0,15 USD/heure coûterait environ 109,50 USD sur 730 heures, avant les autres frais : cette offre ne peut donc pas être acceptée automatiquement.

Avant toute commande :
- comparer le coût total réel, les frais de stockage et de trafic ;
- vérifier que la machine est On-Demand et non Interruptible ;
- vérifier disponibilité, redémarrage automatique, accès réseau et conditions de facturation ;
- conserver une marge sous 150 USD ;
- confirmer le modèle et sa licence.

## Limites de disponibilité

Un GPU loué 24/7 n'est pas une garantie SLA. Une panne de l'hôte, une maintenance ou une interruption du fournisseur peut rendre l'IA indisponible. Les mécanismes de surveillance, redémarrage, sauvegarde de configuration et alertes devront être validés avant la mise en production.

## État

- [x] Contrat de la passerelle compatible avec le Worker principal : POST /v1/generate.
- [x] Adaptateur vers API compatible OpenAI de llama.cpp.
- [x] Authentification serveur-à-serveur par jeton.
- [ ] Choix et validation du modèle GGUF et de sa licence.
- [ ] Sélection d'une offre GPU dont le coût total reste inférieur ou égal à 150 USD/mois.
- [ ] Provisionnement du serveur GPU — accord final requis.
- [ ] Configuration des secrets — accord final requis.
- [ ] Déploiement des Workers et Service Binding — accord final requis.
- [ ] Tests de charge, sécurité et disponibilité — avant ouverture aux utilisateurs.
