// ════════════════════════════════════════════════════════════════
// 🌉 Passerelle Web Proxy — Cloudflare Worker pour Oh API Day
// ════════════════════════════════════════════════════════════════
//
// QUOI ? Ce Worker permet à Astrid Navig de :
//   1. Charger les sites qui bloquent l'iframe (X-Frame-Options, CSP)
//   2. POINTER les éléments DANS la page web (Astrid Point in-iframe)
//   3. Lire la structure de la page pour qu'Astrid sache quoi pointer
//
// 🛡️ RATE LIMIT : 30 requêtes /proxy-web /jour /IP
//   → Protège le free tier Cloudflare contre les abus
//   → Les power-users peuvent déployer leur propre Worker (illimité)
//
// COMMENT DÉPLOYER ? (gratuit, 5 minutes)
//   1. Va sur https://dash.cloudflare.com (compte gratuit, pas de CB)
//   2. Workers & Pages → Create → Hello World
//   3. Nom : "ohapiday-proxy" (ou autre)
//   4. Edit code → efface tout → colle CE FICHIER → Save and Deploy
//
//   ⚠️ POUR LE RATE LIMIT (optionnel mais recommandé) :
//   5. Settings → Variables → KV Namespace Bindings → Add
//      Variable name: RATELIMIT
//      KV namespace: créer un nouveau "ohapiday-ratelimit"
//   6. Save and Deploy
//
//   Si pas de KV configuré → le Worker marche quand même, juste sans rate limit
//
// COÛT : gratuit jusqu'à 100 000 requêtes/jour.

const RATE_LIMIT_PER_IP_PER_DAY = 30;
const RATE_LIMIT_EXEMPT_TOKEN = null; // Optionnel : token secret pour exempter certains users

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

      // 🛡️ Rate limit check (uniquement sur /proxy-web, pas sur les assets)
      const rlCheck = await checkRateLimit(request, env, url);
      if (!rlCheck.allowed) return rlCheck.response;

      return await proxyRequest(target, url.origin, request);
    }

    if (path === '/proxy-asset' || path === '/proxy-asset/') {
      const target = url.searchParams.get('url');
      if (!target) return new Response('Missing ?url=', { status: 400, headers: corsHeaders() });
      return await proxyAsset(target);
    }

    if (path === '/health' || path === '/health/') {
      return new Response(JSON.stringify({
        ok: true,
        worker: 'ohapiday-passerelle-web',
        rateLimit: env.RATELIMIT ? 'enabled' : 'disabled',
        conav: env.CONAV_SESSIONS ? 'enabled' : 'disabled',
        limit: RATE_LIMIT_PER_IP_PER_DAY,
        time: new Date().toISOString()
      }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }

    // 🆕 ────────────── CO-NAVIGATION ──────────────
    // Sessions stockées dans KV `CONAV_SESSIONS` (TTL 1h auto)
    // Pas de Durable Objects → polling toutes les 2s côté client
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

    // ─── HEARTBEAT — Monitoring anonyme ──────────────────
    // POST /heartbeat : reçoit un ping anonyme du client
    // GET  /heartbeat/stats : retourne les stats agrégées (pas d'auth, lecture seule)
    if (path === '/heartbeat' && request.method === 'POST') {
      return await heartbeatReceive(request, env);
    }
    if (path === '/heartbeat/stats' && request.method === 'GET') {
      return await heartbeatStats(env);
    }

    return new Response('Not found', { status: 404, headers: corsHeaders() });
  }
};

// ════════════════════════════════════════════════════════════════
// 🛡️ RATE LIMIT : 30 req /jour /IP
// ════════════════════════════════════════════════════════════════
async function checkRateLimit(request, env, url) {
  // Si exempt token fourni et valide → pas de rate limit
  const exemptToken = url.searchParams.get('token');
  if (RATE_LIMIT_EXEMPT_TOKEN && exemptToken === RATE_LIMIT_EXEMPT_TOKEN) {
    return { allowed: true };
  }

  // Si pas de KV configuré → pas de rate limit (gracefully degrade)
  if (!env.RATELIMIT) {
    return { allowed: true };
  }

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const key = `rl:${ip}:${today}`;

  try {
    const count = parseInt(await env.RATELIMIT.get(key) || '0', 10);

    if (count >= RATE_LIMIT_PER_IP_PER_DAY) {
      const resetIn = Math.floor((new Date(today + 'T23:59:59Z').getTime() - Date.now()) / 1000);
      return {
        allowed: false,
        response: new Response(JSON.stringify({
          error: 'rate_limit_exceeded',
          message: 'Limite quotidienne atteinte (' + RATE_LIMIT_PER_IP_PER_DAY + ' pages/jour). Déploie ton propre Worker pour un usage illimité.',
          limit: RATE_LIMIT_PER_IP_PER_DAY,
          used: count,
          resetIn: resetIn,
          tutorial: 'https://github.com/TON_USER/oh-api-day-passerelle'
        }), {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'X-RateLimit-Limit': String(RATE_LIMIT_PER_IP_PER_DAY),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(resetIn),
            ...corsHeaders()
          }
        })
      };
    }

    // Incrémente le compteur (TTL = 24h = 86400s)
    await env.RATELIMIT.put(key, String(count + 1), { expirationTtl: 86400 });
    return { allowed: true, used: count + 1, remaining: RATE_LIMIT_PER_IP_PER_DAY - count - 1 };

  } catch (e) {
    // En cas d'erreur KV, on laisse passer (failsafe)
    console.error('Rate limit error:', e);
    return { allowed: true };
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

// 🛡️ Sécurité réseau : HTTPS only + anti-SSRF (IPs privées) + IPv6 + IPs raw
// Retourne null si OK, sinon string décrivant l'erreur
function securityCheck(target) {
  let url;
  try {
    url = new URL(target);
  } catch (e) {
    return 'URL invalide';
  }

  // 1. HTTPS only (sauf si user-agent explicite "dev"… pas implémenté ici)
  if (url.protocol !== 'https:') {
    return 'HTTPS requis (' + url.protocol + ' bloqué)';
  }

  const host = url.hostname.toLowerCase();

  // 2. Hostname spéciaux
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return 'Hostname local interdit (' + host + ')';
  }
  if (host.endsWith('.onion')) {
    return 'Réseau Tor non supporté';
  }
  if (host === '' || host === '.') {
    return 'Hostname vide';
  }

  // 3. IPs raw décimales (ex: http://2130706433 = 127.0.0.1)
  if (/^\d+$/.test(host)) {
    return 'IP au format décimal bloquée';
  }
  // IPs raw hex (ex: 0x7f000001)
  if (/^0x[0-9a-f]+$/i.test(host)) {
    return 'IP au format hexa bloquée';
  }

  // 4. IPv4 — bloque ranges privées et bogons
  // 0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16,
  // 172.16.0.0/12 (172.16-172.31), 192.168.0.0/16, 224.0.0.0/4 (multicast)
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

  // 5. IPv6 — bloque link-local, ULA, loopback
  // L'URL parse l'IPv6 entre crochets : url.hostname = "[::1]" devient "::1"
  if (host.includes(':') || host.startsWith('[')) {
    const v6 = host.replace(/^\[|\]$/g, '').toLowerCase();
    if (v6 === '::1' || v6 === '::') return 'IPv6 loopback bloqué';
    if (v6.startsWith('fe80:') || v6.startsWith('fe80::')) return 'IPv6 link-local bloqué';
    if (v6.startsWith('fc') || v6.startsWith('fd')) return 'IPv6 unique-local bloqué';
    if (v6.startsWith('ff')) return 'IPv6 multicast bloqué';
    // IPv4-mapped IPv6 (::ffff:127.0.0.1)
    if (/^::ffff:/.test(v6)) return 'IPv6 mappant IPv4 bloqué';
  }

  // 6. Cloudflare metadata API & cloud metadata
  if (host === '100.64.0.0' || host.startsWith('100.6')) {
    return 'CGN range bloqué';
  }

  return null;
}

async function proxyRequest(targetUrl, proxyOrigin, originalRequest) {
  // 🛡️ Auto-upgrade http:// → https:// (filet de sécurité côté serveur)
  // Si le client a réussi à passer du HTTP malgré l'upgrade côté client,
  // on force l'HTTPS plutôt que de bloquer (UX > strict)
  if (targetUrl && targetUrl.toLowerCase().startsWith('http://')) {
    targetUrl = 'https://' + targetUrl.substring(7);
  }

  // 🛡️ Vérif sécurité réseau AVANT tout fetch
  const secError = securityCheck(targetUrl);
  if (secError) {
    return new Response('🔒 ' + secError, {
      status: 403,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders() }
    });
  }

  try {
    const response = await fetch(targetUrl, {
      method: originalRequest.method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      redirect: 'follow',
    });

    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('text/html')) {
      let html = await response.text();
      html = rewriteHtml(html, targetUrl, proxyOrigin);
      return new Response(html, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          // 🛡️ CSP : restreint ce que la page proxifiée peut charger/exécuter
          // - default-src: par défaut, autorise HTTPS (les sites légitimes utilisent HTTPS)
          // - script-src: autorise scripts inline (le bridge) + HTTPS externes
          // - frame-ancestors 'self': la page ne peut être affichée que dans NOTRE iframe
          // - block-all-mixed-content: pas de HTTP dans une page HTTPS
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

    return new Response(response.body, {
      status: response.status,
      headers: { 'Content-Type': contentType, ...corsHeaders() },
    });
  } catch (e) {
    // 🛡️ Message pédagogique si le site HTTPS échoue (rare en 2026)
    const msg = e.message || '';
    let userMsg = 'Erreur proxy : ' + msg;
    if (/cert|ssl|tls|https/i.test(msg)) {
      userMsg = '🔒 Ce site n\'a pas de certificat HTTPS valide. Astrid ne charge que les sites sécurisés (HTTPS).';
    } else if (/refused|timeout|dns|enotfound/i.test(msg)) {
      userMsg = '⚠️ Site inaccessible. Vérifie l\'adresse ou réessaye plus tard.';
    }
    return new Response(userMsg, {
      status: 502,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', ...corsHeaders() }
    });
  }
}

async function proxyAsset(targetUrl) {
  try {
    const response = await fetch(targetUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 AppleWebKit/537.36' },
      redirect: 'follow',
    });
    const headers = new Headers();
    const ct = response.headers.get('content-type');
    if (ct) headers.set('Content-Type', ct);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Cache-Control', 'public, max-age=3600');
    return new Response(response.body, { status: response.status, headers });
  } catch (e) {
    return new Response('Asset proxy error', { status: 502 });
  }
}

function rewriteHtml(html, targetUrl, proxyOrigin) {
  const baseUrl = new URL(targetUrl);
  const baseHref = baseUrl.protocol + '//' + baseUrl.host;

  // Strip les balises qui bloquent l'iframe
  html = html.replace(/<meta\s+http-equiv\s*=\s*["']?X-Frame-Options["']?[^>]*>/gi, '');
  html = html.replace(/<meta\s+http-equiv\s*=\s*["']?Content-Security-Policy["']?[^>]*>/gi, '');

  // Réécrit les URLs absolues vers le site cible (links cliqués → proxifiés)
  const escapedHost = baseUrl.host.replace(/\./g, '\\.');
  const hostPattern = new RegExp('https?://(www\\.)?' + escapedHost + '([^"\'\\s)]*)', 'g');
  html = html.replace(hostPattern, (match) => {
    return proxyOrigin + '/proxy-web?url=' + encodeURIComponent(match);
  });

  // Injecte le bridge bidirectionnel (protocole ohapiday-bridge)
  const bridge = '\n<base href="' + baseHref + '/">\n' + buildBridgeScript(proxyOrigin, baseUrl.host);

  if (/<head[^>]*>/i.test(html)) {
    html = html.replace(/<head[^>]*>/i, (match) => match + bridge);
  } else {
    html = bridge + html;
  }

  return html;
}

// ═══════════════════════════════════════════════════════════════
// Bridge JavaScript injecté dans chaque page proxifiée
// Protocole bidirectionnel avec Astrid (source: 'ohapiday-bridge')
// ═══════════════════════════════════════════════════════════════
function buildBridgeScript(proxyOrigin, targetHost) {
  return `<script>
(function(){
  var PROXY_ORIGIN = '${proxyOrigin}';
  var TARGET_HOST = '${targetHost}';
  var HIGHLIGHT_ID = '__oapi_highlight__';

  // ── Intercepte les clics sur liens internes pour les router via proxy ──
  document.addEventListener('click', function(e) {
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href || href.indexOf('javascript:') === 0 || href.charAt(0) === '#') return;
    if (href.indexOf('mailto:') === 0 || href.indexOf('tel:') === 0) return;
    var absoluteUrl;
    try { absoluteUrl = new URL(href, document.baseURI).href; } catch (err) { return; }
    if (absoluteUrl.indexOf(PROXY_ORIGIN) === 0) return;
    if (absoluteUrl.indexOf(TARGET_HOST) !== -1 || a.hasAttribute('data-internal')) {
      e.preventDefault();
      window.location.href = PROXY_ORIGIN + '/proxy-web?url=' + encodeURIComponent(absoluteUrl);
    } else {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
  }, true);

  // ── Signal "bridge prêt" envoyé au parent (Astrid) ──
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

  // 🛡️ ── Sanitise un label DOM (defense in depth, niveau bridge) ──
  function sanitizeLabel(label) {
    if (!label) return '';
    var s = String(label);
    if (s.length > 80) s = s.substring(0, 80);
    s = s.replace(/[\u0000-\u001F\u007F]+/g, ' ');
    s = s.replace(/["`]/g, "'");
    // Détection grossière d'injection — si trouvé on remplace
    var bad = /\b(ignore|disregard|forget)\s+(all|previous|tout)\b|\b(you are now|tu es maintenant|jailbreak)\b|\[INST\]|<\|.+?\|>/i;
    if (bad.test(s)) return '[filtered]';
    return s.replace(/\s+/g, ' ').trim();
  }

  // ── Extraction du DOM : récupère les éléments interactifs visibles ──
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

  // 🆕 ── Recherche dans la page ENTIÈRE par texte ──
  // Quand l'IA mentionne un label qu'on ne trouve pas dans les 80 extraits,
  // on scanne tout le document à la recherche d'un élément cliquable qui le contient.
  function findByText(searchText) {
    if (!searchText) return null;
    var target = String(searchText).toLowerCase().trim();
    if (target.length < 2) return null;

    // 1) Tous les éléments interactifs (large + role)
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

      // Match exact (priorité 1)
      if (labelLower === target) {
        bestExact = { el: el, label: label.substring(0, 80) };
        break;
      }
      // Contient (priorité 2)
      if (!bestContains && labelLower.indexOf(target) !== -1) {
        bestContains = { el: el, label: label.substring(0, 80) };
      }
    }

    var match = bestExact || bestContains;
    if (!match) {
      // 2) Fallback : recherche dans TOUS les éléments (au cas où l'élément
      //    cliquable n'a pas de role mais a un parent cliquable)
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

    // Génère un selector stable
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

  // ── Highlight un élément (par sélecteur) avec une animation pulsante ──
  // 🆕 ── AUTO-CLIC : simule un clic réel sur un élément ──
  // Utilisé par le mode auto-clic d'Astrid. Retourne true si OK.
  // 🆕 ── DÉTECTION HEURISTIQUE DARK PATTERNS ──
  // Analyse le DOM pour repérer des patterns suspects (sans IA, juste règles).
  // Complète la détection IA pour des patterns évidents/visuels.
  function detectDarkPatterns() {
    var warnings = [];
    try {
      // 1. Cases pré-cochées (newsletter, partenaires)
      var checkedBoxes = document.querySelectorAll('input[type="checkbox"][checked], input[type="checkbox"]:checked');
      var suspiciousChecks = 0;
      checkedBoxes.forEach(function(cb) {
        // Cherche le label associé
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

      // 2. Boutons "Accepter tout" surdimensionnés vs alternatives discrètes
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

      // 3. Comptes à rebours / urgence
      var bodyText = (document.body.textContent || '').toLowerCase();
      if (/plus que \d+ (place|article|en stock|disponible)/.test(bodyText) ||
          /offre se termine dans/.test(bodyText) ||
          /(\d{1,2}:\d{2}:\d{2})/.test(bodyText)) {
        var timers = document.querySelectorAll('[class*="countdown"], [class*="timer"], [id*="countdown"]');
        if (timers.length > 0) {
          warnings.push({
            level: 'info',
            text: 'Compte à rebours visible sur cette page. Pas besoin de te précipiter.'
          });
        }
      }

      // 4. Confirmshaming
      allBtns.forEach(function(b) {
        var txt = (b.textContent || '').toLowerCase().trim().substring(0, 100);
        if (/non merci.*(payer|prix fort|cher)|je ne veux pas (économiser|gagner)/.test(txt)) {
          warnings.push({
            level: 'info',
            text: 'Texte du bouton à lire attentivement : "' + (b.textContent || '').trim().substring(0, 80) + '". Choisis selon ce que tu veux vraiment.'
          });
        }
      });

    } catch (e) {
      // Échec silencieux, pas grave
    }
    return warnings;
  }

  function clickElement(selector) {
    if (!selector) return false;
    var el;
    try { el = document.querySelector(selector); } catch (e) { return false; }
    if (!el) return false;

    // Vérifie que l'élément est cliquable (visible, pas désactivé)
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    if (el.disabled) return false;

    // Scroll vers l'élément s'il n'est pas visible
    if (rect.top < 0 || rect.bottom > window.innerHeight) {
      try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch(e) {}
    }

    try {
      // Méthode 1 : focus + click natif (marche pour la plupart des cas)
      if (typeof el.focus === 'function') el.focus();
      el.click();
      return true;
    } catch (e) {
      // Méthode 2 : événement MouseEvent (fallback pour les éléments custom)
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

  function highlightElement(selector, label, safeBottom, largeMode) {
    // Cleanup existant
    var existing = document.getElementById(HIGHLIGHT_ID);
    if (existing) existing.remove();

    var el;
    try { el = document.querySelector(selector); } catch (e) { return false; }
    if (!el) return false;

    safeBottom = parseInt(safeBottom) || 0;
    var visibleHeight = window.innerHeight - safeBottom;
    if (visibleHeight < 200) visibleHeight = window.innerHeight;

    var targetY = Math.max(80, visibleHeight * 0.35);
    var rect = el.getBoundingClientRect();
    var scrollDelta = rect.top - targetY;

    try {
      if (Math.abs(scrollDelta) > 20) {
        window.scrollBy({ top: scrollDelta, behavior: 'smooth' });
      }
    } catch (e) {
      try { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch(_) {}
    }

    // 🆕 Mode senior : cercle et label plus gros et plus contrastés
    var BORDER_W   = largeMode ? '5px' : '3px';
    var INSET      = largeMode ? '-10px' : '-6px';
    var BORDER_RAD = largeMode ? '14px' : '10px';
    var SHADOW_BASE = largeMode
      ? '0 0 0 7px rgba(255,149,0,0.35),0 0 32px rgba(255,149,0,0.7)'
      : '0 0 0 4px rgba(255,149,0,0.25),0 0 22px rgba(255,149,0,0.5)';
    var LABEL_FONT  = largeMode ? '16px' : '12px';
    var LABEL_PAD   = largeMode ? '11px 18px' : '7px 12px';
    var LABEL_RAD   = largeMode ? '12px' : '9px';
    var LABEL_MAXW  = largeMode ? '320px' : '240px';

    var overlay = document.createElement('div');
    overlay.id = HIGHLIGHT_ID;
    overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;transition:transform .2s ease;';
    overlay.innerHTML = (
      '<div style="position:absolute;inset:' + INSET + ';border:' + BORDER_W + ' solid #FF9500;border-radius:' + BORDER_RAD + ';' +
      'box-shadow:' + SHADOW_BASE + ';' +
      'animation:oapiHighlightPulse 1.4s ease-in-out infinite"></div>' +
      (label ? ('<div style="position:absolute;left:50%;transform:translateX(-50%);top:100%;margin-top:' + (largeMode ? '18px' : '14px') + ';' +
      'background:#1F1135;color:#FFE8B5;padding:' + LABEL_PAD + ';border-radius:' + LABEL_RAD + ';font-size:' + LABEL_FONT + ';font-weight:' + (largeMode ? '800' : '700') + ';' +
      'font-family:system-ui,sans-serif;white-space:nowrap;box-shadow:0 4px 14px rgba(0,0,0,0.3);' +
      'max-width:' + LABEL_MAXW + ';overflow:hidden;text-overflow:ellipsis">☝️ ' +
      String(label).replace(/</g, '&lt;') + '</div>') : '')
    );

    // Inject l'animation CSS si pas déjà là
    if (!document.getElementById('oapi-highlight-style')) {
      var st = document.createElement('style');
      st.id = 'oapi-highlight-style';
      st.textContent = '@keyframes oapiHighlightPulse{0%,100%{box-shadow:0 0 0 4px rgba(255,149,0,0.25),0 0 22px rgba(255,149,0,0.5)}50%{box-shadow:0 0 0 12px rgba(255,149,0,0),0 0 36px rgba(255,149,0,0.8)}}';
      document.head.appendChild(st);
    }

    document.body.appendChild(overlay);

    // Position suit la cible (rAF pendant 12s)
    var startTs = Date.now();
    function reposition() {
      if (Date.now() - startTs > 12000) {
        if (overlay.parentNode) overlay.remove();
        return;
      }
      if (!overlay.parentNode || !el.isConnected) return;
      var r = el.getBoundingClientRect();
      overlay.style.left = r.left + 'px';
      overlay.style.top = r.top + 'px';
      overlay.style.width = r.width + 'px';
      overlay.style.height = r.height + 'px';
      requestAnimationFrame(reposition);
    }
    reposition();

    // Click sur la cible → masque + signale au parent
    function onClickTarget() {
      if (overlay.parentNode) overlay.remove();
      el.removeEventListener('click', onClickTarget);
      // 🆕 Signale à Astrid pour qu'elle passe à l'étape suivante
      try {
        window.parent.postMessage({
          source: 'ohapiday-bridge',
          type: 'target-clicked',
          selector: selector,
          label: label || ''
        }, '*');
      } catch (e) {}
    }
    el.addEventListener('click', onClickTarget);

    return true;
  }

  // ── Écoute les messages d'Astrid (source: 'ohapiday-app') ──
  window.addEventListener('message', function(ev) {
    var d = ev.data;
    if (!d || typeof d !== 'object' || d.source !== 'ohapiday-app') return;

    if (d.type === 'extract-dom') {
      var dom = extractDOM();
      // 🆕 Détecte les dark patterns heuristiques (côté worker)
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
    // 🆕 Recherche un élément par texte dans la page entière
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
    // 🆕 AUTO-CLIC : Astrid clique pour l'utilisateur
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
      // Si clic réussi, signale aussi un target-clicked pour avancer la séquence
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

  // ── Signal de prêt : au load et après un petit délai (SPA) ──
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


// ═════════════════════════════════════════════════════════════════
// 🤝 CO-NAVIGATION — sync de session entre 2 participants
// ═════════════════════════════════════════════════════════════════
// Architecture :
//   - Sessions stockées dans KV CONAV_SESSIONS (TTL 1h)
//   - Polling client toutes les 2s
//   - 2 rôles : host (l'aidé) et guest (l'aidant)
//   - Events partagés : url, message, highlight, click, leave
//
// Format session dans KV :
//   {
//     code: "421879",
//     hostToken: "abc...",  guestToken: "def..." | null,
//     currentUrl: "https://...",
//     events: [{id, type, from, ...payload}],
//     hostName: "Papi", guestName: "Marie",
//     createdAt: ms, lastActivity: ms
//   }
// ═════════════════════════════════════════════════════════════════

const CONAV_TTL_SECONDS = 3600;       // 1h
const CONAV_MAX_EVENTS = 200;          // garde les 200 derniers events
const CONAV_CODE_LENGTH = 6;

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() }
  });
}

function genCode() {
  // 6 chiffres aléatoires, format "421879"
  var c = '';
  for (var i = 0; i < CONAV_CODE_LENGTH; i++) c += Math.floor(Math.random() * 10);
  return c;
}

function genToken() {
  // Token alphanumérique
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

// 🛡️ HMAC SHA-256 (Web Crypto API native dans Cloudflare Workers)
async function hmacSha256(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// 🛡️ Vérifie le token d'auth client (HMAC + timestamp anti-replay)
// Format header X-Astrid-Auth : "timestamp.signature"
async function verifyClientToken(request, env) {
  const auth = request.headers.get('X-Astrid-Auth');
  if (!auth) return { ok: false, reason: 'Token manquant' };

  const parts = auth.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'Format token invalide' };
  const [tsStr, signature] = parts;
  const ts = parseInt(tsStr, 10);
  if (isNaN(ts)) return { ok: false, reason: 'Timestamp invalide' };

  // Reject si timestamp trop ancien (>5min) ou futur (>1min)
  const now = Date.now();
  if (now - ts > 5 * 60 * 1000) return { ok: false, reason: 'Token expiré' };
  if (ts - now > 60 * 1000) return { ok: false, reason: 'Token futur' };

  // Vérifie la signature
  const secret = (env && env.ASTRID_SHARED_SECRET) || 'astrid-default-secret-change-in-prod-v1';
  const expected = await hmacSha256(secret, tsStr);
  if (signature !== expected) return { ok: false, reason: 'Signature invalide' };

  return { ok: true };
}

// 🛡️ Rate limit par IP (KV) — max N actions par fenêtre TTL
async function rateLimitByIP(env, ip, action, max, windowSec) {
  if (!env || !env.RATELIMIT || !ip) return false; // skip si KV pas dispo
  const key = 'rl:' + action + ':' + ip;
  const cur = await env.RATELIMIT.get(key);
  const count = parseInt(cur, 10) || 0;
  if (count >= max) return true; // bloqué
  await env.RATELIMIT.put(key, String(count + 1), { expirationTtl: windowSec });
  return false;
}

// ═══════════════════════════════════════════════════════════════
// 📊 HEARTBEAT — Monitoring anonyme et agrégé
// ═══════════════════════════════════════════════════════════════
// Reçoit des pings du client : { event, success, domain, duration }
// AUCUNE donnée personnelle (pas d'IP loggée, pas d'URL complète, pas de contenu).
// Stocke en KV avec TTL 7j, agrégé par jour+événement+résultat.

async function heartbeatReceive(request, env) {
  if (!env || !env.CONAV_SESSIONS) {
    return jsonResponse({ ok: false, reason: 'KV indispo' }, 503);
  }
  let body;
  try { body = await request.json(); } catch (e) {
    return jsonResponse({ error: 'JSON invalide' }, 400);
  }

  // 🛡️ Rate limit par IP : 50 requêtes / 10 min / IP (chaque requête peut contenir un batch)
  // Réduit de 200 → 50 pour encourager le batching côté client
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (await rateLimitByIP(env, ip, 'hb', 50, 600)) {
    return jsonResponse({ ok: false, reason: 'rate limit' }, 429);
  }

  // Détecte si c'est un batch (nouveau format) ou un event unique (ancien format)
  let events = [];
  if (body && Array.isArray(body.batch)) {
    // Nouveau format : { batch: [event1, event2, ...] }
    events = body.batch.slice(0, 50); // cap à 50 events/batch (anti-abus)
  } else if (body && body.event) {
    // Ancien format : { event, success, domain, duration }
    events = [body];
  } else {
    return jsonResponse({ error: 'Format invalide' }, 400);
  }

  // 🛡️ Agrégation : on accumule tous les events dans une map en mémoire
  // Puis on fait UNE écriture KV par bucket day-event-outcome
  const buckets = new Map();
  for (const evt of events) {
    if (!evt) continue;
    // Whitelist stricte
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

  // 🛡️ Écriture KV : UNE write par bucket (même si N events)
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
      // Cap les domains à 100 (anti-pollution)
      const dKeys = Object.keys(agg.domains);
      if (dKeys.length > 100) {
        const sorted = dKeys.sort((a, b) => agg.domains[b] - agg.domains[a]).slice(0, 50);
        const trimmed = {};
        sorted.forEach(k => trimmed[k] = agg.domains[k]);
        agg.domains = trimmed;
      }
      await env.CONAV_SESSIONS.put(key, JSON.stringify(agg), { expirationTtl: 7 * 86400 });
    } catch (e) {
      // Silencieux : un fail sur un bucket ne bloque pas les autres
    }
  }
  return jsonResponse({ ok: true, processed: events.length, buckets: buckets.size });
}

// GET /heartbeat/stats — vue agrégée des 7 derniers jours
// Pas d'auth : c'est public mais ne contient AUCUNE donnée personnelle
async function heartbeatStats(env) {
  if (!env || !env.CONAV_SESSIONS) {
    return jsonResponse({ error: 'KV indispo' }, 503);
  }
  try {
    const list = await env.CONAV_SESSIONS.list({ prefix: 'hb:', limit: 1000 });
    const stats = {};
    for (const k of list.keys) {
      const v = await env.CONAV_SESSIONS.get(k.name);
      if (!v) continue;
      const parts = k.name.split(':'); // hb:YYYY-MM-DD:event:outcome
      if (parts.length !== 4) continue;
      const day = parts[1], event = parts[2], outcome = parts[3];
      stats[day] = stats[day] || {};
      stats[day][event] = stats[day][event] || { ok: 0, fail: 0, na: 0, durationAvgMs: null, topDomains: {} };
      try {
        const agg = JSON.parse(v);
        stats[day][event][outcome] = agg.count;
        if (agg.durationCount > 0) {
          stats[day][event].durationAvgMs = Math.round(agg.durationSum / agg.durationCount);
        }
        // Merge top domains
        for (const [d, c] of Object.entries(agg.domains || {})) {
          stats[day][event].topDomains[d] = (stats[day][event].topDomains[d] || 0) + c;
        }
      } catch (e) {}
    }
    return jsonResponse({ ok: true, stats: stats, generated: new Date().toISOString() });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

// POST /conav/create — l'aidé crée une session
async function conavCreate(env, request) {
  // 🛡️ Authentification client (anti-spam)
  const auth = await verifyClientToken(request, env);
  if (!auth.ok) {
    return jsonResponse({ error: 'Auth requise : ' + auth.reason }, 401);
  }

  // 🛡️ Rate limit par IP : max 5 sessions créées par 10 min
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (await rateLimitByIP(env, ip, 'conav-create', 5, 600)) {
    return jsonResponse({ error: 'Trop de sessions créées récemment, réessaye dans 10 minutes.' }, 429);
  }

  // Génère un code unique (retry 5x si collision)
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

// POST /conav/join — l'aidant rejoint une session avec un code
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
  // Ajoute un event "guest-joined" pour notifier l'hôte
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

// GET /conav/poll?code=X&token=Y&since=N — récupère les events depuis "since"
async function conavPoll(request, env) {
  const url = new URL(request.url);
  const code = (url.searchParams.get('code') || '').replace(/[^0-9]/g, '');
  const token = url.searchParams.get('token') || '';
  const since = parseInt(url.searchParams.get('since') || '0', 10);

  const session = await loadSession(env, code);
  if (!session) return jsonResponse({ error: 'Session expirée' }, 404);

  // Vérifie le token
  const role = (token === session.hostToken) ? 'host' :
               (token === session.guestToken) ? 'guest' : null;
  if (!role) return jsonResponse({ error: 'Token invalide' }, 403);

  // Filtre les events : seulement ceux après "since" ET pas envoyés par soi-même
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

// POST /conav/send — envoie un event dans la session
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

  // Validation type
  const validTypes = ['message', 'url-change', 'highlight', 'click-request', 'click-result', 'set-name', 'ping'];
  if (!validTypes.includes(type)) return jsonResponse({ error: 'Type invalide' }, 400);

  // 🛡️ Rate limit serveur : empêche le spam de click-request (anti-DoS local)
  // 3s minimum entre 2 clic-requests, 1s entre 2 highlights
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

  // Set-name : pour update le nom du participant
  if (type === 'set-name') {
    const name = String(body.name || '').substring(0, 30);
    if (role === 'host') session.hostName = name || 'Hôte';
    else session.guestName = name || 'Invité';
  }

  // Url-change : mémorise la dernière URL (hôte seulement)
  if (type === 'url-change' && body.url && role === 'host') {
    session.currentUrl = String(body.url).substring(0, 500);
  }

  // Ajoute l'event
  const evt = {
    id: 'e_' + Date.now().toString(36) + Math.random().toString(36).slice(2,5),
    type: type,
    from: role,
    ts: Date.now()
  };
  // Copie les champs utiles selon le type
  ['text', 'url', 'selector', 'label', 'safeBottom', 'largeMode', 'name', 'ok'].forEach(k => {
    if (body[k] !== undefined) evt[k] = body[k];
  });

  session.events = (session.events || []).concat([evt]);
  // Garde les derniers N events
  if (session.events.length > CONAV_MAX_EVENTS) {
    session.events = session.events.slice(-CONAV_MAX_EVENTS);
  }

  await saveSession(env, session);
  return jsonResponse({ ok: true, eventId: evt.id });
}

// POST /conav/leave — quitte la session
async function conavLeave(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: 'JSON invalide' }, 400); }
  const code = String(body.code || '').replace(/[^0-9]/g, '');
  const token = String(body.token || '');

  const session = await loadSession(env, code);
  if (!session) return jsonResponse({ ok: true }); // déjà parti

  const role = (token === session.hostToken) ? 'host' :
               (token === session.guestToken) ? 'guest' : null;
  if (!role) return jsonResponse({ error: 'Token invalide' }, 403);

  // Ajoute un event leave
  session.events = (session.events || []).concat([{
    id: 'e_' + Date.now().toString(36),
    type: 'peer-left',
    from: role,
    ts: Date.now()
  }]);

  // Si c'est l'hôte qui part → on supprime la session
  // Si c'est le guest → on libère juste son token pour qu'un autre puisse rejoindre
  if (role === 'host') {
    await env.CONAV_SESSIONS.delete('s:' + code);
  } else {
    session.guestToken = null;
    session.guestName = null;
    await saveSession(env, session);
  }
  return jsonResponse({ ok: true });
}
