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


## Vérification technique et tarifaire du 30 octobre 2026

### Connexion privée Cloudflare

La documentation Cloudflare Workers VPC consultée le 30 octobre 2026 indique que Workers VPC peut relier un Worker à des services privés hébergés dans un autre cloud au moyen d'un Cloudflare Tunnel et de VPC Services. La documentation indique une disponibilité sur les plans Free et Paid, mais le produit reste en bêta. Il faut donc vérifier les droits du compte, les rôles Connectivity Directory, les limites et les éventuels changements avant de configurer la liaison. Cette piste est plus précise qu'un simple endpoint public ou qu'un Service Binding seul : le Worker doit disposer du binding VPC documenté pour le service privé ciblé.

Références :
- https://developers.cloudflare.com/workers-vpc/
- https://developers.cloudflare.com/workers-vpc/configuration/vpc-services/

### Prix observés pour RTX 3090

Les comparateurs consultés le 30 octobre 2026 affichent des écarts importants selon l'hôte et la configuration : une offre plancher observée à 0,121 USD/GPU-heure, d'autres relevés autour de 0,15 à 0,20 USD/heure, et des offres plus élevées. À 730 heures :
- 0,121 USD/h = 88,33 USD/mois pour le GPU seul ;
- 0,150 USD/h = 109,50 USD/mois pour le GPU seul ;
- 0,198 USD/h = 144,54 USD/mois pour le GPU seul.

Références indicatives, non contractuelles :
- https://studiotvai.com/gpu-price/rtx-3090
- https://gpuledger.dev/gpus/nvidia-rtx-3090/
- https://cloud.vast.ai/create/?gpuModelNames=rtx3090

Conclusion budgétaire : le plafond de 150 USD/mois n'est pas garanti par la seule présence d'offres à bas prix. À 0,15 USD/h, il ne reste que 40,50 USD pour stockage, bande passante, taxes et frais. À 0,198 USD/h, le GPU seul dépasse pratiquement le budget. Il faut donc retenir uniquement une offre dont le coût total vérifié reste sous le plafond, avec alertes et arrêt manuel/automatique de sécurité. Les offres de marketplace peuvent disparaître et la disponibilité continue n'est pas garantie.

### Distinction des moteurs

Le modèle conversationnel et le modèle de génération d'images seront déployés et supervisés séparément. Le premier test sur RTX 3090 doit mesurer la VRAM réellement consommée, le débit, la latence, la qualité en français et le comportement après redémarrage. Le moteur image doit faire l'objet d'un test indépendant, notamment sur le respect du texte, des coordonnées, des logos et des photos de référence. Aucun choix de modèle ne sera déclaré validé avant vérification de licence et essai réel sur la machine cible.
