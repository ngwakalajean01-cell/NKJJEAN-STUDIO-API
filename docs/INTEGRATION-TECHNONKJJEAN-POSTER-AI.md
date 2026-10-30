# Intégration de TECHNONKJJEAN à NKJJEAN AI — contrat de migration

Statut : analyse et préparation sur la branche `preparation/nkjjean-ai-rtx3090` uniquement. Aucun changement n'a été déployé dans Supabase, Cloudflare ou l'application Android.

## 1. Constat vérifié dans Supabase

Projet Supabase identifié : `TECHNONKJJEAN` (`piuqudrpitjmvhtlymns`).

La fonction Edge `poster-ai` est active en version 21, avec `verify_jwt=false`. Elle valide actuellement la session client par le RPC `validate_client_session`, puis :
- utilise Gemini `gemini-2.5-flash-image` si `GEMINI_API_KEY` est défini ;
- sinon, utilise AI Horde si `AI_HORDE_API_KEY` est défini ;
- prend en charge `generate` et `edit`, jusqu'à six images de référence ;
- renvoie `imageBase64`, `mimeType`, `action` et un message de succès.

Conséquence : la fonction actuelle n'est pas encore indépendante des fournisseurs externes. La passerelle NKJJEAN STUDIO déjà présente est une passerelle de génération de texte et ne fournit pas encore de génération d'images.

## 2. Architecture cible pour les affiches

Le flux cible est :

1. L'application Android conserve son parcours, ses contrôles de session et son format de réponse actuels.
2. L'application appelle toujours la fonction Supabase `poster-ai`. Aucun secret NKJJEAN ne doit être intégré dans l'APK.
3. `poster-ai` valide la session via `validate_client_session`, comme aujourd'hui.
4. Après validation, `poster-ai` appelle le Worker NKJJEAN STUDIO avec un secret serveur-à-serveur conservé uniquement dans les secrets Supabase.
5. NKJJEAN STUDIO vérifie ce secret, l'identité du projet TECHNONKJJEAN, le droit d'accès gratuit interne, les limites anti-abus et la disponibilité du moteur.
6. Le service privé NKJJEAN AI transmet le travail au serveur GPU privé.
7. Le runtime image produit le visuel et renvoie une réponse contrôlée à la fonction Supabase.
8. Supabase renvoie à Android le même contrat de sortie que celui utilisé aujourd'hui : `success`, `action`, `mimeType`, `imageBase64`, `message`.

Le routage de production ne doit pas être activé tant que les tests de compatibilité, de sécurité, de taille, de délais et de reprise ne sont pas réussis.

## 3. Deux capacités IA distinctes

La génération de texte et la génération d'images sont deux tâches différentes.

- Texte : endpoint interne existant envisagé `/v1/generate`, modèle de langage quantifié adapté à 24 Go de VRAM.
- Image : endpoint interne à définir `/v1/image/generate`, modèle de génération d'images compatible avec 24 Go de VRAM, optimisations et tailles d'image testées.

Un modèle texte 7B/8B ne peut pas remplacer à lui seul Gemini Image ou AI Horde. Le choix du modèle image, sa licence, la qualité du rendu des textes dans les affiches, les photos de référence et la consommation VRAM doivent faire l'objet de tests distincts. Ne pas annoncer que la génération d'images est prête tant que ces tests ne sont pas concluants.

## 4. Accès gratuit interne TECHNONKJJEAN

L'accès gratuit signifie :
- aucune facturation par requête à TECHNONKJJEAN ;
- aucun abonnement distinct ;
- une identité de projet dédiée, contrôlée par le propriétaire ;
- une consommation comptabilisée dans le budget global maximal de 150 USD/mois.

Cela ne signifie pas une capacité illimitée. Le serveur doit appliquer une limite de débit, une limite de concurrence, une taille maximale de requête et d'images, une file d'attente, des délais maximums et une réponse `SERVICE_BUSY` lorsque la capacité est saturée. Aucun dépassement de budget automatique ne doit être possible.

L'autorisation interne doit être spécifique à TECHNONKJJEAN et vérifiée côté serveur. Ne jamais faire confiance à un `project_id`, un `user_id` ou un indicateur `free_access` envoyé seul par le client.

## 5. Exigences de sécurité

- Aucun secret NKJJEAN dans Android, JavaScript public, dépôt Git ou réponse HTTP.
- Le secret d'appel Worker est stocké uniquement dans les variables protégées de Supabase et Cloudflare.
- Authentifier la session TECHNONKJJEAN avant tout appel IA.
- Authentifier le serveur Supabase auprès de NKJJEAN STUDIO avec une clé dédiée révocable et limitée au projet.
- Vérifier la taille réelle du corps reçu, pas uniquement l'en-tête `Content-Length`.
- Limiter les images aux formats autorisés et valider leur décodage.
- Ne pas journaliser les images, prompts privés, jetons de session ou secrets.
- Enregistrer les consommations et identifiants de requête sans conserver inutilement les données personnelles.
- Les erreurs de moteur doivent être explicites et ne jamais renvoyer une fausse réussite.

## 6. Compatibilité à préserver

La migration doit conserver :
- la validation `validate_client_session` et la correspondance entre session et `userId` ;
- les actions `generate` et `edit` ;
- la limite de six images de référence, avec une limite totale de taille définie et testée ;
- les règles de prompt, le respect des consignes du client et le format de réponse attendu par Android ;
- les codes d'erreur HTTP compréhensibles ;
- le fonctionnement des autres fonctions Supabase, tables, politiques et menus Android.

Ne pas modifier les autres fonctions Edge, tables, politiques, buckets ou menus Android dans le cadre de ce raccordement.

## 7. Tests obligatoires avant bascule

1. Session absente, expirée, invalide ou appartenant à un autre utilisateur : refus.
2. Secret serveur absent, erroné ou révoqué : refus.
3. Projet autre que TECHNONKJJEAN : refus.
4. Génération de texte et génération d'image : contrats séparés.
5. `generate` sans image, `generate` avec références, `edit` avec référence.
6. Images invalides, six images, sept images, corps trop volumineux et formats interdits.
7. Runtime arrêté, réponse invalide, timeout, surcharge et redémarrage : erreur maîtrisée, jamais de faux succès.
8. Réponse finale strictement compatible avec Android.
9. Accès gratuit interne sans facturation par requête, avec limites anti-abus et suivi de consommation.
10. Vérifier que les chemins Gemini et AI Horde ne sont plus utilisés après bascule finale.

## 8. Conditions préalables non satisfaites

Avant de modifier ou déployer `poster-ai`, il faut :
- déployer et tester le runtime texte et le runtime image privés ;
- définir les modèles et confirmer leurs licences et leurs performances sur RTX 3090 24 Go ;
- créer le projet et l'identité technique TECHNONKJJEAN dans NKJJEAN STUDIO ;
- ajouter les secrets serveur dans les environnements protégés, jamais dans Git ;
- implémenter l'autorisation gratuite interne et les limites de capacité ;
- valider le coût complet du GPU, du disque, du trafic, des taxes et des frais sous 150 USD/mois ;
- obtenir l'accord final explicite du propriétaire avant toute dépense ou bascule en production.

## 9. État des changements

Ce document ne change aucun code de production. Il ne déploie pas Supabase ni Cloudflare et ne modifie pas l'application Android. La branche de préparation reste distincte de `main`.
