# Préparation de l'infrastructure NKJJEAN AI — RTX 3090

Statut : préparation documentaire uniquement. Aucun fournisseur n'a été réservé, aucune machine créée, aucun secret ajouté et aucun déploiement effectué.

## Décisions validées

- Budget maximal strict : 150 USD par mois, tous frais compris.
- GPU cible : NVIDIA RTX 3090, 24 Go de VRAM.
- Disponibilité souhaitée : 24 h/24, 7 j/7.
- Toute dépense et toute mise en production nécessitent un accord final explicite du propriétaire.
- NKJJEAN AI doit exécuter un modèle auto-hébergé, sans API d'inférence Gemini, OpenAI ou autre fournisseur externe.
- TECHNONKJJEAN doit disposer d'un accès interne gratuit, sans facturation par requête ni abonnement distinct.

## Budget de contrôle

Le plafond de 150 USD est absolu, pas un objectif à dépenser.

- GPU RTX 3090 : cible maximale de planification 0,14 USD/heure, soit environ 102,20 USD sur 730 heures.
- Stockage persistant, trafic et frais annexes : enveloppe indicative maximale 27,80 USD.
- Réserve non engagée : 20 USD.
- Total planifié : 150 USD maximum.

Si le prix réel du GPU, le stockage, le trafic, les taxes ou les frais de paiement empêchent de respecter ce total, ne pas créer la machine. Ne jamais activer de dépassement automatique. Vérifier le coût complet, la facturation minimale, les frais d'arrêt et la conservation du disque avant toute réservation.

Les tarifs et la disponibilité des RTX 3090 varient. Une offre affichée ne garantit ni le prix final, ni la disponibilité, ni le fonctionnement continu.

## Architecture cible

1. **Cloudflare Worker NKJJEAN STUDIO** : conserve authentification, projets, clés API, quotas et journaux D1.
2. **Service privé NKJJEAN AI Runtime** : second Worker/service lié en privé au Worker principal via le binding `NKJ_AI`. Il relaie uniquement les demandes autorisées vers le runtime du modèle.
3. **Serveur GPU RTX 3090** : machine louée On-Demand, disque persistant, environnement isolé, runtime local tel que llama.cpp avec CUDA ou moteur équivalent validé sur 24 Go.
4. **Modèle initial** : modèle à poids ouverts adapté (cible initiale 7B/8B quantifié), après vérification de sa licence, de sa qualité en français et de ses besoins mémoire. Les poids du modèle de base restent soumis à la licence de leur éditeur ; les données, prompts, réglages et adaptations NKJJEAN restent sous le contrôle du propriétaire.
5. **Réseau privé** : liaison Worker vers runtime et tunnel privé vers la machine GPU. Ne pas exposer directement le port d'inférence à Internet. Vérifier la disponibilité et les conditions réelles du mécanisme Cloudflare retenu avant tout déploiement.

## Intégration de TECHNONKJJEAN

- Créer un projet technique dédié nommé TECHNONKJJEAN dans NKJJEAN STUDIO et lui attribuer une identité/API key dédiée.
- L'identifiant réel du projet et la clé devront être générés depuis le compte propriétaire ; ne pas les inventer ni les inscrire dans Git.
- L'application Android ne doit contenir aucun secret permanent. Les appels passent par une fonction serveur contrôlée (par exemple une Supabase Edge Function déjà utilisée par TECHNONKJJEAN), qui conserve le secret dans ses variables protégées.
- Prévoir une autorisation interne gratuite : aucune facturation par requête ni abonnement distinct pour TECHNONKJJEAN.
- « Gratuit » ne signifie pas capacité illimitée : appliquer authentification, limitation de débit, taille maximale des requêtes, file d'attente, protection contre les abus et suivi de consommation. La consommation reste comprise dans le budget global ; si la capacité est saturée, répondre temporairement « service occupé » plutôt que déclencher une dépense.
- Ne pas désactiver les contrôles de sécurité, les journaux techniques ou l'isolation des données.

## Compatibilité avec le code actuel

Le Worker principal contient déjà `studioGenerateWithOwnAI(env, options)`, qui appelle `env.NKJ_AI.fetch()` avec le contrat interne `https://nkjjean-ai.internal/v1/generate`. Le fichier `wrangler.jsonc` consulté déclare D1 mais pas encore le binding `NKJ_AI`.

Avant tout raccordement, il faudra :
- définir et tester le contrat HTTP du service privé ;
- vérifier l'authentification entre le service Worker et le serveur GPU ;
- traiter délais d'attente, erreurs, redémarrages et réponses invalides ;
- ajouter un contrôle d'accès interne TECHNONKJJEAN sans contourner les limites de capacité ;
- vérifier les quotas et journaux D1. Le champ `free_access` existe, mais le code de génération consulté applique encore les limites de requêtes et de jetons ; ce champ ne suffit donc pas à accorder l'accès interne ;
- ajouter des tests pour l'autorisation interne, le refus des clés invalides, le rate limiting et les limites de capacité ;
- préserver comptes, sessions, migrations et fonctions existantes.

## Disponibilité 24/7 et continuité

Une instance GPU louée ne garantit pas à elle seule 100 % de disponibilité. Prévoir supervision, redémarrage automatique du runtime, vérification de santé, sauvegarde de configuration, disque persistant et procédure de récupération. Une panne du fournisseur ou une rupture de stock GPU peut interrompre le service. Ne pas promettre un SLA 24/7 sans redondance, laquelle pourrait dépasser le budget.

## Conditions bloquantes avant dépense ou production

Cette préparation n'autorise pas :
- réserver ou démarrer une instance GPU facturable ;
- acheter du stockage ou du trafic ;
- activer un tunnel ou une option payante ;
- ajouter des secrets Cloudflare ou Supabase ;
- modifier la configuration de production ;
- déployer un Worker ou une version du modèle ;
- lancer une facturation récurrente.

Il faudra présenter au propriétaire l'offre exacte (fournisseur, machine, tarif horaire, stockage, réseau, taxes, coût mensuel estimé, politique d'arrêt et de suppression), puis obtenir son accord final explicite avant de poursuivre.
