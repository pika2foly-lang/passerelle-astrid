# 🧚‍♀️ Passerelle Astrid

> *Le serveur (Worker Cloudflare) qui fait fonctionner [Astrid Navig](https://astrid-navig.com), le copilote web qui rend internet accessible à tout le monde.*

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/VOTRE-COMPTE/passerelle-astrid)

---

## 🎯 À quoi sert ce serveur ?

Astrid Navig est une application web qui aide les personnes peu à l'aise avec internet à naviguer sur n'importe quel site. Elle a besoin d'un petit serveur pour :

- **Proxifier les sites web** (pour pouvoir les afficher avec Astrid à côté)
- **Faire fonctionner la co-navigation** (un proche peut t'aider à distance)
- **Recevoir les statistiques anonymes** (santé de l'app, sans données personnelles)
- **Te permettre de partager temporairement tes clés API**

Tu peux soit utiliser le serveur d'une personne de confiance (via QR code), soit **avoir ton propre serveur** en cliquant sur le bouton bleu ci-dessus.

## 🚀 Déploiement en 1 clic (recommandé)

1. Clique sur **« Deploy to Cloudflare »** ci-dessus
2. Connecte-toi à Cloudflare (ou crée un compte, gratuit, 1 minute)
3. Connecte-toi à GitLab/GitHub (ou crée un compte)
4. Cloudflare provisionne tout automatiquement :
   - Crée un nouveau repo `passerelle-astrid` dans ton compte
   - Crée 2 KV namespaces (`CONAV_SESSIONS` + `RATELIMIT`)
   - Déploie le Worker et te donne son URL
5. Récupère l'URL `https://passerelle-astrid.TONUSER.workers.dev`
6. Colle-la dans l'app Astrid Navig → ⚙️ Réglages → 🏗️ Mon serveur

**Total : 5 minutes.**

## 💚 Combien ça coûte ?

**0 €.** Cloudflare offre gratuitement :
- 100 000 requêtes/jour sur Workers
- 100 000 lectures/jour sur KV Storage
- 1 000 écritures/jour sur KV Storage

Largement suffisant pour un usage particulier ou associatif (jusqu'à ~100 utilisateurs actifs par jour).

## 🛡️ Sécurité

Ce Worker intègre 8 protections de sécurité :

- **Anti-SSRF** : refuse les IPs privées et internes (10.x, 192.168.x, 169.254.x metadata, IPv6 link-local, etc.)
- **HTTPS-only** : auto-upgrade `http://` → `https://`, refus du contenu non chiffré
- **CSP strict** : Content-Security-Policy sur toutes les pages proxifiées (anti-XSS)
- **HMAC SHA-256** : authentification client signée sur la création de sessions co-nav (anti-spam)
- **Rate-limiting** : max 5 sessions/10 min/IP, 200 heartbeats/10 min/IP
- **Anti-replay** : tokens HMAC valides 5 minutes maximum
- **TTL automatique** : sessions co-nav et heartbeats expirent automatiquement
- **Aucune donnée personnelle** : les heartbeats sont 100% anonymes et agrégés

## 📡 Routes disponibles

| Route | Méthode | Description |
|---|---|---|
| `/` | GET | Page d'accueil descriptive |
| `/proxy?url=...` | GET | Proxifie une page web pour iframe |
| `/conav/create` | POST | Crée une session de co-navigation (auth HMAC requise) |
| `/conav/join` | POST | Rejoint une session existante |
| `/conav/poll` | GET | Récupère les événements (polling adaptatif) |
| `/conav/send` | POST | Envoie un événement (clic, URL change, etc.) |
| `/conav/leave` | POST | Quitte la session |
| `/heartbeat` | POST | Reçoit un ping de santé anonyme |
| `/heartbeat/stats` | GET | Stats agrégées des 7 derniers jours (public, anonyme) |

## 🔧 Développement local

```bash
git clone https://github.com/VOTRE-COMPTE/passerelle-astrid
cd passerelle-astrid
npm install
npx wrangler login
npx wrangler dev
```

## 📜 Licence

MIT — Libre d'utilisation pour tous, particuliers, associations, professionnels.

## 🙋 Aide

- Documentation Astrid : [doc-astrid-navig-v2.docx](#)
- Tutoriel d'installation : [tuto-installation.docx](#)
- Vidéo explicative : (à venir)
