# Mise en service du catalogue NKJJEAN STUDIO

Ce guide accompagne les modifications de la branche `preparation/nkjjean-ai-rtx3090`. Il ne déclenche aucun déploiement et n'exécute aucune migration sur la base distante.

## Fonctions préparées dans le code

- Page d'accueil avec recherche, accès Applications / Cours / Autres contenus et compteurs publics.
- Catalogue unifié avec filtres, fiches publiques et liens partageables.
- Soumission des applications, cours et autres contenus depuis l'espace utilisateur.
- Modération dans l'administration, publication après approbation et suspension d'une publication.
- Compteurs administratifs séparés par type et statut.
- Sitemap XML dynamique et robots.txt.
- Téléchargement sécurisé uniquement pour les fichiers approuvés et rattachés à une publication publique.
- Réception des paiements prévue au numéro **0814620569**. Aucun paiement automatique n'est confirmé.

## Étape A — Sauvegarder D1

Avant toute modification de schéma, faire une sauvegarde D1 depuis Cloudflare Dashboard ou avec Wrangler. Ne pas supprimer ni recréer la base.

## Étape B — Appliquer la migration additive

La migration `migrations/0003_public_catalog_and_files.sql` ajoute uniquement les tables :
- `published_resources`
- `resource_files`
- `app_release_files`
- `resource_reviews`

Elle conserve les tables et données déjà présentes. Après sauvegarde, depuis le dépôt connecté à Cloudflare, exécuter une seule fois :

```bash
npx wrangler d1 execute nkjjean-studio-db --remote --file=migrations/0003_public_catalog_and_files.sql
```

Ne pas réexécuter une migration si son état est incertain ; vérifier d'abord les tables dans D1.

## Étape C — Créer le stockage privé R2

Le Worker est préparé avec le binding `APP_FILES` vers le bucket `nkjjean-studio-private-files`.

Créer ce bucket une seule fois dans Cloudflare R2, ou avec Wrangler :

```bash
npx wrangler r2 bucket create nkjjean-studio-private-files
```

Le fichier `wrangler.jsonc` contient déjà le binding R2. Le bucket doit exister dans le même compte Cloudflare que le Worker avant le prochain déploiement. Le bucket reste privé : ne pas activer l'accès public direct.

Les fichiers acceptés pour les cours et autres contenus sont PDF, DOCX, PPTX, ZIP, MP4, JPEG et PNG (50 Mo maximum par fichier). Les APK sont limités à 100 Mo. Les téléchargements passent par le Worker et vérifient que la ressource et le fichier sont approuvés.

## Étape D — Vérifier les contrôles

La route `/api/health` doit confirmer :
- `database_connected = true`
- `public_catalog_schema_ready = true`
- `private_file_storage = true`

Tester ensuite :
1. créer un compte utilisateur de test ;
2. créer une fiche de cours et une fiche de contenu ;
3. déposer un fichier si R2 est configuré ;
4. vérifier que les deux fiches apparaissent en attente dans l'administration ;
5. approuver une fiche et vérifier sa page publique ;
6. vérifier qu'une fiche en attente ou refusée ne figure pas dans le catalogue ;
7. télécharger un fichier approuvé ;
8. suspendre une publication et vérifier qu'elle disparaît du catalogue et du sitemap ;
9. contrôler les compteurs après chaque décision.

Pour les applications, créer la fiche, téléverser un APK et soumettre. Le bouton Télécharger n'apparaît qu'après approbation administrative de l'application et de sa version.

## Étape E — Indexation Google

Après déploiement sur le domaine public final :
- ouvrir `https://VOTRE-DOMAINE/robots.txt` ;
- ouvrir `https://VOTRE-DOMAINE/sitemap.xml` ;
- ajouter le domaine dans Google Search Console ;
- envoyer l'adresse du sitemap.

Google décide de l'exploration et de l'indexation ; aucune plateforme ne peut garantir l'apparition instantanée d'une page dans les résultats.

## Paiements

Le numéro confirmé est **0814620569**. Le code garde la passerelle en état `not_configured` tant qu'un opérateur Mobile Money, un compte marchand et les identifiants/API officiels ne sont pas fournis. Ne jamais déduire une confirmation de paiement à partir du seul numéro ou d'une capture d'écran.

## Limites de cette étape

- Aucun déploiement en production n'a été lancé.
- La migration D1 n'a pas été exécutée sur la base distante.
- Le bucket R2 n'a pas été créé dans le compte Cloudflare.
- L'indexation Search Console doit être effectuée par le propriétaire du domaine.
- Le paiement automatique nécessite encore le fournisseur Mobile Money et ses accès officiels.
- Les pages et routes sont préparées sur la branche de travail ; elles doivent passer les tests et être déployées après vérification.

## Sécurité et conservation

Ne pas exposer le bucket R2 publiquement. Ne jamais placer de secret Cloudflare, Mobile Money ou session dans le code Android ou dans Git. Ne pas modifier la branche `main` avant revue et accord explicite.
