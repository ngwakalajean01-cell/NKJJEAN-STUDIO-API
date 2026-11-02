# Serveur GPU NKJJEAN — plan d'hébergement autonome

## Objectif et règle financière

Le moteur IA doit fonctionner sur une machine physique contrôlée par NKJJEAN, sans louer de GPU à un fournisseur d'inférence. Cette préparation ne commande aucun matériel, ne crée aucun abonnement et ne déclenche aucun déploiement en Production.

**Budget autorisé à cette étape : 0 USD.** Aucun achat, hébergement payant, abonnement ou engagement financier ne doit être effectué sans une autorisation distincte et explicite de l'administrateur.

Un GPU physique ne peut pas être créé par du code. Il faut obtenir une machine et une carte graphique compatibles, par achat, don ou mise à disposition gratuite. Même une machine donnée peut entraîner des frais d'électricité, de connexion, de maintenance et de remplacement ; ces frais doivent être évalués avant toute mise en service.

## Architecture déjà préparée dans le dépôt

```text
NKJJEAN-STUDIO ── Service Binding NKJ_AI
                         │
                  nkjjean-ai-engine
                         │ Service Binding NKJ_MODEL
                  nkjjean-model-runtime
                         │ HTTPS authentifié
                  Serveur d'inférence sur GPU NKJJEAN
                         │
                  Modèle à poids ouverts choisi et vérifié
```

- `ai-engine/Index.ts` valide la requête et transmet au runtime.
- `model-runtime/Index.ts` relaie la demande vers une API compatible OpenAI `POST /v1/chat/completions`.
- Le serveur GPU devra répondre avec `choices[0].message.content` et, si possible, `usage.prompt_tokens` et `usage.completion_tokens`.
- Le runtime transforme cette réponse au format attendu par la passerelle NKJJEAN.
- Tant que le serveur et les liaisons ne sont pas installés et testés, le moteur doit rester signalé comme indisponible. Ne jamais afficher une génération fictive comme une réussite.

## Matériel minimal à obtenir gratuitement

Base de référence envisagée : NVIDIA RTX 3090 avec 24 Go de VRAM. Ce n'est pas une commande ni une obligation d'achat.

- Carte graphique NVIDIA RTX 3090 24 Go, ou matériel équivalent vérifié.
- Processeur et carte mère compatibles PCIe.
- 64 Go de RAM au minimum ; 128 Go recommandés.
- SSD NVMe de 1 à 2 To pour le système, les modèles et les journaux.
- Alimentation de qualité dimensionnée pour le GPU et les pointes de consommation ; une configuration RTX 3090 demande généralement une alimentation robuste de classe 850–1000 W selon le reste de la machine.
- Boîtier et refroidissement adaptés, espace ventilé et alimentation électrique stable.
- Connexion Internet stable avec possibilité d'exposer un endpoint HTTPS protégé.

Un téléphone Android seul ne remplace pas ce serveur GPU. Une RTX 3090 peut faire tourner certains modèles quantifiés de taille modérée ; elle ne garantit pas l'exécution de grands modèles ni une capacité illimitée pour plusieurs utilisateurs.

## Étapes d'installation — à effectuer seulement quand le matériel existe

1. Identifier la machine réellement disponible et relever le modèle exact du GPU, sa VRAM, la RAM, le processeur, le stockage et l'alimentation.
2. Installer une distribution Linux serveur prise en charge, les pilotes NVIDIA compatibles et le runtime de conteneurs avec prise en charge GPU.
3. Choisir un modèle à poids ouverts dont la licence autorise l'usage prévu. Vérifier la licence, la provenance, la taille, les besoins mémoire et les conditions d'utilisation avant téléchargement.
4. Installer un serveur d'inférence compatible OpenAI, par exemple vLLM si le GPU et le système sont compatibles. Épingler une version testée ; ne pas utiliser aveuglément une image `latest` en Production.
5. Ne pas publier directement le port d'inférence sur Internet. Le placer derrière une connexion HTTPS protégée, avec authentification forte, limitation de débit, journalisation sans données sensibles et mises à jour de sécurité.
6. Configurer `INFERENCE_ORIGIN`, `INFERENCE_TOKEN` (secret) et `INFERENCE_MODEL` dans les secrets/variables du Worker `nkjjean-model-runtime`. Ne jamais écrire le jeton dans Git, une capture d'écran ou une conversation.
7. Déployer et tester d'abord en environnement Preview. Vérifier le contrôle d'accès, les erreurs, les délais, les limites de taille et la consommation GPU.
8. Relier ensuite les Service Bindings `NKJ_MODEL` et `NKJ_AI`, puis tester le parcours complet depuis les deux plateformes.
9. Ne passer en Production qu'après validation explicite de l'administrateur et vérification du coût réel d'électricité, de connexion et de maintenance.

## Sécurité et exploitation

- Le serveur GPU ne doit jamais contenir une clé `SUPABASE_SERVICE_ROLE_KEY` dans son image ou son dépôt.
- Les secrets d'inférence sont stockés dans les secrets de l'environnement approprié.
- Les environnements Preview et Production doivent rester séparés.
- Prévoir des limites par compte, par requête et par période ; refuser les requêtes trop volumineuses.
- Ne pas enregistrer les prompts privés ou les jetons dans les journaux ordinaires.
- Prévoir arrêt d'urgence, sauvegarde de configuration, mises à jour et surveillance de température/VRAM.
- Afficher honnêtement l'état du moteur : indisponible, prêt, occupé ou erreur. Un statut Worker « Ready » ne prouve pas que le GPU ou le modèle répond.

## État actuel vérifiable

- Les deux Workers intermédiaires et leur contrat logiciel sont décrits dans cette branche.
- Aucun serveur GPU physique n'est actuellement installé ou vérifié par ce dépôt.
- Aucun modèle n'est actuellement chargé sur un GPU NKJJEAN.
- Les secrets Cloudflare ne sont pas lisibles depuis le code et ne doivent pas être partagés.
- Aucun déploiement Cloudflare, fusion de branche, achat ou abonnement n'est effectué par ce document.

## Prochaine condition nécessaire

Avant de lancer l'installation, il faut disposer d'une machine physique gratuite (don, prêt ou équipement déjà disponible) et connaître ses caractéristiques exactes. Sans machine compatible, le travail peut continuer sur la documentation et les tests logiciels, mais pas sur une véritable inférence GPU.
