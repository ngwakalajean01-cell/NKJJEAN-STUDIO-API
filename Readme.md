# NKJJEAN STUDIO

Worker API et espace web de la plateforme NKJJEAN STUDIO.

## Configuration déjà utilisée

- Worker : `nkjjean-studio-api`
- Fichier principal : `Index.ts`
- Branche de déploiement : `main`
- Base D1 : `nkjjean-studio-db`
- Liaison D1 : `DB`
- Secret de session : `SESSION_SECRET` (à conserver secret)

## Pages web

- `/` : page d'accueil en français
- `/docs` : présentation des services et limites actuelles
- `/app` : inscription, connexion et espace personnel
- `/applications` : catalogue public des applications validées

## Authentification

Les routes existantes sont conservées :

- `POST /api/auth/register`
- `POST /api/auth/login`
- `GET /api/auth/me`
- `POST /api/auth/logout`

Les routes privées utilisent `Authorization: Bearer <jeton_de_session>`.

## Projets

- `GET /api/projects` : liste des projets du compte
- `POST /api/projects` : créer un projet
- `GET /api/projects/:id` : consulter un projet
- `PATCH /api/projects/:id` : modifier un projet
- `DELETE /api/projects/:id` : archiver un projet sans effacer ses données
- `GET, POST /api/projects/:id/api-keys` : consulter ou créer des clés
- `DELETE /api/projects/:id/api-keys/:keyId` : révoquer une clé
- `GET /api/projects/:id/usage` : historique récent d'utilisation

Une clé API complète est affichée une seule fois au moment de sa création. Seul son hachage est stocké dans D1.

## API pour les applications clientes

- `GET /v1/project` avec l'en-tête `X-API-Key` : lire les informations du projet et ses quotas
- `POST /v1/usage` avec l'en-tête `X-API-Key` : enregistrer une utilisation et contrôler les limites gratuites

Ces routes fournissent l'identification du projet et le suivi des usages. Elles ne constituent pas encore un moteur IA.

## Espaces de conversation par projet

- `GET, POST /api/projects/:id/conversations`
- `GET, POST /api/conversations/:conversationId`

La migration `migrations/0002_project_workspace.sql` doit être exécutée dans la console SQL D1 avant d'utiliser ces routes. Elle crée deux tables et trois index, sans supprimer les tables existantes.

Les messages envoyés sont enregistrés. Aucune réponse IA automatique n'est générée dans cette version.

## Publication des applications

- `GET, POST /api/publisher` : consulter et créer les fiches
- `PATCH, DELETE /api/publisher/:appId` : modifier ou supprimer une fiche encore modifiable
- `GET /api/publisher/:appId/versions` : consulter les versions déjà enregistrées
- `GET /api/store/apps` : catalogue public des fiches publiées et disposant d'une version approuvée
- `GET /api/store/apps/:slug` : consulter une fiche publiée

Administration :
- `GET /api/admin/overview`
- `GET /api/admin/publications/pending`
- `GET /api/admin/publication-orders`
- `POST /api/admin/apps/:appId` : refus ou suspension avec un motif

Les routes d'administration exigent un compte dont `users.role = 'admin'`. Aucun compte client ordinaire ne reçoit ce rôle à l'inscription.

## Fonctionnalités volontairement désactivées

- **Stockage APK :** R2 n'a pas été activé car le tableau de bord demandait une étape de paiement. Les routes de téléversement et de téléchargement APK restent donc désactivées. Aucun fichier APK n'est prétendu disponible.
- **Paiement de publication :** aucun opérateur mobile-money n'est encore connecté. Le numéro de réception prévu est `0814620569`, mais son enregistrement ne confirme aucun transfert. Aucune commande ne doit être marquée payée sans vérification réelle par un opérateur.
- **IA propriétaire :** aucun service Gemini, OpenAI ou autre fournisseur externe n'est appelé. La plateforme enregistre les messages de travail, mais le modèle NKJJEAN reste à entraîner et à héberger sur une infrastructure dédiée.
- **Accès spécial TECHNONKJJEAN :** il n'est pas activé dans cette version.

## Quotas gratuits initiaux

Chaque nouveau projet reçoit :
- 1 000 requêtes au total par mois
- 100 requêtes par jour
- 100 000 jetons suivis par projet

Les limites sont enregistrées dans `project_quotas`. Les quotas spéciaux restent désactivés.

## Sécurité

Ne publiez jamais `SESSION_SECRET`, les mots de passe, les jetons de session ni les clés API complètes. Les propriétaires ne peuvent consulter et modifier que leurs propres projets et leurs propres fiches d'application.
