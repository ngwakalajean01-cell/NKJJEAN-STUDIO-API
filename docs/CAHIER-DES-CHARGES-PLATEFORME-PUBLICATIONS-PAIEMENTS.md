# Cahier des charges — pages, publications et paiements NKJJEAN STUDIO

Date : 30 octobre 2026
Branche de préparation : `preparation/nkjjean-ai-rtx3090`

## 1. Paramètre de paiement confirmé

Numéro de destination communiqué et confirmé par le propriétaire : **0814620569**.

Ce numéro est une donnée de configuration à utiliser dans les parcours de paiement autorisés. Il ne constitue pas à lui seul une intégration Mobile Money : le fournisseur, le type de paiement (dépôt, retrait, paiement marchand), le compte bénéficiaire et les notifications de confirmation devront être vérifiés avant tout encaissement automatique. Ne jamais afficher un paiement comme réussi sur la seule base d'une déclaration du client ; exiger une confirmation vérifiable du fournisseur ou une validation administrative prévue.

Ne jamais placer de clé secrète ou d'identifiant privé dans le navigateur ou dans le code Android.

## 2. Organisation générale des pages

La plateforme doit distinguer clairement deux espaces reliés au même backend :

- **Espace public (Chrome)** : découverte, recherche, consultation et téléchargement des éléments effectivement publiés.
- **Espace administration** : réception des soumissions, contrôle, validation, publication, gestion et statistiques.

L'interface doit être responsive, utilisable sur téléphone Android et ordinateur, avec navigation simple, titres clairs, boutons visibles, formulaires courts, états de chargement et messages de réussite/erreur explicites.

## 3. Espace public — disposition recommandée

### Page d'accueil
- En-tête NKJJEAN STUDIO avec identité visuelle.
- Barre de recherche globale.
- Navigation : Accueil, Applications, Cours, Publications, Autres contenus, Soumettre, Connexion.
- Présentation des contenus récents et des catégories.
- Blocs de comptage public uniquement si les chiffres sont destinés à être publics.

### Catalogue Applications
- Recherche par nom et filtres par catégorie.
- Cartes d'application : nom, icône/image, courte description, version et date de publication.
- Page détaillée par application avec captures, description, informations utiles, éditeur et bouton **Télécharger**.
- Le téléchargement ne doit être proposé que si un fichier valide et autorisé est disponible.
- URL publique stable et lisible pour chaque application, avec titre et description adaptés aux moteurs de recherche.

### Catalogue Cours
- Recherche et filtres par matière, niveau ou catégorie.
- Cartes de cours et page détaillée.
- Accès au contenu ou au fichier selon les droits définis.
- Afficher clairement les informations de prix ou de gratuité avant l'accès lorsqu'elles s'appliquent.

### Catalogue Publications et autres contenus
- Liste des éléments publiés, filtres, recherche et pages détaillées.
- Ne jamais exposer les brouillons, soumissions en attente, éléments rejetés ou dépubliés.

### Soumission publique
- Formulaire de dépôt distinct pour application, cours ou autre contenu.
- Champs adaptés au type choisi, pièces jointes contrôlées, consentement et accusé de réception.
- Après soumission, afficher un numéro/référence et le statut **En attente de vérification**.
- Une soumission n'est jamais publiée automatiquement.

### Recherche Google
- Pages publiques accessibles sans connexion lorsque le contenu est public.
- URLs canoniques, titres/descriptions, sitemap XML et robots.txt adaptés.
- Prévoir données structurées pertinentes et liens internes.
- L'indexation Google dépend de l'exploration et des décisions de Google ; elle ne peut pas être garantie ni instantanée.

## 4. Espace administration — disposition recommandée

### Tableau de bord
Afficher en haut des cartes de statistiques distinctes :
- Applications publiées.
- Cours publiés.
- Autres contenus publiés.
- Publications publiques au total.
- Soumissions en attente.
- Éléments rejetés ou à corriger.
- Éléments dépubliés.

Les totaux doivent provenir de la base de données et être recalculés/actualisés après chaque opération. Définir précisément si « Publications totales » est la somme des contenus publics ou un compteur historique ; ne pas additionner deux fois la même ressource.

### Menu latéral ou navigation mobile
1. Tableau de bord
2. Soumissions en attente
3. Applications
4. Cours
5. Publications
6. Autres contenus
7. Paiements
8. Statistiques
9. Paramètres

### Liste des soumissions
- Onglets ou filtres : Toutes, En attente, À corriger, Approuvées, Publiées, Dépubliées, Rejetées.
- Recherche par titre, auteur, référence et date.
- Ouvrir le détail et les fichiers avant décision.

### Détail d'une soumission
Actions visibles selon le statut :
- **Approuver et publier** : rend l'élément public après contrôle.
- **Demander une correction** : renvoie au soumissionnaire avec motif.
- **Rejeter** : enregistre le motif.
- **Enregistrer comme brouillon** : reste privé.
- **Dépublier** : retire immédiatement du catalogue public sans supprimer l'historique.
- **Supprimer** : action protégée par confirmation et règles de conservation.

Chaque décision doit enregistrer l'administrateur, la date, l'ancien statut, le nouveau statut et, si nécessaire, le motif.

### Boutons de publication
Les boutons doivent être explicites et déclencher une vraie opération serveur. Après réussite, actualiser la liste, la page publique et les compteurs. En cas d'erreur, conserver les données saisies et afficher un message clair. Éviter les doubles clics et les publications en double.

## 5. Règles de visibilité et de comptage

- Seuls les éléments au statut publié et autorisés sont visibles dans les catalogues publics.
- Les éléments en attente, brouillons, rejetés et dépubliés ne sont pas publics ni indexables.
- Les compteurs d'administration distinguent les statuts ; les compteurs publics ne comptent que les éléments publics.
- Les compteurs doivent être calculés côté serveur/base de données, pas à partir des seules cartes affichées dans le navigateur.
- Les opérations de publier, dépublier, corriger et supprimer doivent actualiser les compteurs sans délai évitable.
- Protéger les actions d'administration par authentification et autorisation côté serveur.

## 6. Parcours complet

1. Le soumissionnaire choisit Applications, Cours ou Autres contenus.
2. Il remplit le formulaire et envoie les informations/fichiers.
3. Le serveur enregistre la soumission en attente et renvoie une référence.
4. L'administration vérifie les informations et les fichiers.
5. L'administrateur approuve et publie, demande une correction ou rejette.
6. Après publication, la page publique est accessible dans Chrome par recherche interne et URL directe.
7. Le bouton Télécharger fonctionne uniquement si le fichier est présent, contrôlé et autorisé.
8. Les statistiques et compteurs sont actualisés.

## 7. Sécurité, paiements et limites

- Contrôles de type, taille et sécurité des fichiers téléversés.
- Stockage privé des fichiers en attente ; accès public uniquement après publication et selon le type de contenu.
- Vérification des permissions côté serveur pour chaque action d'administration.
- Journal d'audit des publications et changements de statut.
- Le numéro **0814620569** est le numéro bénéficiaire confirmé, mais le flux réel de paiement ne doit être activé qu'après configuration et test du fournisseur Mobile Money.
- Ne pas déclarer un paiement réussi sans preuve vérifiable.
- Ne pas modifier les fonctions, tables, politiques ou secrets Supabase existants sans inspection et validation ciblées.
- Ne pas publier automatiquement les soumissions.
- Ne pas déployer en production ni modifier la branche `main` dans le cadre de cette préparation.

## 8. État d'implémentation

Ce document formalise les exigences et la disposition cible. Le dépôt `NKJJEAN-STUDIO-API` contient actuellement le Worker/API, les migrations, les tests et la documentation ; il ne contient pas encore de frontend web identifié dans son arborescence. Par conséquent, ce cahier des charges ne signifie pas que les pages Chrome ont déjà été construites ou modifiées. Il faudra localiser ou créer le frontend dans une étape séparée, puis connecter les écrans aux API existantes après audit des contrats et des autorisations.
