# Nouvelle disposition de NKJJEAN STUDIO — recherche et publications

Date : 30 octobre 2026. Préparation documentaire sur la branche de travail uniquement ; aucune modification de production.

## 1. Paiements
Numéro confirmé par le propriétaire : **0814620569**. Le numéro peut être affiché comme destination prévue, mais son affichage ne prouve pas un paiement reçu. Le paiement automatique reste désactivé tant qu'un opérateur Mobile Money et une vérification serveur ne sont pas intégrés. Ne jamais valider un paiement sur la seule déclaration du client ou une capture d'écran.

## 2. Espace public dans Chrome
Créer un en-tête cohérent : Accueil, Applications, Cours, Publications et contenus, Soumettre une ressource, Connexion / Mon compte.

La page d'accueil doit afficher une grande zone de recherche visible immédiatement, avec recherche par titre, mots-clés, catégorie et type. Ajouter des accès rapides vers Applications, Cours et Autres contenus, les dernières publications et des compteurs publics calculés depuis la base.

Le catalogue doit proposer les filtres Tout / Applications / Cours / Autres contenus, le filtre par catégorie, un tri par date ou ordre alphabétique, une pagination et un état vide clair. Les résultats doivent être uniquement les éléments publiés et accessibles.

Chaque ressource publiée doit avoir une page détaillée partageable avec une URL stable fondée sur un slug, son titre, sa description, sa catégorie et sa date de publication. Une application ne doit afficher Télécharger que si un APK vérifié est réellement stocké et disponible. Un cours ou contenu ne doit afficher Consulter/Télécharger que si le fichier ou la ressource existe.

## 3. Espace utilisateur
Réorganiser les pages en : Tableau de bord ; Mes applications ; Mes cours et contenus proposés ; Soumettre une publication ; Suivi des soumissions ; Mes projets et clés API ; Activité et quotas ; Profil et sécurité.

Le formulaire de soumission doit recueillir type, titre, catégorie, description et fichiers nécessaires. L'utilisateur doit suivre les statuts brouillon, en attente, publié, refusé ou suspendu. Après un refus, il doit pouvoir corriger et soumettre à nouveau.

## 4. Espace administration
Réorganiser les pages en : Vue d'ensemble ; Applications soumises ; Cours soumis ; Autres contenus soumis ; Publications en ligne ; Paiements et vérifications ; Comptes et sécurité ; Paramètres.

Chaque file de modération permet de consulter la fiche et les fichiers, approuver, refuser avec motif, suspendre et consulter l'historique. Seule une approbation explicite rend la ressource publique. La dépublication retire la ressource du catalogue sans effacer l'historique.

## 5. Compteurs
Les compteurs doivent venir de la base et être séparés par type et statut : total applications, applications publiées et en attente ; total cours, cours publiés et en attente ; total autres contenus, contenus publiés et en attente ; total général actuellement public. Éviter les doublons. Actualiser les compteurs après soumission, approbation, dépublication, suspension ou suppression. Les chiffres publics ne comptent que les ressources accessibles.

## 6. Recherche et indexation
La recherche doit être insensible à la casse, tolérer les accents, chercher dans titre, description, mots-clés et catégorie, filtrer par type/catégorie et utiliser pagination côté serveur et requêtes paramétrées. Les brouillons et éléments en attente ne doivent jamais fuiter.

Chrome est le navigateur. Pour être trouvé dans Google, ajouter des URLs publiques stables, titres/descriptions uniques, métadonnées Open Graph, sitemap XML des seules pages publiques, robots.txt, liens internes et inscription du sitemap dans Google Search Console. Google décide du moment et de l'indexation ; celle-ci n'est pas garantie instantanément.

## 7. État technique constaté
Le Worker existant possède déjà les routes publiques /, /applications et /applications/:slug, les fiches d'applications, la soumission, les statuts draft/pending_review/published/rejected/suspended, la validation administrative et des compteurs limités aux utilisateurs, projets actifs, applications publiées et demandes en attente.

Limites actuelles : le dépôt APK répond que le stockage privé n'est pas activé ; le paiement répond que Mobile Money n'est pas configuré ; les tables et routes observées couvrent les applications, pas encore un catalogue commun complet de cours et autres contenus ; le moteur IA propriétaire n'est pas connecté. Ne pas présenter ces fonctions comme opérationnelles avant leur implémentation et leurs tests.

## 8. Étapes de réalisation
1. Concevoir un catalogue public unifié et des données typées pour applications, cours et autres contenus.
2. Ajouter soumission, modification, retrait, consultation publique et historique de modération.
3. Ajouter les files administratives et les compteurs calculés en base.
4. Configurer un stockage privé pour les fichiers et des téléchargements sécurisés.
5. Ajouter recherche, filtres, pages détaillées, sitemap et métadonnées.
6. Tester l'isolation des comptes, permissions, modération, recherche, compteurs, téléchargements et paiements.
7. Déployer uniquement après revue et accord explicite.

## 9. Protection de l'existant
Conserver la branche main inchangée pendant la préparation. Ne pas déployer automatiquement. Ne pas supprimer ou réinitialiser comptes, projets, clés API, sessions, historiques ou données D1. Ne pas modifier les ressources Supabase sans accord distinct. Ne pas activer de service payant sans présenter le coût complet et obtenir l'accord explicite. Préserver l'accès interne gratuit de TECHNONKJJEAN à l'IA dans les limites de capacité et du budget maximal déjà définis.