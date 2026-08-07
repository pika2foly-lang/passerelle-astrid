// ════════════════════════════════════════════════════════════════
// 🌉 Passerelle Web Proxy — Cloudflare Worker pour Oh API Day
// ════════════════════════════════════════════════════════════════

// L'utilisateur n'est ici qu'en ESSAI : sa vraie Passerelle est chez lui.
// On limite donc le TEMPS passe sur ce Worker, pas le nombre de pages.
// Compter par tranches divise les ecritures KV par ~20 : une session de
// 30 min coute 3 ecritures au lieu de 60. Le palier gratuit n'en donne
// que 1000 par jour — c'est LA ressource rare, pas les requetes.
const ESSAI_MINUTES_PAR_JOUR = 30;   // <- la seule valeur a ajuster apres tes tests
const TRANCHE_MINUTES        = 10;
const MAX_TRANCHES           = ESSAI_MINUTES_PAR_JOUR / TRANCHE_MINUTES;

// Affiche au moment ou l'essai se termine : c'est LE moment de convertir.
// A remplacer par ta page de tutoriel reelle.
const TUTORIEL_URL = 'https://ohapi-day-f37288.gitlab.io/#passerelle';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (path === '/proxy-web' || path === '/proxy-web/') {
      const target = url.searchParams.get('url');
      if (!target) return new Response('Missing ?url=', { status: 400, headers: corsHeaders() });
      const rlCheck = await checkRateLimit(request, env);
      if (!rlCheck.allowed) return rlCheck.response;
      return await proxyRequest(target, url.origin, request, env);
    }

    if (path === '/proxy-asset' || path === '/proxy-asset/') {
      const target = url.searchParams.get('url');
      if (!target) return new Response('Missing ?url=', { status: 400, headers: corsHeaders() });
      // Les assets consomment la meme tranche de temps que la page :
      // aucune ecriture KV supplementaire, mais ils ne sont plus gratuits.
      const rlCheck = await checkRateLimit(request, env);
      if (!rlCheck.allowed) return rlCheck.response;
      return await proxyAsset(target);
    }

    if (path === '/health' || path === '/health/') {
      return new Response(JSON.stringify({
        ok: true,
        worker: 'ohapiday-passerelle-web',
        rateLimit: env.RATELIMIT ? 'enabled' : 'MANQUANT — le proxy refuse tout',
        conav: env.CONAV_SESSIONS ? 'enabled' : 'disabled',
        // Les cookies ne s'activent que sur une Passerelle personnelle
        cookies: cookiesActifs(env) ? 'enabled (passerelle personnelle)' : 'disabled (mode partage)',
        essaiMinutesParJour: ESSAI_MINUTES_PAR_JOUR,
        time: new Date().toISOString()
      }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }

    if (path.startsWith('/conav/')) {
      if (!env.CONAV_SESSIONS) {
        return jsonResponse({ error: 'KV CONAV_SESSIONS non configuré. Ajoute le binding dans Settings.' }, 503);
      }
      try {
        if (path === '/conav/create' && request.method === 'POST') return await conavCreate(env, request);
        if (path === '/conav/join' && request.method === 'POST')   return await conavJoin(request, env);
        if (path === '/conav/poll' && request.method === 'GET')    return await conavPoll(request, env);
        if (path === '/conav/send' && request.method === 'POST')   return await conavSend(request, env);
        if (path === '/conav/leave' && request.method === 'POST')  return await conavLeave(request, env);
        return jsonResponse({ error: 'Route conav inconnue' }, 404);
      } catch (e) {
        return jsonResponse({ error: e.message || 'Erreur interne conav' }, 500);
      }
    }

    if (path === '/' || path === '/index.html') {
      return new Response(homePage(url.origin), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders() }
      });
    }

    if (path === '/heartbeat' && request.method === 'POST') {
      return await heartbeatReceive(request, env);
    }
    if (path === '/heartbeat/stats' && request.method === 'GET') {
      return await heartbeatStats(env);
    }

    return new Response('Not found', { status: 404, headers: corsHeaders() });
  },

  // Cron quotidien : reconstruit l'agregat des statistiques.
  // Sans lui, /heartbeat/stats faisait jusqu'a 1001 lectures KV PAR VISITE ;
  // cent visites epuisaient le quota journalier de lectures.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(reconstruireAgregatHeartbeat(env));
  }
};

async function checkRateLimit(request, env) {
  // Binding absent : on bloque aussi. Sinon un oubli de configuration
  // ouvrirait le proxy en grand sans que personne ne s'en apercoive.
  if (!env.RATELIMIT) return { allowed: false, response: reponseIndisponible() };

  const ip      = request.headers.get('cf-connecting-ip') || 'unknown';
  const jour    = new Date().toISOString().slice(0, 10);
  const cle     = `rl:${ip}:${jour}`;
  const tranche = Math.floor(Date.now() / (TRANCHE_MINUTES * 60000));

  try {
    let tranches = [];
    const brut = await env.RATELIMIT.get(cle);
    if (brut) { try { tranches = JSON.parse(brut) || []; } catch (e) { tranches = []; } }

    // Tranche deja ouverte : on laisse passer SANS ecrire.
    // C'est ce qui rend les assets gratuits : ils tombent dans la meme tranche
    // que la page qui les demande.
    if (tranches.includes(tranche)) {
      return { allowed: true, tranchesUtilisees: tranches.length };
    }

    if (tranches.length >= MAX_TRANCHES) {
      const resetIn = Math.floor((new Date(jour + 'T23:59:59Z').getTime() - Date.now()) / 1000);
      return { allowed: false, response: reponseEssaiTermine(tranches.length, resetIn) };
    }

    tranches.push(tranche);
    await env.RATELIMIT.put(cle, JSON.stringify(tranches), { expirationTtl: 86400 });
    return { allowed: true, tranchesUtilisees: tranches.length };

  } catch (e) {
    // KV en echec : on BLOQUE. Laisser passer ferait disparaitre la limite
    // en silence au moment ou la charge la rend le plus necessaire.
    console.error('Rate limit:', e);
    return { allowed: false, response: reponseIndisponible() };
  }
}

// KV injoignable : ce n'est pas la faute de l'utilisateur, on le dit.
function reponseIndisponible() {
  return new Response(JSON.stringify({
    error: 'service_indisponible',
    message: "Le service d'essai est momentanement indisponible. Reessaie dans quelques minutes, "
           + "ou depose ta propre Passerelle : elle n'a aucune limite et se met en place en 5 minutes.",
    tutorial: TUTORIEL_URL
  }), {
    status: 503,
    headers: { 'Content-Type': 'application/json', 'Retry-After': '120', ...corsHeaders() }
  });
}

function reponseEssaiTermine(utilisees, resetIn) {
  return new Response(JSON.stringify({
    error: 'essai_termine',
    message: "Tu as atteint la limite d'essai du jour. "
           + "Ta propre Passerelle n'a aucune limite, elle est gratuite et se depose en 5 minutes.",
    minutesParJour: ESSAI_MINUTES_PAR_JOUR,
    tranchesUtilisees: utilisees,
    resetIn: resetIn,
    tutorial: TUTORIEL_URL
  }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      'X-RateLimit-Limit':     String(MAX_TRANCHES),
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset':     String(resetIn),
      ...corsHeaders()
    }
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function securityCheck(target) {
  let url;
  try {
    url = new URL(target);
  } catch (e) {
    return 'URL invalide';
  }
  if (url.protocol !== 'https:') {
    return 'HTTPS requis (' + url.protocol + ' bloqué)';
  }
  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return 'Hostname local interdit (' + host + ')';
  }
  if (host.endsWith('.onion')) {
    return 'Réseau Tor non supporté';
  }
  if (host === '' || host === '.') {
    return 'Hostname vide';
  }
  if (/^\d+$/.test(host)) {
    return 'IP au format décimal bloquée';
  }
  if (/^0x[0-9a-f]+$/i.test(host)) {
    return 'IP au format hexa bloquée';
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = +ipv4[1], b = +ipv4[2];
    if (a === 0) return 'IP 0.x bloquée';
    if (a === 10) return 'IP privée 10.x bloquée';
    if (a === 127) return 'Localhost bloqué';
    if (a === 169 && b === 254) return 'IP link-local (metadata) bloquée';
    if (a === 172 && b >= 16 && b <= 31) return 'IP privée 172.16-31.x bloquée';
    if (a === 192 && b === 168) return 'IP privée 192.168.x bloquée';
    if (a >= 224) return 'IP multicast/reserved bloquée';
  }
  if (host.includes(':') || host.startsWith('[')) {
    const v6 = host.replace(/^\[|\]$/g, '').toLowerCase();
    if (v6 === '::1' || v6 === '::') return 'IPv6 loopback bloqué';
    if (v6.startsWith('fe80:') || v6.startsWith('fe80::')) return 'IPv6 link-local bloqué';
    if (v6.startsWith('fc') || v6.startsWith('fd')) return 'IPv6 unique-local bloqué';
    if (v6.startsWith('ff')) return 'IPv6 multicast bloqué';
    if (/^::ffff:/.test(v6)) return 'IPv6 mappant IPv4 bloqué';
  }
  if (host === '100.64.0.0' || host.startsWith('100.6')) {
    return 'CGN range bloqué';
  }
  return null;
}

// Construit le rewriter. `bridgeHtml` = la chaîne complète des <script>
// (ton bridge existant + les modules). `helpers.domaineRacine` = ta
// fonction déjà présente dans le Worker.
function makeRewriter(targetUrl, proxyOrigin, bridgeHtml, helpers) {
  const baseUrl  = new URL(targetUrl);
  const baseHref = baseUrl.protocol + '//' + baseUrl.host + '/';
  const racine   = helpers.domaineRacine(baseUrl.host);
  let injected = false;

  function sameRoot(host) {
    host = String(host).toLowerCase();
    return host === racine || host.endsWith('.' + racine);
  }

  // URL interne absolue -> URL proxy. Renvoie null si on ne doit PAS réécrire.
  function proxify(raw) {
    let abs;
    try { abs = new URL(raw, baseHref); } catch (e) { return null; }
    if (abs.protocol !== 'https:' && abs.protocol !== 'http:') return null;
    if (!sameRoot(abs.hostname)) return null;
    abs.protocol = 'https:'; // on ne sert que du HTTPS
    return proxyOrigin + '/proxy-web?url=' + encodeURIComponent(abs.href);
  }

  function injectInto(el) {
    if (injected) return;
    el.prepend('<base href="' + baseHref + '">', { html: true });
    el.append(bridgeHtml, { html: true });
    injected = true;
  }

  return new HTMLRewriter()
    // 1) neutraliser les protections anti-iframe posées en <meta>
    .on('meta', {
      element(el) {
        const eq = (el.getAttribute('http-equiv') || '').toLowerCase();
        if (eq === 'x-frame-options' || eq === 'content-security-policy') {
          el.remove();
        }
      }
    })
    // 2) base + bridge, injectés au début du <head> (cas normal)
    .on('head', { element(el) { injectInto(el); } })
    // 3) filet de sécurité : si la page n'a pas de <head>, on injecte en tête de <body>
    .on('body', { element(el) { if (!injected) injectInto(el); } })
    // 4) liens internes -> proxy (les clics sont AUSSI captés par le bridge ;
    //    ceci sert au clic-molette / ouvrir dans un nouvel onglet)
    .on('a[href]', {
      element(el) {
        const href = el.getAttribute('href');
        if (!href) return;
        const low = href.trim().toLowerCase();
        if (low.startsWith('javascript:') || low.startsWith('mailto:') ||
            low.startsWith('tel:') || low.startsWith('#') || low.startsWith('data:')) return;
        if (el.getAttribute('target') === '_blank') return;
        const p = proxify(href);
        if (p) el.setAttribute('href', p);
      }
    });
}

// ────────────────────────────────────────────────────────────────
// REMPLACE ta fonction proxyRequest par celle-ci.
// Deux changements par rapport à la tienne :
//   (A) le corps des POST est transmis (avant, il était perdu -> login/form KO)
//   (B) le HTML passe par HTMLRewriter en streaming (au lieu de html.replace)
// Tout le reste (securityCheck, messages d'erreur) est identique.
// ────────────────────────────────────────────────────────────────
// Suit les redirections A LA MAIN, en revalidant securityCheck a chaque saut.
// Avec redirect:'follow', seule l'URL de depart etait verifiee : un site
// pouvait rediriger vers 169.254.169.254 et contourner toute la protection.
// Renvoie aussi l'URL FINALE, indispensable pour poser le bon <base href>.
// ═════════════════════════════════════════════════════════════════════
//  🍪 POT DE COOKIES — uniquement sur une Passerelle PERSONNELLE
// ═════════════════════════════════════════════════════════════════════
//  Sans cookies, aucune demarche en plusieurs pages ne fonctionne :
//  le site pose une session, ne la retrouve pas, et recharge en boucle.
//
//  Trois regles rendent la chose defendable :
//   1. Le pot vit dans le KV, JAMAIS dans le navigateur. Le JavaScript
//      d'une page ne peut donc pas lire document.cookie et repartir
//      avec la session.
//   2. Un compartiment par hote : les cookies d'ameli.fr ne partent
//      jamais ailleurs.
//   3. Ils ne s'attachent qu'aux NAVIGATIONS de page. Une page
//      malveillante qui ferait fetch('/proxy-web?url=...') envoie
//      Sec-Fetch-Dest: empty et ne recoit rien : elle obtient une page
//      deconnectee. C'est ce qui ferme le trou du proxy mono-origine.
//
//  Actif seulement si AI_TOKEN est defini : c'est le signal d'une
//  Passerelle personnelle. Sur le proxy partage, jamais.
const COOKIES_TTL = 30 * 86400;

function cookiesActifs(env) {
  return !!(env && env.AI_TOKEN && env.GALAXY);
}

// Une vraie navigation de page, pas un appel JavaScript depuis la page
function estNavigation(request) {
  const dest = request.headers.get('Sec-Fetch-Dest');
  if (dest) return dest === 'document' || dest === 'iframe' || dest === 'frame';
  // Navigateur ancien sans Sec-Fetch-* : on se rabat sur Accept
  const acc = request.headers.get('Accept') || '';
  return acc.indexOf('text/html') !== -1;
}

async function lirePot(env, hote) {
  try {
    const brut = await env.GALAXY.get('v1:jar:' + hote);
    return brut ? JSON.parse(brut) : {};
  } catch (e) { return {}; }
}

async function ecrirePot(env, hote, pot) {
  try {
    await env.GALAXY.put('v1:jar:' + hote, JSON.stringify(pot), { expirationTtl: COOKIES_TTL });
  } catch (e) { /* le pot est un confort, jamais bloquant */ }
}

// Le domaine qui possede le cookie : ameli.fr couvre www.ameli.fr
function hotePot(host) {
  return domaineRacine(String(host).toLowerCase());
}

async function enTeteCookie(env, host) {
  const pot = await lirePot(env, hotePot(host));
  const maintenant = Date.now();
  const paires = [];
  for (const [nom, c] of Object.entries(pot)) {
    if (c && c.exp && c.exp < maintenant) continue;   // perime
    paires.push(nom + '=' + c.v);
  }
  return paires.join('; ');
}

async function absorberCookies(env, host, reponse) {
  let liste = [];
  try {
    if (typeof reponse.headers.getSetCookie === 'function') liste = reponse.headers.getSetCookie();
    else if (typeof reponse.headers.getAll === 'function')  liste = reponse.headers.getAll('Set-Cookie');
    else { const un = reponse.headers.get('Set-Cookie'); if (un) liste = [un]; }
  } catch (e) { return; }
  if (!liste || !liste.length) return;

  const hote = hotePot(host);
  const pot = await lirePot(env, hote);
  let touche = false;

  for (const brut of liste) {
    const parts = String(brut).split(';');
    const premier = parts[0].trim();
    const eq = premier.indexOf('=');
    if (eq < 1) continue;
    const nom = premier.slice(0, eq).trim();
    const val = premier.slice(eq + 1);

    let exp = 0;
    for (let i = 1; i < parts.length; i++) {
      const a = parts[i].trim().toLowerCase();
      if (a.startsWith('max-age=')) {
        const sec = parseInt(a.slice(8), 10);
        if (!isNaN(sec)) exp = sec <= 0 ? -1 : Date.now() + sec * 1000;
      } else if (a.startsWith('expires=')) {
        const t = Date.parse(parts[i].trim().slice(8));
        if (!isNaN(t)) exp = t;
      }
    }
    if (exp === -1) { delete pot[nom]; touche = true; continue; }   // suppression
    pot[nom] = { v: val, exp: exp || 0 };
    touche = true;
  }
  if (touche) await ecrirePot(env, hote, pot);
}

async function fetchSecurise(urlDepart, init, maxSauts = 5) {
  let courante = urlDepart;
  let options  = { ...init, redirect: 'manual' };

  for (let saut = 0; saut <= maxSauts; saut++) {
    const err = securityCheck(courante);
    if (err) return { erreur: err };

    const r = await fetch(courante, options);

    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('Location');
      if (!loc) return { reponse: r, urlFinale: courante };
      let suivante;
      try { suivante = new URL(loc, courante).href; }
      catch (e) { return { reponse: r, urlFinale: courante }; }
      // Comme un navigateur : apres une redirection, un POST repart en GET
      options  = { ...options, method: 'GET', body: undefined };
      courante = suivante;
      continue;
    }
    return { reponse: r, urlFinale: courante };
  }
  return { erreur: 'Trop de redirections' };
}

async function proxyRequest(targetUrl, proxyOrigin, originalRequest, env) {
  if (targetUrl && targetUrl.toLowerCase().startsWith('http://')) {
    targetUrl = 'https://' + targetUrl.substring(7);
  }
  const secError = securityCheck(targetUrl);
  if (secError) {
    return new Response('🔒 ' + secError, {
      status: 403,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders() }
    });
  }

  try {
    const init = {
      method: originalRequest.method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      // les redirections sont suivies a la main par fetchSecurise
    };

    // (A) transmettre le corps des méthodes qui en ont un
    if (originalRequest.method !== 'GET' && originalRequest.method !== 'HEAD') {
      init.body = await originalRequest.arrayBuffer();
      const ct = originalRequest.headers.get('content-type');
      if (ct) init.headers['Content-Type'] = ct;
    }

    // 🍪 On joint les cookies UNIQUEMENT sur une vraie navigation de page,
    //    et seulement si cette Passerelle est personnelle (AI_TOKEN pose).
    if (cookiesActifs(env) && estNavigation(originalRequest)) {
      try {
        const ck = await enTeteCookie(env, new URL(targetUrl).host);
        if (ck) init.headers['Cookie'] = ck;
      } catch (e) {}
    }

    const res = await fetchSecurise(targetUrl, init);
    if (res.erreur) {
      return new Response('🔒 ' + res.erreur, {
        status: 403,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders() }
      });
    }
    const response = res.reponse;

    // On garde ce que le site a pose, pour la page suivante
    if (cookiesActifs(env)) {
      try { await absorberCookies(env, new URL(res.urlFinale || targetUrl).host, response); } catch (e) {}
    }

    // L'URL FINALE, pas celle de depart : apres un POST -> 302 -> GET,
    // la page affichee vient d'ailleurs et le <base href> doit la suivre.
    const urlFinale = res.urlFinale || targetUrl;
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('text/html')) {
      // (B) réécriture en streaming
      const bridge   = buildFullBridge(proxyOrigin, domaineRacine(new URL(urlFinale).host));
      const rewriter = makeRewriter(urlFinale, proxyOrigin, bridge, { domaineRacine });
      const out      = rewriter.transform(response);

      return new Response(out.body, {
        status: response.status,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy':
            "default-src https: data: blob:; " +
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:; " +
            "style-src 'self' 'unsafe-inline' https: data:; " +
            "img-src https: data: blob:; " +
            "font-src https: data:; " +
            "connect-src https: wss:; " +
            "frame-ancestors 'self' https:; " +
            "block-all-mixed-content; " +
            "upgrade-insecure-requests",
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
          ...corsHeaders(),
        },
      });
    }

    // non-HTML (images, JSON d'API, etc.) : passe-plat
    return new Response(response.body, {
      status: response.status,
      headers: { 'Content-Type': contentType, ...corsHeaders() },
    });

  } catch (e) {
    const msg = e.message || '';
    let userMsg = 'Erreur proxy : ' + msg;
    if (/cert|ssl|tls|https/i.test(msg)) {
      userMsg = "🔒 Ce site n'a pas de certificat HTTPS valide. Astrid ne charge que les sites sécurisés (HTTPS).";
    } else if (/refused|timeout|dns|enotfound/i.test(msg)) {
      userMsg = "⚠️ Site inaccessible. Vérifie l'adresse ou réessaye plus tard.";
    }
    return new Response(userMsg, {
      status: 502,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders() }
    });
  }
}

async function proxyAsset(targetUrl) {
  try {
    // Cette route n'appelait AUCUN securityCheck : tout le blindage
    // anti-SSRF de /proxy-web etait contournable par /proxy-asset.
    const res = await fetchSecurise(targetUrl, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36' }
    });
    if (res.erreur) {
      return new Response('🔒 ' + res.erreur, {
        status: 403,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders() }
      });
    }
    const response = res.reponse;
    const headers = new Headers();
    const ct = response.headers.get('content-type');
    if (ct) headers.set('Content-Type', ct);
    headers.set('Access-Control-Allow-Origin', '*');
    // Workers Cache se pilote par cet en-tete, y compris sur workers.dev.
    headers.set('Cache-Control', 'public, max-age=86400');
    return new Response(response.body, { status: response.status, headers });
  } catch (e) {
    return new Response('Asset proxy error', { status: 502 });
  }
}

// Extrait le domaine enregistrable : player.canal.fr -> canal.fr
// Gere les suffixes composes courants (.co.uk, .gouv.fr, .com.br...).
function domaineRacine(host) {
  const h = String(host).toLowerCase().replace(/^www\./, '');
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  const composes = ['co.uk','org.uk','gov.uk','ac.uk','com.au','com.br','co.jp',
                    'gouv.fr','asso.fr','com.mx','co.nz','co.za'];
  const deux = parts.slice(-2).join('.');
  if (composes.includes(deux)) return parts.slice(-3).join('.');
  return deux;
}

// ════════════════════════════════════════════════════════════════
// SÉCURITÉ (serveur) — liste blanche officielle + assembleur du bridge
// ════════════════════════════════════════════════════════════════
const DOMAINES_OFFICIELS = new Set([
  'ameli.fr', 'assurance-maladie.ameli.fr',
  'impots.gouv.fr', 'service-public.fr',
  'caf.fr', 'msa.fr', 'urssaf.fr',
  'francetravail.fr', 'pole-emploi.fr',
  'laposte.fr', 'laposte.net',
  'ants.gouv.fr', 'franceconnect.gouv.fr',
  'mesdroitssociaux.gouv.fr', 'info-retraite.fr',
  'lassuranceretraite.fr', 'agirc-arrco.fr',
  'chorus-pro.gouv.fr', 'demarches-simplifiees.fr',
]);

function estOfficiel(host) {
  host = String(host || '').toLowerCase().replace(/^www\./, '');
  if (host === 'gouv.fr' || host.endsWith('.gouv.fr')) return true;
  if (DOMAINES_OFFICIELS.has(host)) return true;
  return DOMAINES_OFFICIELS.has(domaineRacine(host));
}

// ════════════════════════════════════════════════════════════════
// 03 — GLOSSAIRE ADMIN (partagé : "Explique-moi" + futur multilingue)
// ════════════════════════════════════════════════════════════════
//
// Clés en minuscules, sans accent optionnel (on normalise à la lecture).
// Départ à ~35 termes : c'est la base la plus rentable. Étends-la
// librement — chaque ajout est gratuit et instantané (aucun appel IA).
//
// Ce même objet servira au module multilingue : tu ajouteras plus tard
// une table { terme -> { ar:'...', pt:'...' } }. Ne change pas la forme.

const GLOSSAIRE_ADMIN = {
  "attestation": "Un document officiel qui prouve quelque chose (par exemple que tu as bien des droits).",
  "ayant droit": "Une personne qui bénéficie de tes droits, comme ton conjoint ou tes enfants.",
  "forclusion": "Le délai est passé : tu ne peux plus faire cette démarche pour cette période.",
  "regime": "Le groupe qui gère ta protection sociale (salariés, indépendants, agriculteurs…).",
  "cotisation": "L'argent prélevé sur ton revenu pour financer la Sécurité sociale et la retraite.",
  "prelevement a la source": "L'impôt retiré directement sur ton salaire ou ta pension, chaque mois.",
  "avis d'imposition": "Le document qui indique combien d'impôt tu dois payer pour l'année.",
  "quotient familial": "Un calcul qui adapte ton impôt au nombre de personnes dans ton foyer.",
  "foyer fiscal": "L'ensemble des personnes déclarées ensemble pour les impôts.",
  "titulaire": "La personne principale, celle au nom de qui est le compte ou le dossier.",
  "beneficiaire": "La personne qui reçoit l'aide, le paiement ou la prestation.",
  "justificatif": "Un papier qui prouve ce que tu déclares (facture, quittance, attestation…).",
  "rib": "Relevé d'Identité Bancaire : les coordonnées de ton compte pour recevoir un virement.",
  "iban": "Le numéro international de ton compte bancaire, sur ton RIB.",
  "prestation": "Une aide ou un versement de l'administration (allocation, remboursement…).",
  "allocation": "Une somme versée régulièrement pour t'aider (logement, famille, etc.).",
  "echeance": "La date limite avant laquelle il faut agir ou payer.",
  "recours": "Une démarche pour contester une décision que tu juges injuste.",
  "notification": "Un message officiel qui t'informe d'une décision te concernant.",
  "affiliation": "Ton rattachement à un organisme (caisse d'assurance maladie, retraite…).",
  "carte vitale": "La carte verte qui prouve tes droits à l'Assurance Maladie.",
  "tiers payant": "Tu n'avances pas les frais : l'Assurance Maladie paie directement.",
  "ald": "Affection Longue Durée : une maladie grave prise en charge à 100 %.",
  "cpam": "Caisse Primaire d'Assurance Maladie : ton interlocuteur santé local.",
  "caf": "Caisse d'Allocations Familiales : elle verse les aides famille et logement.",
  "apl": "Aide Personnalisée au Logement : une aide pour payer ton loyer.",
  "trimestre": "Une période de 3 mois qui compte pour ta retraite.",
  "liquidation": "Le calcul et la mise en paiement de ta retraite (ce n'est pas une fermeture).",
  "usager": "Toi, en tant que personne qui utilise un service public.",
  "mandataire": "Une personne autorisée à agir à ta place pour une démarche.",
  "procuration": "L'autorisation que tu donnes à quelqu'un d'agir en ton nom.",
  "reclamation": "Une demande pour signaler un problème et obtenir une correction.",
  "franchise": "La petite part qui reste à ta charge sur certains soins ou médicaments.",
  "plafond": "La limite maximale (de revenu, de remboursement, d'aide…).",
  "declaration": "Le fait de communiquer officiellement tes informations à l'administration.",
};

// Assemble le bridge existant + les modules du lot 1 (chacun isolé).
// ════════════════════════════════════════════════════════════════
// GLOSSAIRES MULTILINGUES (lot 2) — termes d'interface + langues TTS
// ════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════
// 09a — GLOSSAIRE MULTILINGUE (termes d'interface les plus fréquents)
// ════════════════════════════════════════════════════════════════
//
// On ne traduit JAMAIS la page. On traduit la COUCHE Astrid (volet
// lecture, étiquette du pointeur, voix), et on garde le terme officiel
// français à côté pour que la personne retrouve le vrai bouton.
//
// Ce table couvre les mots qui reviennent sur 80 % des boutons : ils
// sont traduits SANS aucun appel IA (instantané, gratuit). Le texte
// unique de la page, lui, part à l'IA via 'translate-request'.
//
// Clé = terme FR en minuscules. Étends librement.

const GLOSSAIRE_MULTI = {
  "valider":      { ar: "تأكيد",        pt: "Validar",     tr: "Onayla",     es: "Validar",     en: "Confirm" },
  "suivant":      { ar: "التالي",       pt: "Seguinte",    tr: "İleri",      es: "Siguiente",   en: "Next" },
  "precedent":    { ar: "السابق",       pt: "Anterior",    tr: "Geri",       es: "Anterior",    en: "Back" },
  "continuer":    { ar: "متابعة",       pt: "Continuar",   tr: "Devam et",   es: "Continuar",   en: "Continue" },
  "annuler":      { ar: "إلغاء",        pt: "Cancelar",    tr: "İptal",      es: "Cancelar",    en: "Cancel" },
  "envoyer":      { ar: "إرسال",        pt: "Enviar",      tr: "Gönder",     es: "Enviar",      en: "Send" },
  "rechercher":   { ar: "بحث",          pt: "Pesquisar",   tr: "Ara",        es: "Buscar",      en: "Search" },
  "se connecter": { ar: "تسجيل الدخول", pt: "Entrar",      tr: "Giriş yap",  es: "Iniciar sesión", en: "Log in" },
  "connexion":    { ar: "تسجيل الدخول", pt: "Ligação",     tr: "Giriş",      es: "Conexión",    en: "Login" },
  "s'inscrire":   { ar: "إنشاء حساب",   pt: "Inscrever-se",tr: "Kayıt ol",   es: "Registrarse", en: "Sign up" },
  "mot de passe": { ar: "كلمة المرور",  pt: "Palavra-passe",tr: "Şifre",     es: "Contraseña",  en: "Password" },
  "telecharger":  { ar: "تنزيل",        pt: "Descarregar", tr: "İndir",      es: "Descargar",   en: "Download" },
  "imprimer":     { ar: "طباعة",        pt: "Imprimir",    tr: "Yazdır",     es: "Imprimir",    en: "Print" },
  "payer":        { ar: "الدفع",        pt: "Pagar",       tr: "Öde",        es: "Pagar",       en: "Pay" },
  "accueil":      { ar: "الرئيسية",     pt: "Início",      tr: "Ana sayfa",  es: "Inicio",      en: "Home" },
  "menu":         { ar: "القائمة",      pt: "Menu",        tr: "Menü",       es: "Menú",        en: "Menu" },
  "fermer":       { ar: "إغلاق",        pt: "Fechar",      tr: "Kapat",      es: "Cerrar",      en: "Close" },
  "oui":          { ar: "نعم",          pt: "Sim",         tr: "Evet",       es: "Sí",          en: "Yes" },
  "non":          { ar: "لا",           pt: "Não",         tr: "Hayır",      es: "No",          en: "No" },
  "modifier":     { ar: "تعديل",        pt: "Modificar",   tr: "Değiştir",   es: "Modificar",   en: "Edit" },
  "confirmer":    { ar: "تأكيد",        pt: "Confirmar",   tr: "Onayla",     es: "Confirmar",   en: "Confirm" },
  "retour":       { ar: "رجوع",         pt: "Voltar",      tr: "Geri dön",   es: "Volver",      en: "Return" },
};

// codes de langue pour la synthèse vocale (TTS)
const LANG_TTS = { ar: "ar-SA", pt: "pt-PT", tr: "tr-TR", es: "es-ES", en: "en-US", fr: "fr-FR" };
const LANGUES_DISPO = [
  { code: "fr", nom: "Français" },
  { code: "ar", nom: "العربية" },
  { code: "pt", nom: "Português" },
  { code: "tr", nom: "Türkçe" },
  { code: "es", nom: "Español" },
  { code: "en", nom: "English" },
];

function buildFullBridge(proxyOrigin, targetRoot) {
  const cfg = {
    proxyOrigin: proxyOrigin,
    targetRoot: targetRoot,
    lang: 'fr-FR',
    officielsList: Array.from(DOMAINES_OFFICIELS),
    glossaire: GLOSSAIRE_ADMIN,
    glossaireMulti: GLOSSAIRE_MULTI,
    languesDispo: LANGUES_DISPO,
    langTts: LANG_TTS,
  };
  return [
    buildBridgeScript(proxyOrigin, targetRoot),
    '<script>' + featForms(cfg)        + '</script>',
    '<script>' + featSecurite(cfg)     + '</script>',
    '<script>' + featTTS(cfg)          + '</script>',
    '<script>' + featExplique(cfg)     + '</script>',
    '<script>' + featAntiAbandon(cfg)  + '</script>',
    '<script>' + featMultilingue(cfg)  + '</script>',
    '<script>' + featRemplissage(cfg)  + '</script>',
    '<script>' + featParcours(cfg)     + '</script>',
    '<script>' + featPreuve(cfg)       + '</script>',
    '<script>' + featVoixRelais(cfg)   + '</script>',
  ].join('\n');
}

function buildBridgeScript(proxyOrigin, targetRoot) {
  return `<script>
(function(){
  var PROXY_ORIGIN = '${proxyOrigin}';
  var TARGET_ROOT = '${targetRoot}';
  var HIGHLIGHT_ID = '__oapi_highlight__';
  document.addEventListener('click', function(e) {
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href || href.indexOf('javascript:') === 0 || href.charAt(0) === '#') return;
    if (href.indexOf('mailto:') === 0 || href.indexOf('tel:') === 0) return;
    if (a.getAttribute('target') === '_blank') return;
    if (a.hasAttribute('download')) return;
    var absoluteUrl, absHost;
    try {
      var u = new URL(href, document.baseURI);
      absoluteUrl = u.href;
      absHost = u.host;
    } catch (err) { return; }
    if (absoluteUrl.indexOf(PROXY_ORIGIN) === 0) return;
    // meme domaine racine (sous-domaines compris) -> on reste dans le proxy
    var memeRacine = absHost === TARGET_ROOT || absHost.slice(-(TARGET_ROOT.length + 1)) === '.' + TARGET_ROOT;
    if (memeRacine || a.hasAttribute('data-internal')) {
      e.preventDefault();
      window.location.href = PROXY_ORIGIN + '/proxy-web?url=' + encodeURIComponent(absoluteUrl);
    } else {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
  }, true);
  function sendReady() {
    try {
      window.parent.postMessage({
        source: 'ohapiday-bridge',
        type: 'ready',
        url: window.location.href,
        title: document.title
      }, '*');
    } catch (e) {}
  }
  function sanitizeLabel(label) {
    if (!label) return '';
    var s = String(label);
    if (s.length > 80) s = s.substring(0, 80);
    // Pas de sequence Unicode echappee dans un template literal : elle est
    // interpretee trop tot et produit une regex INVALIDE, ce qui empechait
    // TOUT le bridge de demarrer (donc aucun pointage).
    var propre = '';
    for (var ci = 0; ci < s.length; ci++) {
      var cc = s.charCodeAt(ci);
      propre += (cc < 32 || cc === 127) ? ' ' : s.charAt(ci);
    }
    s = propre;
    // Sequence Unicode echappee INTERPRETEE par le template literal : le
    // backtick reel se retrouvait dans la sortie et fermait le template.
    s = s.split('"').join("'").split(String.fromCharCode(96)).join("'");
    var bad = /\\b(ignore|disregard|forget)\\s+(all|previous|tout)\\b|\\b(you are now|tu es maintenant|jailbreak)\\b|\\[INST\\]|<\\|.+?\\|>/i;
    if (bad.test(s)) return '[filtered]';
    return s.replace(/\\s+/g, ' ').trim();
  }
  function extractDOM() {
    var sel = 'a, button, input, select, textarea, [role="button"], [role="link"]';
    var nodes = document.querySelectorAll(sel);
    var elements = [];
    var MAX = 80;
    for (var i = 0; i < nodes.length && elements.length < MAX; i++) {
      var el = nodes[i];
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      var style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) continue;
      var rawLabel = (el.textContent || el.value || el.placeholder || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
      var label = sanitizeLabel(rawLabel);
      if (!label || label.length < 2 || label === '[filtered]') continue;
      var selector;
      if (el.id) {
        try { selector = '#' + CSS.escape(el.id); }
        catch(e) { selector = '#' + el.id; }
      } else {
        var navId = 'navel-' + i + '-' + Date.now().toString(36);
        el.setAttribute('data-nav-id', navId);
        selector = '[data-nav-id="' + navId + '"]';
      }
      elements.push({ tag: el.tagName.toLowerCase(), label: label, selector: selector });
    }
    return {
      title: sanitizeLabel(document.title || ''),
      elements: elements,
      isLimited: nodes.length > MAX,
      totalInteractive: nodes.length
    };
  }
  function findByText(searchText) {
    if (!searchText) return null;
    var target = String(searchText).toLowerCase().trim();
    if (target.length < 2) return null;
    var interactiveSel = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [onclick]';
    var nodes = document.querySelectorAll(interactiveSel);
    var bestExact = null;
    var bestContains = null;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      var style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      var label = (el.textContent || el.value || el.placeholder || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
      if (!label) continue;
      var labelLower = label.toLowerCase();
      if (labelLower === target) {
        bestExact = { el: el, label: label.substring(0, 80) };
        break;
      }
      if (!bestContains && labelLower.indexOf(target) !== -1) {
        bestContains = { el: el, label: label.substring(0, 80) };
      }
    }
    var match = bestExact || bestContains;
    if (!match) {
      var allNodes = document.querySelectorAll('*');
      for (var j = 0; j < allNodes.length && j < 5000; j++) {
        var el2 = allNodes[j];
        var cs2 = window.getComputedStyle(el2);
        if (cs2.cursor !== 'pointer') continue;
        var rect2 = el2.getBoundingClientRect();
        if (rect2.width === 0 || rect2.height === 0) continue;
        var l2 = (el2.textContent || '').trim();
        if (l2.toLowerCase().indexOf(target) !== -1 && l2.length < 100) {
          match = { el: el2, label: l2.substring(0, 80) };
          break;
        }
      }
    }
    if (!match) return null;
    var selector;
    if (match.el.id) {
      try { selector = '#' + CSS.escape(match.el.id); }
      catch(e) { selector = '#' + match.el.id; }
    } else {
      var navId = 'navfind-' + Date.now().toString(36);
      match.el.setAttribute('data-nav-id', navId);
      selector = '[data-nav-id="' + navId + '"]';
    }
    return { selector: selector, label: match.label };
  }
  function detectDarkPatterns() {
    var warnings = [];
    try {
      var checkedBoxes = document.querySelectorAll('input[type="checkbox"][checked], input[type="checkbox"]:checked');
      var suspiciousChecks = 0;
      checkedBoxes.forEach(function(cb) {
        var label = '';
        if (cb.id) {
          var lbl = document.querySelector('label[for="' + cb.id + '"]');
          if (lbl) label = lbl.textContent || '';
        }
        if (!label && cb.parentElement) {
          label = cb.parentElement.textContent || '';
        }
        label = label.toLowerCase().substring(0, 200);
        if (/newsletter|partenaire|offre|publicit|marketing|tiers|sponsor|inscrire|recevoir/.test(label)) {
          suspiciousChecks++;
        }
      });
      if (suspiciousChecks > 0) {
        warnings.push({
          level: 'info',
          text: suspiciousChecks + ' case(s) cochée(s) par défaut sur cette page. Vérifie chacune avant de valider.'
        });
      }
      var allBtns = document.querySelectorAll('button, a[role="button"], [class*="accept"], [class*="agree"]');
      var bigAccept = null;
      var smallReject = null;
      allBtns.forEach(function(b) {
        var txt = (b.textContent || '').toLowerCase().trim().substring(0, 50);
        var r = b.getBoundingClientRect();
        var area = r.width * r.height;
        if (area === 0) return;
        if (/^(accepter|tout accepter|accept all|j'accepte|ok|continuer)/.test(txt) && area > 6000) {
          if (!bigAccept || area > bigAccept.area) bigAccept = { el: b, area: area, txt: txt };
        }
        if (/^(refuser|continuer sans|tout refuser|reject|non merci|paramétrer|gérer)/.test(txt) && area < 4000) {
          if (!smallReject || area < smallReject.area) smallReject = { el: b, area: area, txt: txt };
        }
      });
      if (bigAccept && smallReject && bigAccept.area > smallReject.area * 1.8) {
        warnings.push({
          level: 'info',
          text: 'Sur cette page, le bouton "' + bigAccept.txt + '" est nettement plus grand que "' + smallReject.txt + '". Prends ton temps pour choisir.'
        });
      }
      var bodyText = (document.body.textContent || '').toLowerCase();
      if (/plus que \\d+ (place|article|en stock|disponible)/.test(bodyText) ||
          /offre se termine dans/.test(bodyText) ||
          /(\\d{1,2}:\\d{2}:\\d{2})/.test(bodyText)) {
        var timers = document.querySelectorAll('[class*="countdown"], [class*="timer"], [id*="countdown"]');
        if (timers.length > 0) {
          warnings.push({
            level: 'info',
            text: 'Compte à rebours visible sur cette page. Pas besoin de te précipiter.'
          });
        }
      }
      allBtns.forEach(function(b) {
        var txt = (b.textContent || '').toLowerCase().trim().substring(0, 100);
        if (/non merci.*(payer|prix fort|cher)|je ne veux pas (économiser|gagner)/.test(txt)) {
          warnings.push({
            level: 'info',
            text: 'Texte du bouton à lire attentivement : "' + (b.textContent || '').trim().substring(0, 80) + '". Choisis selon ce que tu veux vraiment.'
          });
        }
      });
    } catch (e) {}
    return warnings;
  }
  function clickElement(selector) {
    if (!selector) return false;
    var el;
    try { el = document.querySelector(selector); } catch (e) { return false; }
    if (!el) return false;
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    if (el.disabled) return false;
    if (rect.top < 0 || rect.bottom > window.innerHeight) {
      try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch(e) {}
    }
    try {
      if (typeof el.focus === 'function') el.focus();
      el.click();
      return true;
    } catch (e) {
      try {
        var evt = new MouseEvent('click', {
          bubbles: true, cancelable: true, view: window
        });
        el.dispatchEvent(evt);
        return true;
      } catch (e2) {
        return false;
      }
    }
  }
  // ═══════════════════════════════════════════════════════════════
  //  POINTAGE — rendu IDENTIQUE a window.astridPoint de l'application
  // ═══════════════════════════════════════════════════════════════
  //  TROIS couches superposees, pas une :
  //   1. .astrid-pointed       outline orange SUR la cible, epouse sa forme
  //   2. .astrid-point-circle  le ROND qui l'entoure, halo pulsant
  //   3. .astrid-point-arrow   le doigt qui rebondit AU-DESSUS + la bulle
  //  Avant : un seul cadre, avec un doigt a l'envers DANS la bulle.
  var PT_OVERLAY = 'astrid-point-overlay';
  var ptCible = null, ptTimerMaj = null, ptTimerFin = null;
  // Ce qu'on montre en ce moment. Sert a savoir si la personne a clique
  // AILLEURS : sans cela, la sequence avancait meme apres un mauvais clic,
  // et on se retrouvait perdu a trois pages de profondeur sans le savoir.
  var ptAttendu = null;   // { el, selector, label }
  // L'ecouteur de clic doit etre RETIRE quand le pointage s'arrete.
  // Sinon pointer deux fois le meme bouton attache deux ecouteurs, et un
  // seul clic envoie deux 'target-clicked' : la sequence saute une etape.
  var ptEcouteur = null, ptElEcoute = null;

  function ptCss(){
    if (document.getElementById('astrid-point-styles')) return;
    var st = document.createElement('style');
    st.id = 'astrid-point-styles';
    st.textContent = [
      '#astrid-point-overlay{position:fixed;pointer-events:none;z-index:2147483646;opacity:0;transition:opacity .3s ease}',
      '.astrid-point-circle{position:absolute;inset:0;border-radius:50%;border:4px solid #FF9500;',
      '  box-shadow:0 0 0 4px rgba(255,149,0,0.25),0 0 28px rgba(255,149,0,0.65),inset 0 0 14px rgba(255,149,0,0.20);',
      '  background:rgba(255,149,0,0.05);animation:astridPointPulse 1.6s ease-in-out infinite}',
      '.astrid-point-arrow{position:absolute;top:-44px;left:50%;transform:translateX(-50%);font-size:30px;',
      '  animation:astridArrowBounce .8s ease-in-out infinite alternate;',
      '  filter:drop-shadow(0 2px 6px rgba(255,149,0,0.7))}',
      '.astrid-point-label{position:absolute;top:calc(100% + 14px);left:50%;transform:translateX(-50%);',
      '  background:linear-gradient(135deg,#2a1a00,#1a0e2e);color:#FFD93D;padding:9px 15px;border-radius:11px;',
      '  font-size:12px;font-weight:700;white-space:nowrap;max-width:280px;text-overflow:ellipsis;overflow:hidden;',
      '  box-shadow:0 8px 24px rgba(0,0,0,0.5);letter-spacing:.01em;line-height:1.45;pointer-events:none;',
      '  border:1px solid rgba(255,182,39,0.55);animation:astridLabelIn .35s cubic-bezier(.16,1,.3,1)}',
      '.astrid-point-label::before{content:"";position:absolute;top:-7px;left:50%;transform:translateX(-50%);',
      '  border:7px solid transparent;border-bottom-color:#2a1a00;border-top:none}',
      '@keyframes astridPointPulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.12);opacity:.85}}',
      '@keyframes astridArrowBounce{from{transform:translateX(-50%) translateY(0)}to{transform:translateX(-50%) translateY(10px)}}',
      '@keyframes astridLabelIn{from{opacity:0;transform:translateX(-50%) translateY(-6px) scale(.9)}',
      '  to{opacity:1;transform:translateX(-50%) translateY(0) scale(1)}}',
      '.astrid-pointed{position:relative;z-index:2147483645 !important;overflow:visible !important;',
      '  outline:3px solid #FF9500 !important;outline-offset:3px !important;scroll-margin:120px;',
      '  animation:astridPointedPulse 1.4s ease-in-out infinite !important}',
      '@keyframes astridPointedPulse{',
      '  0%,100%{box-shadow:0 0 0 0 rgba(255,149,0,0.6),0 0 28px 6px rgba(255,149,0,0.55),0 0 0 3px rgba(255,149,0,0.85) !important}',
      '  50%{box-shadow:0 0 0 8px rgba(255,149,0,0.15),0 0 36px 10px rgba(255,149,0,0.75),0 0 0 3px rgba(255,149,0,1) !important}}',
      '.astrid-pointed-parent-fix{overflow:visible !important}'
    ].join(String.fromCharCode(10));
    document.head.appendChild(st);
  }

  function ptCacher(){
    if (ptTimerMaj){ clearInterval(ptTimerMaj); ptTimerMaj = null; }
    if (ptTimerFin){ clearTimeout(ptTimerFin); ptTimerFin = null; }
    ptCible = null;
    ptAttendu = null;
    if (ptElEcoute && ptEcouteur) {
      try { ptElEcoute.removeEventListener('click', ptEcouteur); } catch (e) {}
    }
    ptEcouteur = null; ptElEcoute = null;
    document.querySelectorAll('.astrid-pointed, .astrid-pointed-parent-fix').forEach(function(n){
      n.classList.remove('astrid-pointed');
      n.classList.remove('astrid-pointed-parent-fix');
    });
    [PT_OVERLAY, HIGHLIGHT_ID].forEach(function(id){
      var n = document.getElementById(id);
      if (n && n.parentNode) n.parentNode.removeChild(n);
    });
  }

  function ptOverlay(){
    var ov = document.getElementById(PT_OVERLAY);
    if (ov) return ov;
    ov = document.createElement('div');
    ov.id = PT_OVERLAY;
    ov.innerHTML = '<div class="astrid-point-arrow">👇</div>'
                 + '<div class="astrid-point-circle"></div>'
                 + '<div class="astrid-point-label"></div>';
    document.body.appendChild(ov);
    return ov;
  }

  function ptMaj(ov){
    if (!ov || !ptCible || !ptCible.isConnected){ ptCacher(); return; }
    var rect = ptCible.getBoundingClientRect();
    var large = rect.width > 200, haute = rect.height > 200;
    var taille, cx, cy;
    if (large || haute){
      taille = 64;
      cx = rect.left + Math.min(rect.width, 100) / 2 + (large ? 20 : 0);
      cy = rect.top + Math.min(rect.height, 64) / 2 + (haute ? 12 : 0);
    } else {
      taille = Math.max(50, Math.max(rect.width, rect.height) + 14);
      cx = rect.left + rect.width / 2;
      cy = rect.top + rect.height / 2;
    }
    ov.style.left   = (cx - taille / 2) + 'px';
    ov.style.top    = (cy - taille / 2) + 'px';
    ov.style.width  = taille + 'px';
    ov.style.height = taille + 'px';
    var visible = rect.bottom > 0 && rect.top < window.innerHeight
               && rect.right > 0 && rect.left < window.innerWidth;
    ov.style.opacity = visible ? '1' : '0';
  }

  // ═══════════════════════════════════════════════════════════════
  //  CLIC HORS CIBLE — on previent l'app AVANT qu'elle n'avance
  // ═══════════════════════════════════════════════════════════════
  //  Sans cela, un clic a cote faisait avancer la sequence quand meme :
  //  la personne se retrouvait trois pages plus loin, au mauvais endroit,
  //  sans que rien ne le signale. Elle croit avoir mal fait, elle ferme.
  //
  //  On observe en phase de capture pour passer AVANT les gestionnaires
  //  de la page, et on ne bloque jamais le clic : on rapporte, c'est tout.
  document.addEventListener('click', function(ev){
    if (!ptAttendu || !ptAttendu.el) return;

    // Clic sur la cible, ou sur un enfant de la cible (icone, span…) : c'est bon.
    var n = ev.target;
    while (n) {
      if (n === ptAttendu.el) return;
      n = n.parentElement;
    }

    // Clic ailleurs : que decrire ? On remonte au premier element cliquable
    // pour donner un libelle utile a Astrid, pas un <span> anonyme.
    var cliquable = ev.target, prof = 0;
    while (cliquable && prof < 6) {
      var tg = cliquable.tagName;
      if (tg === 'A' || tg === 'BUTTON' ||
          cliquable.getAttribute && cliquable.getAttribute('role') === 'button' ||
          (tg === 'INPUT' && /submit|button/i.test(cliquable.type || ''))) break;
      cliquable = cliquable.parentElement; prof++;
    }
    var quoi = cliquable || ev.target;
    var texte = '';
    try {
      texte = (quoi.innerText || quoi.value || quoi.getAttribute('aria-label') ||
               quoi.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    } catch (e) {}

    try {
      window.parent.postMessage({
        source: 'ohapiday-bridge',
        type: 'clic-hors-cible',
        attendu: ptAttendu.label,
        attenduSelector: ptAttendu.selector,
        clique: texte,
        cliqueTag: (quoi.tagName || '').toLowerCase()
      }, '*');
    } catch (e) {}
  }, true);

  function highlightElement(selector, label, safeBottom, largeMode) {
    var el;
    try { el = (typeof selector === 'string') ? document.querySelector(selector) : selector; }
    catch (e) { return false; }
    if (!el) return false;

    ptCss();
    ptCacher();
    ptCible = el;
    ptAttendu = {
      el: el,
      selector: (typeof selector === 'string') ? selector : '',
      label: label || ''
    };
    el.classList.add('astrid-pointed');

    // Les parents en overflow:hidden coupent le halo — on les ouvre,
    // jusqu'a 10 niveaux comme dans l'application.
    var parent = el.parentElement, prof = 0;
    while (parent && prof < 10){
      var cs = window.getComputedStyle(parent);
      if (cs.overflow === 'hidden' || cs.overflowX === 'hidden' || cs.overflowY === 'hidden'){
        parent.classList.add('astrid-pointed-parent-fix');
      }
      parent = parent.parentElement; prof++;
    }

    var ov = ptOverlay();
    var lab = ov.querySelector('.astrid-point-label');
    if (lab){
      lab.textContent = label || '';
      lab.style.display = label ? '' : 'none';
    }

    try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
    setTimeout(function(){ ptMaj(ov); ov.style.opacity = '1'; }, 500);
    ptTimerMaj = setInterval(function(){ ptMaj(ov); }, 120);

    function onClickTarget() {
      ptCacher();
      el.removeEventListener('click', onClickTarget);
      try {
        window.parent.postMessage({
          source: 'ohapiday-bridge',
          type: 'target-clicked',
          selector: (typeof selector === 'string') ? selector : '',
          label: label || ''
        }, '*');
      } catch (e) {}
    }
    ptEcouteur = onClickTarget; ptElEcoute = el;
    el.addEventListener('click', onClickTarget);

    ptTimerFin = setTimeout(ptCacher, 12000);
    return true;
  }
  window.addEventListener('message', function(ev) {
    var d = ev.data;
    if (!d || typeof d !== 'object' || d.source !== 'ohapiday-app') return;
    if (d.type === 'extract-dom') {
      var dom = extractDOM();
      try {
        dom.heuristicWarnings = detectDarkPatterns();
      } catch (e) {
        dom.heuristicWarnings = [];
      }
      try {
        window.parent.postMessage({
          source: 'ohapiday-bridge',
          type: 'dom',
          requestId: d.requestId,
          dom: dom
        }, '*');
      } catch (e) {}
    }
    else if (d.type === 'highlight') {
      var ok = highlightElement(d.selector, d.label, d.safeBottom, d.largeMode);
      try {
        window.parent.postMessage({
          source: 'ohapiday-bridge',
          type: 'highlight-result',
          requestId: d.requestId,
          ok: ok
        }, '*');
      } catch (e) {}
    }
    else if (d.type === 'find-by-text') {
      var found = findByText(d.text);
      try {
        window.parent.postMessage({
          source: 'ohapiday-bridge',
          type: 'find-result',
          requestId: d.requestId,
          found: found
        }, '*');
      } catch (e) {}
    }
    else if (d.type === 'click') {
      var ok = clickElement(d.selector);
      try {
        window.parent.postMessage({
          source: 'ohapiday-bridge',
          type: 'click-result',
          requestId: d.requestId,
          ok: ok
        }, '*');
      } catch (e) {}
      if (ok) {
        setTimeout(function() {
          try {
            window.parent.postMessage({
              source: 'ohapiday-bridge',
              type: 'target-clicked',
              selector: d.selector
            }, '*');
          } catch (e) {}
        }, 200);
      }
    }
  });
  if (document.readyState === 'complete') {
    sendReady();
  } else {
    window.addEventListener('load', sendReady);
  }
  setTimeout(sendReady, 500);
  setTimeout(sendReady, 1500);
})();
</script>
`;
}

function homePage(origin) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Passerelle Oh API Day</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:600px;margin:60px auto;padding:0 24px;color:#1F1135;line-height:1.6}
h1{color:#8B1A1A;font-size:28px;margin:0 0 6px}
.sub{color:#8B5A0B;font-weight:600;margin-bottom:24px}
code{background:#F5E6D3;padding:2px 8px;border-radius:6px;font-family:'Courier New',monospace;font-size:13px;word-break:break-all}
.ok{padding:14px 16px;background:#10b98115;border:1px solid #10b98140;border-radius:10px;color:#065f46;margin:18px 0}
a{color:#8B1A1A;font-weight:600}
</style></head>
<body>
<h1>🌉 Passerelle Web Active</h1>
<div class="sub">Worker Cloudflare déployé pour Oh API Day</div>
<div class="ok">✅ Tout fonctionne ! Tu peux maintenant utiliser cette URL dans Astrid Navig.</div>
<h3>URL à copier dans Astrid :</h3>
<code>${origin}</code>
<h3>Routes disponibles :</h3>
<ul>
  <li><code>${origin}/proxy-web?url=&lt;site&gt;</code> — proxifier une page</li>
  <li><code>${origin}/proxy-asset?url=&lt;asset&gt;</code> — proxifier un asset</li>
</ul>
<h3>Fonctionnalités du bridge :</h3>
<ul>
  <li>✓ X-Frame-Options stripped</li>
  <li>✓ Liens internes routés via proxy</li>
  <li>✓ Astrid peut pointer DANS la page (cercle orange + label)</li>
  <li>✓ Astrid peut lire les éléments interactifs de la page</li>
</ul>
<p style="margin-top:36px;color:#5a4030;font-size:13px">
Pour modifier : <a href="https://dash.cloudflare.com" target="_blank">dash.cloudflare.com</a>
</p>
</body></html>`;
}

const CONAV_TTL_SECONDS = 3600;
const CONAV_MAX_EVENTS = 200;
const CONAV_CODE_LENGTH = 6;

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}
function genCode() {
  var c = '';
  for (var i = 0; i < CONAV_CODE_LENGTH; i++) c += Math.floor(Math.random() * 10);
  return c;
}
function genToken() {
  return Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
}
async function loadSession(env, code) {
  const raw = await env.CONAV_SESSIONS.get('s:' + code);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
async function saveSession(env, session) {
  session.lastActivity = Date.now();
  await env.CONAV_SESSIONS.put('s:' + session.code, JSON.stringify(session), {
    expirationTtl: CONAV_TTL_SECONDS
  });
}
async function hmacSha256(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function verifyClientToken(request, env) {
  const auth = request.headers.get('X-Astrid-Auth');
  if (!auth) return { ok: false, reason: 'Token manquant' };
  const parts = auth.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'Format token invalide' };
  const [tsStr, signature] = parts;
  const ts = parseInt(tsStr, 10);
  if (isNaN(ts)) return { ok: false, reason: 'Timestamp invalide' };
  const now = Date.now();
  if (now - ts > 5 * 60 * 1000) return { ok: false, reason: 'Token expiré' };
  if (ts - now > 60 * 1000) return { ok: false, reason: 'Token futur' };
  const secret = (env && env.ASTRID_SHARED_SECRET) || 'astrid-default-secret-change-in-prod-v1';
  const expected = await hmacSha256(secret, tsStr);
  if (signature !== expected) return { ok: false, reason: 'Signature invalide' };
  return { ok: true };
}
async function rateLimitByIP(env, ip, action, max, windowSec) {
  if (!env || !env.RATELIMIT || !ip) return false;
  const key = 'rl:' + action + ':' + ip;
  const cur = await env.RATELIMIT.get(key);
  const count = parseInt(cur, 10) || 0;
  if (count >= max) return true;
  await env.RATELIMIT.put(key, String(count + 1), { expirationTtl: windowSec });
  return false;
}
async function heartbeatReceive(request, env) {
  if (!env || !env.CONAV_SESSIONS) {
    return jsonResponse({ ok: false, reason: 'KV indispo' }, 503);
  }
  let body;
  try { body = await request.json(); } catch (e) {
    return jsonResponse({ error: 'JSON invalide' }, 400);
  }
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (await rateLimitByIP(env, ip, 'hb', 50, 600)) {
    return jsonResponse({ ok: false, reason: 'rate limit' }, 429);
  }
  let events = [];
  if (body && Array.isArray(body.batch)) {
    events = body.batch.slice(0, 50);
  } else if (body && body.event) {
    events = [body];
  } else {
    return jsonResponse({ error: 'Format invalide' }, 400);
  }
  const buckets = new Map();
  for (const evt of events) {
    if (!evt) continue;
    const event = String(evt.event || '').substring(0, 32).replace(/[^a-z0-9_-]/gi, '');
    const success = evt.success === true || evt.success === false ? evt.success : null;
    const domain = String(evt.domain || '').substring(0, 80).replace(/[^a-z0-9.\-]/gi, '');
    const duration = typeof evt.duration === 'number' && evt.duration >= 0 && evt.duration < 600000
      ? Math.round(evt.duration) : null;
    if (!event) continue;
    const day = new Date(evt.ts || Date.now()).toISOString().substring(0, 10);
    const outcome = success === null ? 'na' : (success ? 'ok' : 'fail');
    const key = 'hb:' + day + ':' + event + ':' + outcome;
    if (!buckets.has(key)) {
      buckets.set(key, { count: 0, domains: {}, durationSum: 0, durationCount: 0 });
    }
    const b = buckets.get(key);
    b.count++;
    if (domain) b.domains[domain] = (b.domains[domain] || 0) + 1;
    if (duration !== null) {
      b.durationSum += duration;
      b.durationCount++;
    }
  }
  for (const [key, newAgg] of buckets) {
    try {
      const cur = await env.CONAV_SESSIONS.get(key);
      const agg = cur ? JSON.parse(cur) : { count: 0, domains: {}, durationSum: 0, durationCount: 0 };
      agg.count += newAgg.count;
      for (const [d, c] of Object.entries(newAgg.domains)) {
        agg.domains[d] = (agg.domains[d] || 0) + c;
      }
      agg.durationSum += newAgg.durationSum;
      agg.durationCount += newAgg.durationCount;
      const dKeys = Object.keys(agg.domains);
      if (dKeys.length > 100) {
        const sorted = dKeys.sort((a, b) => agg.domains[b] - agg.domains[a]).slice(0, 50);
        const trimmed = {};
        sorted.forEach(k => trimmed[k] = agg.domains[k]);
        agg.domains = trimmed;
      }
      await env.CONAV_SESSIONS.put(key, JSON.stringify(agg), { expirationTtl: 7 * 86400 });
    } catch (e) {}
  }
  return jsonResponse({ ok: true, processed: events.length, buckets: buckets.size });
}
const HB_AGREGAT_CLE = 'hb:stats:daily:latest';

// Lit UNE cle au lieu de parcourir tout le prefixe.
// 1 lecture KV par visite au lieu de 1001.
async function heartbeatStats(env) {
  if (!env || !env.CONAV_SESSIONS) {
    return jsonResponse({ error: 'KV indispo' }, 503);
  }
  try {
    const brut = await env.CONAV_SESSIONS.get(HB_AGREGAT_CLE);
    if (brut) {
      const cache = JSON.parse(brut);
      return jsonResponse({ ok: true, stats: cache.stats, generated: cache.generated, source: 'agregat' });
    }
    // Premier appel avant le passage du cron : on construit a la volee,
    // puis on ecrit l'agregat pour que les suivants soient gratuits.
    const stats = await reconstruireAgregatHeartbeat(env);
    return jsonResponse({ ok: true, stats: stats, generated: new Date().toISOString(), source: 'direct' });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

// Parcourt les compteurs bruts et ecrit UN agregat consultable.
// Appelee par le cron (1x/jour) ou au premier appel apres deploiement.
async function reconstruireAgregatHeartbeat(env) {
  if (!env || !env.CONAV_SESSIONS) return {};
  const stats = {};
  let curseur = undefined;

  do {
    const lot = await env.CONAV_SESSIONS.list({ prefix: 'hb:20', limit: 1000, cursor: curseur });
    for (const k of lot.keys) {
      const parts = k.name.split(':');          // hb:AAAA-MM-JJ:evenement:issue
      if (parts.length !== 4) continue;
      const v = await env.CONAV_SESSIONS.get(k.name);
      if (!v) continue;
      const [, jour, evenement, issue] = parts;
      stats[jour] = stats[jour] || {};
      stats[jour][evenement] = stats[jour][evenement] ||
        { ok: 0, fail: 0, na: 0, durationAvgMs: null, topDomains: {} };
      try {
        const agg = JSON.parse(v);
        stats[jour][evenement][issue] = agg.count;
        if (agg.durationCount > 0) {
          stats[jour][evenement].durationAvgMs = Math.round(agg.durationSum / agg.durationCount);
        }
        for (const [d, c] of Object.entries(agg.domains || {})) {
          stats[jour][evenement].topDomains[d] = (stats[jour][evenement].topDomains[d] || 0) + c;
        }
      } catch (e) {}
    }
    curseur = lot.list_complete ? undefined : lot.cursor;
  } while (curseur);

  try {
    await env.CONAV_SESSIONS.put(
      HB_AGREGAT_CLE,
      JSON.stringify({ stats: stats, generated: new Date().toISOString() }),
      { expirationTtl: 8 * 86400 }
    );
  } catch (e) { /* l'agregat est un confort, jamais bloquant */ }

  return stats;
}

async function conavCreate(env, request) {
  const auth = await verifyClientToken(request, env);
  if (!auth.ok) {
    return jsonResponse({ error: 'Auth requise : ' + auth.reason }, 401);
  }
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (await rateLimitByIP(env, ip, 'conav-create', 5, 600)) {
    return jsonResponse({ error: 'Trop de sessions créées récemment, réessaye dans 10 minutes.' }, 429);
  }
  let code = null;
  for (let i = 0; i < 5; i++) {
    const c = genCode();
    const existing = await env.CONAV_SESSIONS.get('s:' + c);
    if (!existing) { code = c; break; }
  }
  if (!code) return jsonResponse({ error: 'Impossible de générer un code unique, réessaye' }, 503);
  const session = {
    code: code,
    hostToken: genToken(),
    guestToken: null,
    currentUrl: '',
    events: [],
    hostName: 'Hôte',
    guestName: null,
    createdAt: Date.now(),
    lastActivity: Date.now()
  };
  await saveSession(env, session);
  return jsonResponse({
    ok: true,
    code: code,
    hostToken: session.hostToken,
    formatted: code.substring(0,3) + '-' + code.substring(3)
  });
}
async function conavJoin(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'JSON invalide' }, 400); }
  const code = String(body.code || '').replace(/[^0-9]/g, '');
  if (code.length !== CONAV_CODE_LENGTH) return jsonResponse({ error: 'Code invalide (6 chiffres attendus)' }, 400);
  const session = await loadSession(env, code);
  if (!session) return jsonResponse({ error: 'Session introuvable ou expirée' }, 404);
  if (session.guestToken) return jsonResponse({ error: 'Session déjà rejointe par quelqu\'un' }, 409);
  session.guestToken = genToken();
  if (body.name && typeof body.name === 'string') {
    session.guestName = String(body.name).substring(0, 30);
  } else {
    session.guestName = 'Invité';
  }
  session.events.push({
    id: 'e_' + Date.now().toString(36) + Math.random().toString(36).slice(2,5),
    type: 'guest-joined',
    from: 'system',
    name: session.guestName,
    ts: Date.now()
  });
  await saveSession(env, session);
  return jsonResponse({
    ok: true,
    guestToken: session.guestToken,
    currentUrl: session.currentUrl,
    hostName: session.hostName
  });
}
async function conavPoll(request, env) {
  const url = new URL(request.url);
  const code = (url.searchParams.get('code') || '').replace(/[^0-9]/g, '');
  const token = url.searchParams.get('token') || '';
  const since = parseInt(url.searchParams.get('since') || '0', 10);
  const session = await loadSession(env, code);
  if (!session) return jsonResponse({ error: 'Session expirée' }, 404);
  const role = (token === session.hostToken) ? 'host' :
               (token === session.guestToken) ? 'guest' : null;
  if (!role) return jsonResponse({ error: 'Token invalide' }, 403);
  const newEvents = (session.events || []).filter(e => e.ts > since && e.from !== role);
  const peerConnected = role === 'host' ? !!session.guestToken : true;
  return jsonResponse({
    ok: true,
    events: newEvents,
    serverTs: Date.now(),
    currentUrl: session.currentUrl,
    peerName: role === 'host' ? session.guestName : session.hostName,
    peerConnected: peerConnected
  });
}
async function conavSend(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'JSON invalide' }, 400); }
  const code = String(body.code || '').replace(/[^0-9]/g, '');
  const token = String(body.token || '');
  const type = String(body.type || '');
  if (!code || !token || !type) return jsonResponse({ error: 'code/token/type requis' }, 400);
  const session = await loadSession(env, code);
  if (!session) return jsonResponse({ error: 'Session expirée' }, 404);
  const role = (token === session.hostToken) ? 'host' :
               (token === session.guestToken) ? 'guest' : null;
  if (!role) return jsonResponse({ error: 'Token invalide' }, 403);
  const validTypes = ['message', 'url-change', 'highlight', 'click-request', 'click-result', 'set-name', 'ping'];
  if (!validTypes.includes(type)) return jsonResponse({ error: 'Type invalide' }, 400);
  if (type === 'click-request' || type === 'highlight') {
    const now = Date.now();
    const lastKey = '_last_' + type + '_' + role;
    const last = session[lastKey] || 0;
    const minInterval = type === 'click-request' ? 3000 : 1000;
    if (now - last < minInterval) {
      return jsonResponse({
        error: 'Trop rapide, attends ' + Math.ceil((minInterval - (now - last))/1000) + 's'
      }, 429);
    }
    session[lastKey] = now;
  }
  if (type === 'set-name') {
    const name = String(body.name || '').substring(0, 30);
    if (role === 'host') session.hostName = name || 'Hôte';
    else session.guestName = name || 'Invité';
  }
  if (type === 'url-change' && body.url && role === 'host') {
    session.currentUrl = String(body.url).substring(0, 500);
  }
  const evt = {
    id: 'e_' + Date.now().toString(36) + Math.random().toString(36).slice(2,5),
    type: type,
    from: role,
    ts: Date.now()
  };
  ['text', 'url', 'selector', 'label', 'safeBottom', 'largeMode', 'name', 'ok'].forEach(k => {
    if (body[k] !== undefined) evt[k] = body[k];
  });
  session.events = (session.events || []).concat([evt]);
  if (session.events.length > CONAV_MAX_EVENTS) {
    session.events = session.events.slice(-CONAV_MAX_EVENTS);
  }
  await saveSession(env, session);
  return jsonResponse({ ok: true, eventId: evt.id });
}
async function conavLeave(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'JSON invalide' }, 400); }
  const code = String(body.code || '').replace(/[^0-9]/g, '');
  const token = String(body.token || '');
  const session = await loadSession(env, code);
  if (!session) return jsonResponse({ ok: true });
  const role = (token === session.hostToken) ? 'host' :
               (token === session.guestToken) ? 'guest' : null;
  if (!role) return jsonResponse({ error: 'Token invalide' }, 403);
  session.events = (session.events || []).concat([{
    id: 'e_' + Date.now().toString(36),
    type: 'peer-left',
    from: role,
    ts: Date.now()
  }]);
  if (role === 'host') {
    await env.CONAV_SESSIONS.delete('s:' + code);
  } else {
    session.guestToken = null;
    session.guestName = null;
    await saveSession(env, session);
  }
  return jsonResponse({ ok: true });
}


// ════════════════════════════════════════════════════════════════
// MODULES CLIENT (lot 1) — injectés dans la page via buildFullBridge
// Chacun est un <script> isolé. Pour désactiver l'un d'eux, retire sa
// ligne dans buildFullBridge ci-dessus.
// ════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════
// 05 — FORMULAIRES + FETCH (client, injecté)  [LE VRAI CORRECTIF]
// ════════════════════════════════════════════════════════════════
//
// Corrige : recherche, connexion, démarches -> le submit sortait du
// proxy et échouait. On l'intercepte et on le renvoie DANS le proxy.
//
// Détail important : un formulaire GET ajoute ses champs à la fin de
// l'URL d'action. Si on réécrivait l'action côté HTML, les champs se
// colleraient au mauvais endroit. On construit donc la vraie URL cible
// ici, avec ses paramètres, PUIS on la proxifie. C'est la seule façon
// correcte.
//
// Les formulaires SENSIBLES (mot de passe, RIB…) ne sont PAS proxifiés :
// on émet un événement que le module sécurité (04) rattrape pour
// proposer d'ouvrir le vrai site officiel.

function featForms(cfg) {
  const P = JSON.stringify(cfg.proxyOrigin);
  const R = JSON.stringify(cfg.targetRoot);
  return String.raw`(function(){
  var PROXY = ${P}, ROOT = ${R};
  function sameRoot(host){
    host = String(host).toLowerCase();
    return host === ROOT || host.slice(-(ROOT.length+1)) === '.' + ROOT;
  }
  function isSensitive(form){
    if (form.querySelector('input[type=password]')) return true;
    var risky = /rib|iban|carte|card|cvv|cvc|bancaire|paiement|mot.?de.?passe|password/i;
    var fields = form.querySelectorAll('input, select');
    for (var i = 0; i < fields.length; i++){
      var meta = (fields[i].name||'') + ' ' + (fields[i].id||'') + ' ' + (fields[i].getAttribute('autocomplete')||'');
      if (risky.test(meta)) return true;
    }
    return false;
  }
  document.addEventListener('submit', function(e){
    var form = e.target;
    if (!form || form.tagName !== 'FORM') return;
    var method = (form.getAttribute('method') || 'get').toLowerCase();
    var action;
    try { action = new URL(form.getAttribute('action') || location.href, document.baseURI); }
    catch(err){ return; }
    if (action.protocol !== 'https:' && action.protocol !== 'http:') return;
    if (!sameRoot(action.hostname)) return; // cross-domaine : on laisse le navigateur faire

    if (isSensitive(form)) {
      e.preventDefault();
      try {
        window.parent.postMessage({
          source: 'ohapiday-bridge', type: 'sensitive-submit', action: action.href
        }, '*');
      } catch(_){}
      // le module sécurité (04) prend le relais et propose le vrai site
      return;
    }

    e.preventDefault();
    var fd = new FormData(form);
    // inclure le bouton d'envoi cliqué s'il porte un name
    if (e.submitter && e.submitter.name) fd.append(e.submitter.name, e.submitter.value || '');

    if (method === 'get') {
      var qp = new URLSearchParams(action.search);
      fd.forEach(function(v, k){ if (typeof v === 'string') qp.set(k, v); });
      action.search = qp.toString();
      window.location.href = PROXY + '/proxy-web?url=' + encodeURIComponent(action.href);
    } else {
      // POST : on rejoue le formulaire vers le proxy (le Worker transmet le corps)
      var pf = document.createElement('form');
      pf.method = 'POST';
      pf.action = PROXY + '/proxy-web?url=' + encodeURIComponent(action.href);
      pf.style.display = 'none';
      fd.forEach(function(v, k){
        if (typeof v !== 'string') return; // pas de fichiers ici
        var inp = document.createElement('input');
        inp.type = 'hidden'; inp.name = k; inp.value = v;
        pf.appendChild(inp);
      });
      document.body.appendChild(pf);
      pf.submit();
    }
  }, true);

  // ---- fetch() de la page : re-router les appels internes via le proxy ----
  // Utile pour les sites dynamiques dont l'API est bloquée par CORS :
  // le proxy, lui, fetch côté serveur et contourne CORS.
  // (Module le plus "sensible" : si un site complexe se comporte mal,
  //  c'est le premier à désactiver — commente ce bloc.)
  try {
    var _fetch = window.fetch;
    if (typeof _fetch === 'function') {
      window.fetch = function(input, init){
        try {
          var url = (typeof input === 'string') ? input : (input && input.url);
          if (url) {
            var u = new URL(url, document.baseURI);
            if ((u.protocol === 'https:' || u.protocol === 'http:') &&
                sameRoot(u.hostname) && u.origin !== location.origin) {
              var prox = PROXY + '/proxy-web?url=' + encodeURIComponent(u.href);
              if (typeof input === 'string') input = prox;
              else input = new Request(prox, input);
            }
          }
        } catch(_){}
        return _fetch.call(this, input, init);
      };
    }
  } catch(_){}
})();`;
}

// ════════════════════════════════════════════════════════════════
// 04 — SÉCURITÉ (client, injecté) : badge officiel + garde anti-arnaque
// ════════════════════════════════════════════════════════════════
//
// Deux comportements :
//   1) Page sur un domaine OFFICIEL  -> petit badge vert rassurant.
//   2) Page qui demande login / RIB / paiement sur un domaine NON
//      vérifié -> bandeau : "ouvre plutôt le vrai site officiel".
//
// C'est TON différenciateur : au lieu d'apprendre à ton public à taper
// son mot de passe sur un domaine proxy (réflexe d'arnaque), Astrid le
// protège. Reçoit aussi 'sensitive-submit' émis par le module 05.

function featSecurite(cfg) {
  const OFF = JSON.stringify(cfg.officielsList || []);
  return String.raw`(function(){
  var OFFICIELS = ${OFF};
  function realUrl(){
    try { return new URLSearchParams(location.search).get('url') || document.baseURI; }
    catch(e){ return document.baseURI; }
  }
  function hostOf(u){ try { return new URL(u).hostname.toLowerCase().replace(/^www\./,''); } catch(e){ return ''; } }
  function racine(host){
    var parts = host.split('.');
    if (parts.length <= 2) return host;
    var composes = ['gouv.fr','asso.fr','co.uk','com.br'];
    var deux = parts.slice(-2).join('.');
    if (composes.indexOf(deux) !== -1) return parts.slice(-3).join('.');
    return deux;
  }
  function estOfficiel(host){
    if (!host) return false;
    if (host === 'gouv.fr' || /\.gouv\.fr$/.test(host)) return true;
    if (OFFICIELS.indexOf(host) !== -1) return true;
    return OFFICIELS.indexOf(racine(host)) !== -1;
  }
  var HOST = hostOf(realUrl());
  var OFFICIEL = estOfficiel(HOST);

  // --- badge officiel discret (en bas à gauche) ---
  function badge(){
    if (!OFFICIEL) return;
    if (document.getElementById('__astrid_badge__')) return;
    var b = document.createElement('div');
    b.id = '__astrid_badge__';
    b.textContent = '✅ Site officiel vérifié';
    b.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483646;'
      + 'background:#065f46;color:#fff;font:600 13px system-ui,sans-serif;'
      + 'padding:8px 12px;border-radius:10px;box-shadow:0 4px 14px rgba(0,0,0,.25);'
      + 'pointer-events:none;opacity:.96';
    (document.body || document.documentElement).appendChild(b);
    setTimeout(function(){ if (b.parentNode){ b.style.transition='opacity .6s'; b.style.opacity='0'; setTimeout(function(){ b.remove(); },700); } }, 6000);
  }

  // --- bandeau d'alerte + bouton "ouvrir le vrai site" ---
  function alerte(msg){
    if (document.getElementById('__astrid_garde__')) return;
    var bar = document.createElement('div');
    bar.id = '__astrid_garde__';
    bar.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483647;'
      + 'background:#8B1A1A;color:#FFE8B5;font:700 16px system-ui,sans-serif;'
      + 'padding:16px 18px;box-shadow:0 4px 20px rgba(0,0,0,.35);'
      + 'display:flex;align-items:center;gap:14px;flex-wrap:wrap';
    var txt = document.createElement('span');
    txt.style.flex = '1 1 240px';
    txt.textContent = '⚠️ ' + msg;
    var btn = document.createElement('button');
    btn.textContent = 'Ouvrir le vrai site officiel';
    btn.style.cssText = 'background:#FFE8B5;color:#8B1A1A;border:0;border-radius:10px;'
      + 'padding:12px 18px;font:800 15px system-ui,sans-serif;cursor:pointer';
    btn.onclick = function(){ try { window.open(realUrl(), '_blank', 'noopener'); } catch(e){} };
    var close = document.createElement('button');
    close.textContent = 'Fermer';
    close.style.cssText = 'background:transparent;color:#FFE8B5;border:1px solid #FFE8B5;'
      + 'border-radius:10px;padding:12px 14px;font:700 14px system-ui,sans-serif;cursor:pointer';
    close.onclick = function(){ bar.remove(); };
    bar.appendChild(txt); bar.appendChild(btn); bar.appendChild(close);
    (document.body || document.documentElement).appendChild(bar);
  }

  // page sensible (mot de passe / RIB) sur domaine non officiel ?
  function scanSensible(){
    if (OFFICIEL) return; // sur un vrai site officiel, saisir est normal
    var hasPwd = !!document.querySelector('input[type=password]');
    var risky = document.querySelector('input[autocomplete*="cc-"], input[name*="rib" i], input[name*="iban" i], input[name*="carte" i]');
    if (hasPwd || risky) {
      alerte('Cette page demande une information sensible (mot de passe ou coordonnées). Par sécurité, fais-le sur le vrai site officiel.');
    }
  }

  // signal envoyé par le module formulaires quand un envoi sensible est bloqué
  window.addEventListener('message', function(ev){
    var d = ev.data;
    if (!d || d.type !== 'sensitive-submit') return;
    alerte('Cette démarche demande ta connexion. Pour ta sécurité, termine-la sur le vrai site officiel.');
  });

  function run(){ try { badge(); scanSensible(); } catch(e){} }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
  setTimeout(run, 1500); // re-scan si la page se remplit après coup
})();`;
}

// ════════════════════════════════════════════════════════════════
// 06 — LECTURE À VOIX HAUTE (client, injecté)
// ════════════════════════════════════════════════════════════════
//
// Bouton flottant "🔊 Lire". Lit la sélection si tu as surligné du
// texte, sinon le contenu principal de la page. Gratuit (SpeechSynthesis
// natif), aucune dépendance. Langue configurable via cfg.lang.
//
// Astuce accessibilité : gros bouton, contraste fort, un seul geste.

function featTTS(cfg) {
  const LANG = JSON.stringify(cfg.lang || 'fr-FR');
  return String.raw`(function(){
  if (!('speechSynthesis' in window)) return;
  var LANG = ${LANG};
  var speaking = false;

  function mainText(){
    var sel = String(window.getSelection ? window.getSelection().toString() : '').trim();
    if (sel.length > 1) return sel;
    var el = document.querySelector('main, article, [role=main], #content, .content') || document.body;
    var t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    return t.slice(0, 9000); // borne raisonnable
  }
  function stop(){
    try { window.speechSynthesis.cancel(); } catch(e){}
    speaking = false; render();
  }
  function speak(){
    var text = mainText();
    if (!text) return;
    stop();
    var u = new SpeechSynthesisUtterance(text);
    u.lang = LANG; u.rate = 0.95; u.pitch = 1;
    u.onend = function(){ speaking = false; render(); };
    u.onerror = function(){ speaking = false; render(); };
    speaking = true; render();
    try { window.speechSynthesis.speak(u); } catch(e){ speaking = false; render(); }
  }

  var btn = document.createElement('button');
  btn.id = '__astrid_tts__';
  btn.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483646;'
    + 'background:#1F1135;color:#FFE8B5;border:0;border-radius:14px;'
    + 'padding:14px 18px;font:800 16px system-ui,sans-serif;cursor:pointer;'
    + 'box-shadow:0 6px 18px rgba(0,0,0,.3);display:flex;align-items:center;gap:8px';
  function render(){ btn.textContent = speaking ? '⏹ Arrêter la lecture' : '🔊 Lire la page'; }
  render();
  btn.onclick = function(){ speaking ? stop() : speak(); };

  function mount(){ if (!document.getElementById('__astrid_tts__')) (document.body||document.documentElement).appendChild(btn); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  // arrête la lecture si on quitte la page
  window.addEventListener('beforeunload', stop);

  // permet à ton app de piloter la lecture (ex: lire l'explication d'Astrid)
  window.addEventListener('message', function(ev){
    var d = ev.data;
    if (!d || d.source !== 'ohapiday-app') return;
    if (d.type === 'tts-speak' && d.text) {
      stop();
      var u = new SpeechSynthesisUtterance(String(d.text).slice(0, 4000));
      u.lang = d.lang || LANG; u.rate = 0.95;
      try { window.speechSynthesis.speak(u); } catch(e){}
    }
    if (d.type === 'tts-stop') stop();
  });
})();`;
}

// ════════════════════════════════════════════════════════════════
// 07 — EXPLIQUE-MOI CE MOT (client, injecté)
// ════════════════════════════════════════════════════════════════
//
// L'utilisateur double-clique (ou appui long sur mobile) sur un mot
// difficile -> une bulle explique en français simple, SANS quitter la
// page. On cherche d'abord dans le glossaire (instantané, gratuit) ;
// si absent, on demande à ton app via postMessage 'explique-request'
// et on attend 'explique-response'.
//
// SEUL branchement nécessaire côté ton app (voir le guide) :
//   - écouter 'explique-request' {word, context}
//   - appeler Puter/Astrid : "Explique <word> en une phrase simple,
//     dans ce contexte : <context>"
//   - renvoyer postMessage 'explique-response' {word, text}

function featExplique(cfg) {
  const GLO = JSON.stringify(cfg.glossaire || {});
  return String.raw`(function(){
  var GLOSSAIRE = ${GLO};
  function norm(s){
    return String(s||'').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g,'') // enlève les accents
      .replace(/[^a-z' ]/g,'').trim();
  }
  // index normalisé du glossaire pour une recherche tolérante
  var IDX = {};
  Object.keys(GLOSSAIRE).forEach(function(k){ IDX[norm(k)] = GLOSSAIRE[k]; });

  function lookup(word){
    var n = norm(word);
    if (!n) return null;
    if (IDX[n]) return IDX[n];
    // essaie le mot au singulier grossier
    if (n.length > 4 && IDX[n.replace(/s$/,'')]) return IDX[n.replace(/s$/,'')];
    return null;
  }
  function sentenceAround(node, word){
    try {
      var t = (node && node.textContent) || document.body.innerText || '';
      var i = t.toLowerCase().indexOf(String(word).toLowerCase());
      if (i < 0) return '';
      var start = Math.max(0, i - 120), end = Math.min(t.length, i + 120);
      return t.slice(start, end).replace(/\s+/g,' ').trim();
    } catch(e){ return ''; }
  }

  var bulle = null;
  function fermer(){ if (bulle && bulle.parentNode){ bulle.remove(); } bulle = null; }
  function afficher(word, texte, x, y){
    fermer();
    bulle = document.createElement('div');
    bulle.style.cssText = 'position:fixed;z-index:2147483647;max-width:320px;'
      + 'background:#1F1135;color:#FFE8B5;font:600 16px/1.5 system-ui,sans-serif;'
      + 'padding:14px 16px;border-radius:14px;box-shadow:0 8px 26px rgba(0,0,0,.4)';
    var titre = document.createElement('div');
    titre.style.cssText = 'font-weight:800;margin-bottom:6px;color:#FF9A3D';
    titre.textContent = '💡 ' + word;
    var corps = document.createElement('div');
    corps.textContent = texte;
    var fx = document.createElement('button');
    fx.textContent = '✕';
    fx.style.cssText = 'position:absolute;top:6px;right:8px;background:transparent;border:0;color:#FFE8B5;font-size:18px;cursor:pointer';
    fx.onclick = fermer;
    bulle.appendChild(titre); bulle.appendChild(corps); bulle.appendChild(fx);
    bulle.style.left = Math.min(x, window.innerWidth - 340) + 'px';
    bulle.style.top  = Math.min(y + 12, window.innerHeight - 140) + 'px';
    (document.body||document.documentElement).appendChild(bulle);
    // lecture à voix haute de l'explication, si le module TTS est là
    try { window.postMessage({ source:'ohapiday-app', type:'tts-speak', text: word + '. ' + texte }, '*'); } catch(e){}
  }

  function traiter(word, node, x, y){
    word = String(word||'').trim();
    if (word.length < 2 || word.length > 40) return;
    var hit = lookup(word);
    if (hit) { afficher(word, hit, x, y); return; }
    // pas dans le glossaire -> on demande à l'app
    afficher(word, '…', x, y);
    var ctx = sentenceAround(node, word);
    try {
      window.parent.postMessage({ source:'ohapiday-bridge', type:'explique-request', word: word, context: ctx }, '*');
    } catch(e){}
  }

  // réponse de l'app
  window.addEventListener('message', function(ev){
    var d = ev.data;
    if (!d || d.type !== 'explique-response' || !d.word) return;
    if (bulle) {
      var corps = bulle.childNodes[1];
      if (corps) corps.textContent = String(d.text||'').slice(0, 400) || 'Désolé, pas d\'explication trouvée.';
      try { window.postMessage({ source:'ohapiday-app', type:'tts-speak', text: d.word + '. ' + (d.text||'') }, '*'); } catch(e){}
    }
  });

  // desktop : double-clic sélectionne le mot
  document.addEventListener('dblclick', function(e){
    var sel = String(window.getSelection ? window.getSelection().toString() : '').trim();
    if (sel && sel.indexOf(' ') === -1) traiter(sel, e.target, e.clientX, e.clientY);
  });

  // mobile : appui long
  var lpTimer = null, lpXY = null;
  document.addEventListener('touchstart', function(e){
    var t = e.touches && e.touches[0]; if (!t) return;
    lpXY = { x: t.clientX, y: t.clientY };
    lpTimer = setTimeout(function(){
      var word = '';
      try {
        var r = document.caretRangeFromPoint ? document.caretRangeFromPoint(lpXY.x, lpXY.y) : null;
        if (r && r.startContainer && r.startContainer.textContent){
          var txt = r.startContainer.textContent;
          var off = r.startOffset;
          var left = txt.slice(0, off).match(/[\p{L}'-]+$/u);
          var right = txt.slice(off).match(/^[\p{L}'-]+/u);
          word = ((left?left[0]:'') + (right?right[0]:'')).trim();
        }
      } catch(err){}
      if (word) traiter(word, (r&&r.startContainer), lpXY.x, lpXY.y);
    }, 550);
  }, { passive: true });
  function clearLP(){ if (lpTimer){ clearTimeout(lpTimer); lpTimer = null; } }
  document.addEventListener('touchend', clearLP, { passive: true });
  document.addEventListener('touchmove', clearLP, { passive: true });

  // fermer la bulle en cliquant ailleurs
  document.addEventListener('click', function(e){
    if (bulle && !bulle.contains(e.target)) fermer();
  }, true);
})();`;
}

// ════════════════════════════════════════════════════════════════
// 08 — ANTI-ABANDON (client, injecté)
// ════════════════════════════════════════════════════════════════
//
// Détecte les signaux de blocage SANS que l'utilisateur demande :
//   - inactivité prolongée (75 s sans interaction utile)
//   - même élément cliqué 3 fois de suite (bouton qui "ne marche pas")
//   - scroll qui oscille (cherche sans trouver)
// Puis émet UNE fois 'user-stuck' vers ton app (cooldown 60 s), pour
// qu'Astrid propose son aide. Un bandeau doux s'affiche en secours si
// ton app ne réagit pas.
//
// Le moment critique de ton public n'est pas quand il demande de l'aide,
// c'est quand il n'ose pas et ferme tout. Ce module attrape ça.

function featAntiAbandon(cfg) {
  return String.raw`(function(){
  var lastInteract = Date.now();
  var lastEmit = 0;
  var COOLDOWN = 60000;

  function emit(raison){
    var now = Date.now();
    if (now - lastEmit < COOLDOWN) return;
    lastEmit = now;
    try {
      window.parent.postMessage({ source:'ohapiday-bridge', type:'user-stuck', reason: raison }, '*');
    } catch(e){}
    secours();
  }

  // bandeau doux de secours (si l'app ne prend pas la main)
  function secours(){
    if (document.getElementById('__astrid_help__')) return;
    var box = document.createElement('div');
    box.id = '__astrid_help__';
    box.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:80px;'
      + 'z-index:2147483646;background:#FF6A00;color:#1F1135;font:800 16px system-ui,sans-serif;'
      + 'padding:14px 18px;border-radius:16px;box-shadow:0 8px 24px rgba(0,0,0,.3);'
      + 'display:flex;align-items:center;gap:12px;max-width:90vw';
    var t = document.createElement('span');
    t.textContent = 'Besoin d\'un coup de main sur cette page ?';
    var oui = document.createElement('button');
    oui.textContent = 'Oui, montre-moi';
    oui.style.cssText = 'background:#1F1135;color:#FFE8B5;border:0;border-radius:10px;padding:10px 14px;font:800 15px system-ui;cursor:pointer';
    oui.onclick = function(){
      try { window.parent.postMessage({ source:'ohapiday-bridge', type:'help-requested' }, '*'); } catch(e){}
      box.remove();
    };
    var non = document.createElement('button');
    non.textContent = 'Ça va';
    non.style.cssText = 'background:transparent;color:#1F1135;border:1px solid #1F1135;border-radius:10px;padding:10px 12px;font:700 14px system-ui;cursor:pointer';
    non.onclick = function(){ box.remove(); };
    box.appendChild(t); box.appendChild(oui); box.appendChild(non);
    (document.body||document.documentElement).appendChild(box);
    setTimeout(function(){ if (box.parentNode) box.remove(); }, 15000);
  }

  // --- inactivité ---
  function touch(){ lastInteract = Date.now(); }
  ['click','keydown','input','pointerdown'].forEach(function(ev){
    document.addEventListener(ev, touch, { passive: true, capture: true });
  });
  setInterval(function(){
    if (document.hidden) return; // onglet en arrière-plan : on ne compte pas
    if (Date.now() - lastInteract > 75000) { emit('inactivite'); lastInteract = Date.now(); }
  }, 15000);

  // --- même élément cliqué 3x ---
  var lastEl = null, repeat = 0, lastClickTs = 0;
  document.addEventListener('click', function(e){
    var now = Date.now();
    if (e.target === lastEl && now - lastClickTs < 8000) repeat++;
    else repeat = 1;
    lastEl = e.target; lastClickTs = now;
    if (repeat >= 3) { emit('clics-repetes'); repeat = 0; }
  }, true);

  // --- scroll qui oscille ---
  var dirs = [], lastY = window.scrollY;
  window.addEventListener('scroll', function(){
    var y = window.scrollY;
    var d = y > lastY ? 1 : (y < lastY ? -1 : 0);
    lastY = y;
    if (d === 0) return;
    dirs.push({ d: d, t: Date.now() });
    dirs = dirs.filter(function(o){ return Date.now() - o.t < 8000; });
    var flips = 0;
    for (var i = 1; i < dirs.length; i++) if (dirs[i].d !== dirs[i-1].d) flips++;
    if (flips >= 6) { emit('scroll-agite'); dirs = []; }
  }, { passive: true });
})();`;
}


// ════════════════════════════════════════════════════════════════
// MODULES CLIENT (lot 2) — injectés via buildFullBridge
// IA : ces modules N'APPELLENT PAS l'IA. Ils émettent des demandes
// (translate-request, explique-request, proof-analyze-request…) que
// TON APPLICATION reçoit et traite avec Puter, puis renvoie la réponse.
// ════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════
// 09b — MULTILINGUE ADMIN (client, injecté)
// ════════════════════════════════════════════════════════════════
//
// Sélecteur de langue flottant. Quand une langue non-FR est choisie :
//   - chaque bouton/lien reçoit une petite bulle "traduction (Français)"
//     -> la personne lit dans sa langue, agit sur le vrai mot FR.
//   - le volet lecture peut être lu dans sa langue (via TTS lang).
// Les termes d'interface courants sont traduits par le glossaire
// (instantané). Le texte propre à la page part à ton IA.
//
// BRANCHEMENT APP (facultatif, pour le texte hors glossaire) :
//   écouter 'translate-request' {lang, texts:[...]} -> IA ->
//   renvoyer 'translate-response' {lang, translations:[...]} (même ordre)

function featMultilingue(cfg) {
  const MULTI  = JSON.stringify(cfg.glossaireMulti || {});
  const LANGS  = JSON.stringify(cfg.languesDispo || []);
  const TTSMAP = JSON.stringify(cfg.langTts || {});
  return String.raw`(function(){
  var MULTI = ${MULTI}, LANGS = ${LANGS}, TTSMAP = ${TTSMAP};
  var current = 'fr';

  function norm(s){
    return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim();
  }
  function traduireTerme(txt, lang){
    var n = norm(txt);
    if (MULTI[n] && MULTI[n][lang]) return MULTI[n][lang];
    return null; // inconnu du glossaire -> IA
  }

  // éléments interactifs à étiqueter
  function cibles(){
    return Array.prototype.slice.call(
      document.querySelectorAll('button, a, [role=button], input[type=submit], input[type=button], label')
    ).filter(function(el){
      var t = (el.innerText || el.value || '').trim();
      return t && t.length <= 40 && el.offsetParent !== null;
    });
  }

  function poserBulle(el, trad, orig){
    if (el.__astridTrad) el.__astridTrad.remove();
    var tag = document.createElement('span');
    tag.className = '__astrid_ml__';
    tag.dir = 'auto';
    tag.textContent = trad + ' (' + orig + ')';
    tag.style.cssText = 'display:inline-block;background:#1F1135;color:#FFE8B5;'
      + 'font:600 13px system-ui,sans-serif;padding:2px 8px;border-radius:8px;'
      + 'margin-left:6px;vertical-align:middle;white-space:nowrap';
    el.appendChild(tag);
    el.__astridTrad = tag;
  }
  function nettoyer(){
    Array.prototype.slice.call(document.querySelectorAll('.__astrid_ml__')).forEach(function(t){ t.remove(); });
    cibles().forEach(function(el){ el.__astridTrad = null; });
  }

  function appliquer(lang){
    current = lang;
    nettoyer();
    if (lang === 'fr') return;
    var manquants = [], refs = [];
    cibles().forEach(function(el){
      var orig = (el.innerText || el.value || '').trim().replace(/\s*\(.*/,'');
      var trad = traduireTerme(orig, lang);
      if (trad) { poserBulle(el, trad, orig); }
      else { manquants.push(orig); refs.push(el); }
    });
    // le reste -> IA
    if (manquants.length) {
      window.__astridMLpending = { lang: lang, refs: refs };
      try {
        window.parent.postMessage({ source:'ohapiday-bridge', type:'translate-request', lang: lang, texts: manquants }, '*');
      } catch(e){}
    }
  }

  window.addEventListener('message', function(ev){
    var d = ev.data;
    if (!d || d.type !== 'translate-response' || !window.__astridMLpending) return;
    if (d.lang !== window.__astridMLpending.lang) return;
    var refs = window.__astridMLpending.refs, tr = d.translations || [];
    refs.forEach(function(el, i){
      var orig = (el.innerText || el.value || '').trim().replace(/\s*\(.*/,'');
      if (tr[i]) poserBulle(el, tr[i], orig);
    });
    window.__astridMLpending = null;
  });

  // sélecteur de langue
  function menu(){
    var wrap = document.createElement('div');
    wrap.id = '__astrid_langsel__';
    wrap.style.cssText = 'position:fixed;right:14px;top:14px;z-index:2147483646;'
      + 'background:#fff;border-radius:12px;box-shadow:0 6px 18px rgba(0,0,0,.25);'
      + 'padding:6px;display:flex;gap:4px;flex-wrap:wrap;max-width:70vw';
    LANGS.forEach(function(L){
      var b = document.createElement('button');
      b.textContent = L.nom;
      b.dir = 'auto';
      b.style.cssText = 'border:0;border-radius:8px;padding:8px 10px;cursor:pointer;'
        + 'font:700 14px system-ui,sans-serif;background:#F3EEFF;color:#1F1135';
      b.onclick = function(){
        Array.prototype.slice.call(wrap.children).forEach(function(x){ x.style.background='#F3EEFF'; x.style.color='#1F1135'; });
        b.style.background = '#FF6A00'; b.style.color = '#1F1135';
        appliquer(L.code);
      };
      wrap.appendChild(b);
    });
    (document.body||document.documentElement).appendChild(wrap);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', menu);
  else menu();

  // permet à ton app de lire le contenu dans la langue choisie
  window.__astridLangTTS = function(){ return TTSMAP[current] || 'fr-FR'; };
})();`;
}

// ════════════════════════════════════════════════════════════════
// 10 — REMPLISSAGE NARRÉ (client, injecté)
// ════════════════════════════════════════════════════════════════
//
// Ta valeur n'est PAS l'autofill silencieux (angoissant : "qui a rempli
// ça ?"). C'est le TEMPO et la CONFIANCE : un champ à la fois, à voix
// haute, avec une pause pour vérifier, et JAMAIS de validation
// automatique. Astrid remplit, montre, explique — la personne valide.
//
// L'app envoie un PLAN (les valeurs viennent de TON coffre côté app,
// jamais stockées ici) :
//   {source:'ohapiday-app', type:'fill-plan',
//    steps:[ {find:'nom', value:'Dupont', say:'ton nom de famille'},
//            {find:'email', value:'a@b.fr', say:'ton adresse mail'},
//            {find:'#pass', value:'****', say:'ton mot de passe', secret:true} ],
//    submitLabel:'Valider'}
//
// Le module remplit pas à pas, surligne, narre (sauf les champs secret),
// puis s'ARRÊTE sur le bouton d'envoi sans cliquer. Émet 'fill-done'.

function featRemplissage(cfg) {
  return String.raw`(function(){
  function norm(s){ return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim(); }

  // trouve un champ par sélecteur CSS, label associé, placeholder, name/id
  function trouverChamp(q){
    if (!q) return null;
    // 1) sélecteur CSS direct
    try { var el = document.querySelector(q); if (el) return el; } catch(e){}
    var n = norm(q);
    // 2) via <label>
    var labels = document.querySelectorAll('label');
    for (var i=0;i<labels.length;i++){
      if (norm(labels[i].textContent).indexOf(n) !== -1){
        var f = labels[i].getAttribute('for');
        if (f){ var t = document.getElementById(f); if (t) return t; }
        var inner = labels[i].querySelector('input,select,textarea'); if (inner) return inner;
      }
    }
    // 3) placeholder / aria-label / name / id
    var champs = document.querySelectorAll('input, select, textarea');
    for (var j=0;j<champs.length;j++){
      var meta = norm((champs[j].placeholder||'') + ' ' + (champs[j].getAttribute('aria-label')||'') + ' ' + (champs[j].name||'') + ' ' + (champs[j].id||''));
      if (meta.indexOf(n) !== -1) return champs[j];
    }
    return null;
  }

  function parler(txt){
    try { window.postMessage({ source:'ohapiday-app', type:'tts-speak', text: txt }, '*'); } catch(e){}
  }
  function surligner(el){
    try {
      window.parent.postMessage({ source:'ohapiday-bridge', type:'fill-highlight',
        rect: el.getBoundingClientRect() && { x: el.getBoundingClientRect().left, y: el.getBoundingClientRect().top, w: el.offsetWidth, h: el.offsetHeight } }, '*');
    } catch(e){}
    try { el.scrollIntoView({ block:'center', behavior:'smooth' }); } catch(e){}
    el.style.outline = '3px solid #FF6A00';
    el.style.outlineOffset = '2px';
    setTimeout(function(){ el.style.outline=''; }, 2600);
  }
  function poser(el, val){
    var proto = el.tagName === 'SELECT' ? null : Object.getPrototypeOf(el);
    try {
      var setter = proto && Object.getOwnPropertyDescriptor(proto, 'value');
      if (setter && setter.set) setter.set.call(el, val); else el.value = val;
    } catch(e){ el.value = val; }
    el.dispatchEvent(new Event('input', { bubbles:true }));
    el.dispatchEvent(new Event('change', { bubbles:true }));
  }

  function jouer(plan){
    var steps = plan.steps || [];
    var i = 0;
    function suite(){
      if (i >= steps.length){ terminer(plan); return; }
      var s = steps[i++];
      var el = trouverChamp(s.find);
      if (!el){
        // champ introuvable : on prévient et on continue
        try { window.parent.postMessage({ source:'ohapiday-bridge', type:'fill-miss', find: s.find }, '*'); } catch(e){}
        setTimeout(suite, 200); return;
      }
      surligner(el);
      var phrase = s.secret
        ? ('Là je saisis ' + (s.say || 'cette information') + ', que je ne dis pas à voix haute.')
        : ('Là je mets ' + (s.say || 'cette information') + ' : ' + s.value + '. Vérifie que c\'est bon.');
      parler(phrase);
      setTimeout(function(){ poser(el, s.value); setTimeout(suite, 1600); }, 900);
    }
    suite();
  }

  function terminer(plan){
    var btn = null;
    if (plan.submitLabel){
      var lbl = norm(plan.submitLabel);
      var cand = document.querySelectorAll('button, input[type=submit], [role=button]');
      for (var k=0;k<cand.length;k++){
        if (norm(cand[k].innerText || cand[k].value).indexOf(lbl) !== -1){ btn = cand[k]; break; }
      }
    }
    if (btn){
      surligner(btn);
      parler('Tout est rempli. Quand tu es prêt, clique sur le bouton en orange pour valider. Je ne valide pas à ta place.');
    } else {
      parler('Tout est rempli. Vérifie une dernière fois, puis valide toi-même.');
    }
    try { window.parent.postMessage({ source:'ohapiday-bridge', type:'fill-done' }, '*'); } catch(e){}
  }

  window.addEventListener('message', function(ev){
    var d = ev.data;
    if (!d || d.source !== 'ohapiday-app' || d.type !== 'fill-plan') return;
    jouer(d);
  });
})();`;
}

// ════════════════════════════════════════════════════════════════
// 11 — PARCOURS REJOUABLE (client, injecté)
// ════════════════════════════════════════════════════════════════
//
// Mémorise le CHEMIN d'une démarche réussie — jamais les données
// sensibles, seulement l'itinéraire : "sur cette page, clic sur ce
// bouton". La fois d'après, Astrid rejoue le chemin étape par étape.
//
// Robuste aux changements de mise en page : on mémorise le LIBELLÉ du
// bouton, pas ses coordonnées. findByText le retrouve même si la page a
// bougé.
//
// DEUX MODES pilotés par ton app :
//   - ENREGISTRER : {source:'ohapiday-app', type:'journey-record', on:true}
//        -> le bridge émet 'journey-step' {url, label, tag} à chaque clic.
//        -> ton app accumule et stocke le parcours (petit JSON).
//   - REJOUER : {source:'ohapiday-app', type:'replay-step', step:{label}}
//        -> le bridge surligne l'élément + narre "clique sur X".
//        -> quand la personne clique / la page change, ton app envoie
//           l'étape suivante.

function featParcours(cfg) {
  return String.raw`(function(){
  var recording = false;
  function realUrl(){ try { return new URLSearchParams(location.search).get('url') || document.baseURI; } catch(e){ return document.baseURI; } }
  function norm(s){ return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim(); }
  function libelle(el){
    var t = (el.innerText || el.value || el.getAttribute('aria-label') || el.title || '').trim();
    return t.replace(/\s+/g,' ').slice(0, 60);
  }
  function estCliquable(el){
    while (el && el !== document.body){
      var tag = el.tagName;
      if (tag === 'A' || tag === 'BUTTON' || el.getAttribute('role') === 'button' ||
          (tag === 'INPUT' && /submit|button/i.test(el.type||''))) return el;
      el = el.parentElement;
    }
    return null;
  }

  // ENREGISTREMENT
  document.addEventListener('click', function(e){
    if (!recording) return;
    var el = estCliquable(e.target);
    if (!el) return;
    var lab = libelle(el);
    if (!lab) return; // pas de libellé -> inutile à rejouer
    try {
      window.parent.postMessage({ source:'ohapiday-bridge', type:'journey-step',
        url: realUrl(), label: lab, tag: el.tagName }, '*');
    } catch(err){}
  }, true);

  // REJEU : surligner l'étape courante
  function rejouerEtape(step){
    var cible = null, best = -1, lab = norm(step.label);
    var cand = document.querySelectorAll('a, button, [role=button], input[type=submit], input[type=button]');
    for (var i=0;i<cand.length;i++){
      if (cand[i].offsetParent === null) continue;
      var t = norm(cand[i].innerText || cand[i].value);
      if (!t) continue;
      var score = (t === lab) ? 100 : (t.indexOf(lab) !== -1 || lab.indexOf(t) !== -1 ? 50 : -1);
      if (score > best){ best = score; cible = cand[i]; }
    }
    if (!cible){
      try { window.parent.postMessage({ source:'ohapiday-bridge', type:'replay-miss', label: step.label }, '*'); } catch(e){}
      return;
    }
    try { cible.scrollIntoView({ block:'center', behavior:'smooth' }); } catch(e){}
    cible.style.outline = '4px solid #FF6A00';
    cible.style.outlineOffset = '3px';
    try { window.postMessage({ source:'ohapiday-app', type:'tts-speak', text: 'Clique sur ' + step.label + '. Je te le montre en orange.' }, '*'); } catch(e){}
    // quand la personne clique dessus, on prévient l'app (étape suivante)
    var onClick = function(){
      cible.style.outline = '';
      cible.removeEventListener('click', onClick, true);
      try { window.parent.postMessage({ source:'ohapiday-bridge', type:'replay-advance', label: step.label }, '*'); } catch(e){}
    };
    cible.addEventListener('click', onClick, true);
  }

  window.addEventListener('message', function(ev){
    var d = ev.data;
    if (!d || d.source !== 'ohapiday-app') return;
    if (d.type === 'journey-record') recording = !!d.on;
    if (d.type === 'replay-step' && d.step) rejouerEtape(d.step);
  });
})();`;
}

// ════════════════════════════════════════════════════════════════
// 12 — PREUVE AUTOMATIQUE + ÉCHÉANCES (client, injecté)
// ════════════════════════════════════════════════════════════════
//
// Astrid lit chaque page et repère TOUTE SEULE :
//   - les échéances ("avant le 15 mars", "sous 15 jours")
//   - les numéros de dossier / références
//   - les pages de confirmation ("votre demande a bien été prise en compte")
//
// Sur une confirmation, elle propose de garder la preuve (texte propre +
// date + URL) et de créer un rappel tiré du texte même de la page.
// C'est le pont entre l'écran et la vie réelle — là où ton public décroche.
//
// ÉVÉNEMENTS émis vers ton app :
//   'proof-found'    {kind, action, date, reference, url, capturedAt, snapshot}
//   'deadline-found' {text, date, url}
// BRANCHEMENT IA (facultatif, pour fiabiliser l'extraction) :
//   'proof-analyze-request' {text} -> IA -> 'proof-analyze-response' {action,date,reference}
// Ton app : stocke la preuve, crée le rappel (calendrier / notification).

function featPreuve(cfg) {
  return String.raw`(function(){
  function realUrl(){ try { return new URLSearchParams(location.search).get('url') || document.baseURI; } catch(e){ return document.baseURI; } }
  function mainText(){
    var el = document.querySelector('main, article, [role=main], #content, .content') || document.body;
    return (el.innerText || el.textContent || '').replace(/\s+/g,' ').trim();
  }

  var MOIS = 'janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre';
  var reEcheanceMois = new RegExp('(avant le|jusqu\'au|au plus tard le|d\'ici le)\\s+(\\d{1,2}\\s+(?:' + MOIS + ')(?:\\s+\\d{4})?)', 'i');
  var reEcheanceNum  = /(avant le|jusqu'au|au plus tard le|d'ici le)\s+(\d{1,2}[\/.]\d{1,2}[\/.]\d{2,4})/i;
  var reDelai        = /sous\s+(\d{1,2})\s+(jours|semaines|mois)/i;
  var reReference    = /(?:dossier|référence|reference|récépissé|recepisse|numéro|numero|n[°o])\s*:?\s*(?:n[°o]\s*)?([A-Z0-9][A-Z0-9\-\/]{3,19})/i;
  function extraireRef(txt){ var m = reReference.exec(txt); if (!m) return null; var v = m[1].trim(); return /\d/.test(v) ? v : null; }
  var reConfirm      = /(a bien été (?:pris|prise|enregistr)|votre demande a été|confirmation de|récépissé|recepisse|accusé de réception|accuse de reception|est confirmée|est confirmee|merci.{0,20}votre demande)/i;

  function analyser(){
    var txt = mainText();
    if (!txt || txt.length < 40) return;

    // échéances (passif : même sans confirmation)
    var mEch = reEcheanceMois.exec(txt) || reEcheanceNum.exec(txt);
    if (mEch){
      try { window.parent.postMessage({ source:'ohapiday-bridge', type:'deadline-found',
        text: mEch[0], date: mEch[2], url: realUrl() }, '*'); } catch(e){}
    } else {
      var mDel = reDelai.exec(txt);
      if (mDel){
        try { window.parent.postMessage({ source:'ohapiday-bridge', type:'deadline-found',
          text: mDel[0], date: null, url: realUrl() }, '*'); } catch(e){}
      }
    }

    // page de confirmation -> preuve
    if (reConfirm.test(txt)){
      var ref = extraireRef(txt);
      var snapshot = txt.slice(0, 600);
      var payload = {
        kind: 'confirmation',
        action: (reConfirm.exec(txt)||[])[0] || 'Demande confirmée',
        date: (mEch ? mEch[2] : null),
        reference: ref,
        url: realUrl(),
        capturedAt: new Date().toISOString(),
        snapshot: snapshot
      };
      try { window.parent.postMessage({ source:'ohapiday-bridge', type:'proof-found', proof: payload }, '*'); } catch(e){}
      // fiabilisation IA (facultative)
      try { window.parent.postMessage({ source:'ohapiday-bridge', type:'proof-analyze-request', text: snapshot }, '*'); } catch(e){}
      banniere();
    }
  }

  // petit bandeau proposant de garder la preuve
  function banniere(){
    if (document.getElementById('__astrid_preuve__')) return;
    var box = document.createElement('div');
    box.id = '__astrid_preuve__';
    box.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:14px;'
      + 'z-index:2147483646;background:#065f46;color:#fff;font:700 15px system-ui,sans-serif;'
      + 'padding:14px 18px;border-radius:14px;box-shadow:0 8px 24px rgba(0,0,0,.3);'
      + 'display:flex;align-items:center;gap:12px;max-width:92vw';
    var t = document.createElement('span');
    t.textContent = '✅ Démarche confirmée. Astrid peut garder la preuve.';
    var b = document.createElement('button');
    b.textContent = 'Garder la preuve';
    b.style.cssText = 'background:#FFE8B5;color:#065f46;border:0;border-radius:10px;padding:10px 14px;font:800 15px system-ui;cursor:pointer';
    b.onclick = function(){
      try { window.parent.postMessage({ source:'ohapiday-bridge', type:'proof-save-confirmed' }, '*'); } catch(e){}
      box.remove();
    };
    var x = document.createElement('button');
    x.textContent = '✕';
    x.style.cssText = 'background:transparent;color:#fff;border:0;font-size:18px;cursor:pointer';
    x.onclick = function(){ box.remove(); };
    box.appendChild(t); box.appendChild(b); box.appendChild(x);
    (document.body||document.documentElement).appendChild(box);
  }

  function run(){ try { analyser(); } catch(e){} }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
  setTimeout(run, 2000); // re-scan si la confirmation arrive après coup
})();`;
}

// ════════════════════════════════════════════════════════════════
// 15 — RELAIS VOCAL (client, injecté) — le pendant de 14 dans la page
// ════════════════════════════════════════════════════════════════
//
// Reçoit les ordres du module vocal (14) et agit dans la page :
//   'voice-point' {voiceId, label, click}  -> trouve, pointe, (clique)
//   'nav-back'                              -> page précédente
//   'tts-speak-page'                        -> lit le contenu principal
//   'explique-mot' {mot}                    -> demande l'explication
//   'voice-list-elements'                   -> renvoie les libellés cliquables
// Et signale 'page-ready' au chargement (pour enchaîner les étapes).

function featVoixRelais(cfg) {
  return String.raw`(function(){
  function norm(s){ return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim(); }
  function versParent(msg){ try { window.parent.postMessage(Object.assign({ source:'ohapiday-bridge' }, msg), '*'); } catch(e){} }

  // Elements que l'on peut montrer ou activer.
  // L'ancienne version ne prenait que a/button/role=button : elle ratait
  // les champs de formulaire, les onglets, les elements custom, et
  // surtout tout ce qui est en position:fixed (offsetParent vaut null
  // pour eux, alors qu'ils sont parfaitement visibles).
  function estVisible(el){
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (parseFloat(cs.opacity) === 0) return false;
    return true;
  }

  function libelleDe(el){
    // On CUMULE toutes les sources au lieu de prendre la premiere :
    //  - un bouton icone a innerText = "🔍" (non vide) et le vrai
    //    libelle dans aria-label ;
    //  - un <select> a innerText = le texte des options, et son nom
    //    dans l'attribut name ou dans un <label for>.
    // Prendre la premiere source non vide ratait ces deux cas.
    var bouts = [];
    var tag = (el.tagName || '').toLowerCase();

    // Les champs de formulaire : leur propre texte n'est pas leur libelle
    if (tag !== 'select' && tag !== 'textarea' && tag !== 'input') {
      bouts.push(el.innerText || '');
    }
    ['aria-label','title','alt','name','placeholder'].forEach(function(a){
      var v = el.getAttribute && el.getAttribute(a);
      if (v) bouts.push(v);
    });
    if (el.value && tag === 'input') bouts.push(el.value);

    // Un <label for="..."> qui designe cet element
    if (el.id) {
      try {
        var lb = document.querySelector('label[for="' + el.id + '"]');
        if (lb && lb.innerText) bouts.push(lb.innerText);
      } catch(e){}
    }
    // Le label qui l'englobe
    var par = el.closest && el.closest('label');
    if (par && par.innerText) bouts.push(par.innerText);

    var vus = [];
    return bouts.map(function(b){ return String(b).replace(/\s+/g,' ').trim(); })
                .filter(function(b){ if (!b || vus.indexOf(b) !== -1) return false; vus.push(b); return true; })
                .join(' · ')
                .slice(0, 200);
  }

  function cliquables(){
    var sel = 'a[href], button, [role=button], [role=link], [role=menuitem], [role=tab],'
            + ' input[type=submit], input[type=button], input[type=radio], input[type=checkbox],'
            + ' input[type=text], input[type=email], input[type=tel], input[type=password],'
            + ' input[type=number], input[type=date], input[type=search],'
            + ' select, textarea, summary, label[for], [onclick], [tabindex]:not([tabindex="-1"])';
    var vus = [];
    var out = [];
    Array.prototype.slice.call(document.querySelectorAll(sel)).forEach(function(el){
      if (vus.indexOf(el) !== -1) return;
      vus.push(el);
      if (!estVisible(el)) return;
      if (!libelleDe(el)) return;
      out.push(el);
    });
    return out;
  }

  // Recherche par mots : « déclarer mes revenus » doit trouver « Déclarer ».
  // L'ancienne version n'acceptait qu'une inclusion exacte dans un sens ou
  // dans l'autre — elle echouait des que la phrase dictee etait plus riche
  // que le libelle, ce qui est le cas normal a l'oral.
  var MOTS_VIDES = ['le','la','les','un','une','des','de','du','sur','au','aux',
                    'mon','ma','mes','ton','ta','tes','ce','cet','cette','et',
                    'bouton','lien','case','champ','onglet','clique','cliquer',
                    'montre','montrer','appuie','appuyer','va','aller'];

  function motsUtiles(t){
    return norm(t).split(' ').filter(function(m){
      return m.length > 2 && MOTS_VIDES.indexOf(m) === -1;
    });
  }

  function trouver(label){
    var lab = norm(label);
    if (!lab) return null;
    var motsDits = motsUtiles(label);
    var best = -1, cible = null;

    cliquables().forEach(function(el){
      var brut = libelleDe(el);
      var t = norm(brut);
      if (!t) return;

      var score = -1;
      if (t === lab)                       score = 100;   // identique
      else if (t.indexOf(lab) !== -1)      score = 85;    // le libelle contient la phrase
      else if (lab.indexOf(t) !== -1 && t.length > 2) score = 75;  // la phrase contient le libelle
      else if (motsDits.length) {
        // combien des mots dits se retrouvent dans le libelle ?
        var motsEl = motsUtiles(brut);
        var communs = 0;
        motsDits.forEach(function(m){
          for (var i = 0; i < motsEl.length; i++){
            if (motsEl[i] === m || motsEl[i].indexOf(m) === 0 || m.indexOf(motsEl[i]) === 0){ communs++; break; }
          }
        });
        if (communs) score = Math.round(40 + 30 * (communs / motsDits.length));
      }
      if (score < 0) return;

      // A egalite, on prefere ce qui est deja a l'ecran
      var r = el.getBoundingClientRect();
      if (r.top >= 0 && r.bottom <= window.innerHeight) score += 3;

      if (score > best){ best = score; cible = el; }
    });

    return best >= 55 ? cible : null;
  }

  function pointer(el, cliquer){
    try { el.scrollIntoView({ block:'center', behavior:'smooth' }); } catch(e){}
    el.style.outline = '4px solid #FF6A00';
    el.style.outlineOffset = '3px';
    el.style.transition = 'outline-color .3s';
    var n = 0, iv = setInterval(function(){ el.style.outlineColor = (n++ % 2) ? '#FF6A00' : '#FFD08A'; if (n > 6){ clearInterval(iv); } }, 300);
    setTimeout(function(){ el.style.outline = ''; }, 2600);
    if (cliquer){ setTimeout(function(){ try { el.click(); } catch(e){} }, 900); }
  }

  var __resolvePending = {};
  function labelsCliquables(){
    // libelleDe() cumule texte, aria-label, title, name, placeholder et
    // <label for>. innerText seul ratait tous les boutons-icones et les
    // champs de formulaire : l'IA ne voyait qu'une partie de la page.
    return cliquables().map(function(el){ return libelleDe(el).slice(0, 50); })
      .filter(Boolean).slice(0, 60);
  }

  function imagesCliquables(){
    var out = [];
    var imgs = document.querySelectorAll('img[src]');
    for (var i = 0; i < imgs.length && out.length < 6; i++){
      var img = imgs[i];
      var r = img.getBoundingClientRect();
      if (r.width < 20 || r.height < 12) continue;           // ignore pixels/icônes minuscules
      var src = img.currentSrc || img.src || '';
      if (!src || src.indexOf('data:') === 0) continue;       // pas les data-URI (souvent illisibles)
      var clic = img.closest('a, button, [role="button"], [onclick]');
      var cs = window.getComputedStyle(img);
      if (!clic && cs.cursor !== 'pointer') continue;         // seulement si cliquable
      var cible = clic || img;
      var id = 'ocrimg-' + Date.now().toString(36) + '-' + out.length;
      cible.setAttribute('data-nav-id', id);
      out.push({ id: id, src: src });
    }
    return out;
  }

  window.addEventListener('message', function(ev){
    var d = ev.data;
    if (!d || d.source !== 'ohapiday-app') return;

    if (d.type === 'voice-point'){
      var el = trouver(d.label);
      if (el){
        pointer(el, !!d.click, d.label);
        versParent({ type:'voice-found', voiceId:d.voiceId });
      } else {
        // ÉTAPE 2 — findByText a échoué : on demande à l'IA de l'app de
        // relier ce que la personne a dit au vrai libellé d'un bouton.
        // (ex: "valider ma commande" -> "Finaliser l'achat")
        __resolvePending[d.voiceId] = { click: !!d.click, label: d.label };
        versParent({
          type: 'voice-resolve-request',
          voiceId: d.voiceId,
          label: d.label,
          elements: labelsCliquables()
        });
      }
    }
    else if (d.type === 'voice-resolve-response'){
      var pend = __resolvePending[d.voiceId];
      var cible = d.cible ? trouver(d.cible) : null;
      if (cible){
        delete __resolvePending[d.voiceId];
        pointer(cible, pend ? pend.click : false, d.cible);
        versParent({ type:'voice-found', voiceId:d.voiceId, resolvedBy:'ia' });
      } else {
        // ÉTAPE 3 — OCR : le libellé est peut-être écrit DANS une image
        // (bouton-image sans texte HTML). On envoie à l'app les images
        // cliquables ; elle les lit avec puter.ai.img2txt et nous dit
        // laquelle correspond.
        var imgs = imagesCliquables();
        if (imgs.length){
          versParent({
            type: 'voice-ocr-request',
            voiceId: d.voiceId,
            label: pend ? pend.label : d.cible,
            images: imgs
          });
        } else {
          delete __resolvePending[d.voiceId];
          versParent({ type:'voice-miss', voiceId:d.voiceId });
        }
      }
    }
    else if (d.type === 'voice-ocr-response'){
      var pend2 = __resolvePending[d.voiceId];
      delete __resolvePending[d.voiceId];
      var el2 = d.id ? document.querySelector('[data-nav-id="' + d.id + '"]') : null;
      if (el2){
        pointer(el2, pend2 ? pend2.click : false, pend2 ? pend2.label : '');
        versParent({ type:'voice-found', voiceId:d.voiceId, resolvedBy:'ocr' });
      } else {
        versParent({ type:'voice-miss', voiceId:d.voiceId });
      }
    }
    else if (d.type === 'nav-back'){ try { history.back(); } catch(e){} }
    else if (d.type === 'tts-speak-page'){
      var main = document.querySelector('main, article, [role=main], #content, .content') || document.body;
      var txt = (main.innerText || '').replace(/\s+/g,' ').trim().slice(0, 9000);
      try { window.postMessage({ source:'ohapiday-app', type:'tts-speak', text: txt }, '*'); } catch(e){}
    }
    else if (d.type === 'explique-mot'){
      versParent({ type:'explique-request', word: d.mot, context: '' });
    }
    else if (d.type === 'voice-list-elements'){
      var labels = cliquables().map(function(el){ return (el.innerText || el.value || '').trim().slice(0, 50); })
        .filter(Boolean).slice(0, 60);
      versParent({ type:'voice-elements', elements: labels });
    }
  });

  // signale que la page est prête (pour enchaîner "va sur X puis...")
  function pret(){ versParent({ type:'page-ready', url: (function(){ try { return new URLSearchParams(location.search).get('url') || location.href; } catch(e){ return location.href; } })() }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pret);
  else pret();
})();`;
}
