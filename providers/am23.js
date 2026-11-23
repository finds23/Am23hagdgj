/**
 * AnimeD23 (animed23.com) - plugin para Nuvio
 * Flujo: TMDB -> pagina del episodio /capitulo/<slug>-temporada-N-ep-M/
 *        -> iframe https://animed23.online/container.php?id=<ID>
 *        -> container.php?id=<ID>&open=1 (pantalla de idiomas) -> &lang=LAT|SUB|... (botones data-player-url)
 *        -> extractor por servidor.
 * Slugs: ver baseSlugsOf/episodeSlugs (AniList da el titulo romaji y el del arco; /?s= y la pagina de la serie son el respaldo).
 * Idiomas vistos: SUB, LAT, CAST. Servidores vistos en LAT/CAST: Byse, Omega (mp4 en archive.org), MEGA, Epsilon, Abyss.
 * En SUB: Byse, Omega, MEGA, OK (ok.ru), Abyss. Nota: en SUB el Omega esta roto en la propia pagina del sitio (da 403), no es fallo del plugin.
 *
 * v1.0.3: si la pagina del episodio existe (HTTP 200) pero NO trae el iframe container.php (caso: Tsuihou sareta Tensei Juukishi ep. 1),
 *         el diagnostico vuelca los iframes, los atributos data-*, los scripts y las palabras clave del reproductor para ver que
 *         formato usa esa pagina. Tambien muestra una muestra de los enlaces /capitulo/ de la pagina de la serie.
 * v1.0.4: algunas paginas (animes nuevos) traen otro iframe: https://animed23.online/opciones/options.php?server=multi&value=<base64>.<firma>
 *         En ese caso se descarga esa pagina y se leen los botones data-player-url. Si la pagina trae container.php se usa el flujo de siempre.
 */
if (typeof globalThis.setTimeout !== "function") {
  globalThis.setTimeout = function () { return 1; };
  globalThis.clearTimeout = function () {};
}

var AD_BASE = "https://animed23.com";
var TMDB_API_KEY = "56db0ec297530920213e1503706b81ff";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
var MOBILE_UA = "Mozilla/5.0 (Linux; Android 13; moto g82 5G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Mobile Safari/537.36";

// Activa/desactiva servidores. Nada de esto se ha probado todavia contra el sitio real.
var ENABLED_SOURCES = {
  Omega: true,     // mp4 directo en archive.org; PROBADO: reproduce (LAT). En SUB esta roto en el sitio
  Okru: true,      // ok.ru (solo en SUB); PROBADO: reproduce
  Epsilon: false,  // sin extractor. peeplayer.com cifra los segmentos en el navegador (intercambio de claves /kx + AES-CBC por segmento): no hay .m3u8 usable. En algunos animes es ytplay.rpmvid.com (/api/public/resolve?file1=...), sin investigar
  Abyss: false,    // abyssplayer.com: la pagina abre bien, pero el campo "media" del JSON base64 va cifrado y lo descifra core.bundle.js (no visto)
  Byse: false,     // bysesukior.com: descartado (antibot)
  MEGA: false      // mega.nz: cifrado en el cliente, no sirve para un plugin
};
// Servidores sin extractor cuyo HTML se vuelca en pantalla cuando DEBUG esta activo
// Epsilon solo se vuelca si NO es peeplayer.com (ese ya se conoce)
var DUMP_SOURCES = { Epsilon: true, Abyss: false };

var VERSION = "1.0.4"; // se muestra en el diagnostico para saber que copia del plugin esta cargando Nuvio
var DEBUG = true; // TEMPORAL: muestra el diagnostico. Poner en false cuando todo funcione.
var DUMP_MAX = 30000; // maximo de caracteres por volcado
var TRACE = [];
var DUMPS = [];
var PAGE_DUMPED = false; // un solo volcado de pagina sin container.php por ejecucion
function trace(msg) { TRACE.push(String(msg).replace(/\s+/g, " ").slice(0, 300)); }
function dump(title, text) { DUMPS.push({ title: String(title), text: String(text || "") }); }

var SERVER_ORDER = ["Omega", "Okru", "Epsilon", "Abyss", "Byse", "MEGA"];
var LANG_ORDER = ["LAT", "CAST", "CAS", "ESP", "SUB"];
var LANG_NAMES = { LAT: "Latino", CAST: "Castellano", CAS: "Castellano", ESP: "Castellano", SUB: "Subtitulado" };
var LANG_FALLBACK = ["LAT", "SUB"]; // si la pantalla open=1 no deja ver los idiomas

// ---------- utilidades ----------
function norm(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}
function slugify(s) {
  return norm(s).replace(/['\u2019`]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function decodeEntities(s) {
  return String(s || "")
    .replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#0?38;/g, "&").replace(/&#x26;/gi, "&").replace(/&amp;/g, "&");
}
function shortErr(e) { return String(e && e.message || e).replace(/ en https?:\/\/\S+/, ""); }
function hostOf(u) { var m = /^(?:https?:)?\/\/([^\/?#:]+)/i.exec(String(u || "")); return m ? m[1].toLowerCase() : "?"; }
function originOf(u) { var m = /^(https?:\/\/[^\/?#]+)/i.exec(String(u || "")); return m ? m[1] : ""; }
// Solo cuenta como bloqueo con HTTP 403/429/503 o con el texto del reto. (La pagina 404 normal trae scripts de Cloudflare y no es un bloqueo.)
function looksBlocked(html, status) {
  var txt = /just a moment|attention required|enable javascript and cookies/i.test(html || "");
  if (txt) return true;
  return (status === 403 || status === 429 || status === 503) && /cf-chl|challenge-platform|cloudflare/i.test(html || "");
}
function withTimeout(promise, ms, label) {
  return new Promise(function (resolve, reject) {
    var done = false;
    var t = setTimeout(function () {
      if (!done) { done = true; reject(new Error((label || "operacion") + ": timeout")); }
    }, ms);
    promise.then(function (v) { if (!done) { done = true; clearTimeout(t); resolve(v); } },
      function (e) { if (!done) { done = true; clearTimeout(t); reject(e); } });
  });
}
function browserHeaders(referer) {
  var h = {
    "User-Agent": MOBILE_UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "es-419,es;q=0.9",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": referer ? "cross-site" : "none",
    "Sec-Fetch-User": "?1"
  };
  if (referer) h["Referer"] = referer;
  return h;
}
async function fetchPage(url, headers) {
  var resp = await fetch(url, { headers: Object.assign({ "User-Agent": UA }, headers || {}) });
  var text = "";
  try { text = await resp.text(); } catch (_) { /* cuerpo no legible */ }
  return { ok: resp.ok, status: resp.status, text: text };
}

// ---------- TMDB ----------
async function getTMDBInfo(tmdbId, season) {
  var base = "https://api.themoviedb.org/3/tv/" + tmdbId + "?api_key=" + TMDB_API_KEY;
  var langs = ["en-US", "es-MX"];
  var titles = [];
  var main = null;
  for (var i = 0; i < langs.length; i++) {
    try {
      var d = await fetch(base + "&language=" + langs[i], { headers: { "User-Agent": UA } }).then(function (r) { return r.json(); });
      if (!d || d.success === false) continue;
      if (!main) main = d;
      [d.name, d.original_name].forEach(function (t) { if (t && titles.indexOf(t) === -1) titles.push(t); });
    } catch (e) { /* siguiente idioma */ }
  }
  if (!main) return null;
  // Solo titulos con letras latinas sirven para armar slugs
  var latin = titles.filter(function (t) { return slugify(t).length >= 2; });
  var year = main.first_air_date ? parseInt(String(main.first_air_date).slice(0, 4), 10) : null;
  var info = { titles: latin, year: year, seasonName: "", airDate: null };
  // Fecha de estreno y nombre de la temporada (sirven para ubicar el arco en AniList)
  try {
    var sd = await fetch("https://api.themoviedb.org/3/tv/" + tmdbId + "/season/" + season + "?api_key=" + TMDB_API_KEY + "&language=en-US", { headers: { "User-Agent": UA } }).then(function (r) { return r.json(); });
    if (sd && sd.success !== false) { info.airDate = sd.air_date || null; info.seasonName = sd.name || ""; }
  } catch (e) { /* sin datos de temporada */ }
  if (!info.airDate && season === 1) info.airDate = main.first_air_date || null;
  return info;
}
function dateDays(str) {
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(str || ""));
  return m ? Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) : null;
}

// ---------- similitud de titulos ----------
var STOP = ["the", "a", "an", "of", "and", "no", "wa", "wo", "ni", "to", "ga", "de", "la", "el", "los", "las", "y", "en", "del"];
function stripSeasonWords(s) {
  return String(s || "")
    .replace(/\b\d{1,2}(?:st|nd|rd|th)\s+season\b/gi, " ")
    .replace(/\bseason\s*\d{1,2}\b/gi, " ")
    .replace(/\btemporada\s*\d{1,2}\b/gi, " ")
    .replace(/\bpart\s*\d{1,2}\b/gi, " ");
}
function tokens(s) {
  var seen = {}, out = [];
  slugify(stripSeasonWords(s)).split("-").forEach(function (w) {
    if (w && STOP.indexOf(w) === -1 && !seen[w]) { seen[w] = true; out.push(w); }
  });
  return out;
}
function similarity(a, b) {
  var A = tokens(a), B = tokens(b);
  if (!A.length || !B.length) return 0;
  if (A.join("") === B.join("")) return 1;
  var setB = {};
  B.forEach(function (w) { setB[w] = true; });
  var inter = A.filter(function (w) { return setB[w]; }).length;
  return 2 * inter / (A.length + B.length);
}
function bestSimilarity(text, titles) {
  var best = 0;
  titles.forEach(function (t) { var s = similarity(text, t); if (s > best) best = s; });
  return best;
}

// ---------- AniList: titulo romaji y titulo del arco ----------
// El sitio usa el titulo romaji ("Ushiro no Shoumen Kamui-san") y a veces trata un arco como serie aparte
// ("Tokyo Revengers: Santen Sensou-hen"). TMDB no da esos nombres; AniList si.
// Devuelve { related: [nombres de entradas parecidas], arc: [nombres de la entrada que estrena en la fecha de la temporada] }
async function getAniList(info) {
  var out = { related: [], arc: [] };
  var airDays = dateDays(info.airDate);
  var query = "query ($search: String) { Page(page: 1, perPage: 15) { media(search: $search, type: ANIME, sort: SEARCH_MATCH) { title { romaji english } synonyms startDate { year month day } } } }";
  var queries = info.titles.slice(0, 2);
  for (var qi = 0; qi < queries.length; qi++) {
    try {
      var resp = await fetch("https://graphql.anilist.co", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ query: query, variables: { search: queries[qi] } })
      });
      if (!resp.ok) { trace("AniList HTTP " + resp.status); continue; }
      var json = await resp.json();
      var media = (json && json.data && json.data.Page && json.data.Page.media) || [];
      var best = null, bestDiff = 1e9;
      media.forEach(function (m) {
        var names = [m.title && m.title.romaji, m.title && m.title.english].concat(m.synonyms || []).filter(Boolean);
        var diff = 1e9;
        var sd = m.startDate || {};
        if (airDays !== null && sd.year) diff = Math.abs(Math.floor(Date.UTC(sd.year, (sd.month || 1) - 1, sd.day || 15) / 86400000) - airDays);
        var related = names.some(function (n) { return info.titles.some(function (t) { return similarity(n, t) >= 0.5; }); }) || diff <= 7;
        if (!related) return;
        names.forEach(function (n) { if (slugify(n).length >= 2 && out.related.indexOf(n) === -1) out.related.push(n); });
        if (diff < bestDiff) { bestDiff = diff; best = m; }
      });
      if (best && bestDiff <= 60) {
        var arcNames = [best.title.romaji, best.title.english].concat((best.synonyms || []).filter(function (n) { return slugify(n).length >= 4; }).slice(0, 4)).filter(Boolean);
        arcNames.forEach(function (n) { if (slugify(n).length >= 2 && out.arc.indexOf(n) === -1) out.arc.push(n); });
        trace("AniList: entrada por fecha (" + bestDiff + " dias): " + (best.title.romaji || best.title.english));
        break;
      }
      trace("AniList '" + queries[qi] + "': " + media.length + " resultados, ninguno estrena cerca de " + (info.airDate || "?"));
    } catch (e) {
      trace("AniList fallo: " + shortErr(e));
    }
  }
  out.related = out.related.slice(0, 12);
  return out;
}

// ---------- pagina del episodio ----------
// Formas vistas en el sitio:
//   black-clover-ep-1                          (temporada 1)
//   black-clover-temporada-2-ep-5              (temporada 2 de la misma serie)
//   tokyo-revengers-santen-sensou-hen-ep-8     (arco como serie aparte, sin "temporada")
//   ushiro-no-shoumen-kamui-san-ep-1           (titulo romaji)
function baseSlugsOf(info) {
  var bases = [];
  info.titles.forEach(function (t) {
    var b = slugify(stripSeasonWords(t));
    if (b && bases.indexOf(b) === -1) bases.push(b);
  });
  return bases;
}
function episodeSlugs(info, season, episode, arc) {
  var bases = baseSlugsOf(info);
  var out = [];
  function add(x) { if (x && out.indexOf(x) === -1) out.push(x); }
  var arcSlugs = [];
  function addArc(x) { if (x && x.length >= 4 && arcSlugs.indexOf(x) === -1) arcSlugs.push(x); }
  (arc || []).forEach(function (t) { addArc(slugify(t)); });
  // Nombre de la temporada en TMDB, si no es generico (ej. "Santen Sensou-hen")
  var sn = info.seasonName;
  if (sn && season > 1 && !/^(season|temporada|specials?|especiales?)\b/i.test(sn) && slugify(sn).length >= 4) {
    bases.forEach(function (b) { addArc(slugify(b + " " + sn)); });
  }
  if (season > 1) {
    // Con temporada mayor a 1, el titulo a secas seria la serie equivocada (temporada 1)
    arcSlugs.forEach(function (sl) { if (bases.indexOf(sl) === -1) add(sl + "-ep-" + episode); });
    bases.forEach(function (b) {
      add(b + "-temporada-" + season + "-ep-" + episode);
      add(b + "-" + season + "-ep-" + episode);
      add(b + "-season-" + season + "-ep-" + episode);
    });
  } else {
    bases.forEach(function (b) { add(b + "-ep-" + episode); add(b + "-temporada-1-ep-" + episode); });
    arcSlugs.forEach(function (sl) { add(sl + "-ep-" + episode); });
  }
  return out.slice(0, 16);
}
// Busca el iframe del reproductor: .../container.php?id=<ID>
function findContainer(html) {
  var m = /(?:https?:)?(?:\\?\/){2}([a-z0-9.-]+)(?:\\?\/)container\.php\?id=([A-Za-z0-9_-]+)/i.exec(html || "");
  return m ? { host: m[1].toLowerCase(), id: m[2] } : null;
}
// v1.0.4: iframe alterno .../opciones/options.php?server=multi&value=<base64>.<firma>&bg=...
function findOptions(html) {
  var m = /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']*\/opciones\/options\.php[^"']*)["']/i.exec(html || "");
  if (!m) return "";
  var u = decodeEntities(m[1]);
  if (u.indexOf("//") === 0) u = "https:" + u;
  return u;
}
function b64decode(s) {
  var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  var str = String(s || "").replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+\/]/g, "");
  var out = "", bits = 0, val = 0;
  for (var i = 0; i < str.length; i++) {
    val = ((val << 6) | chars.indexOf(str.charAt(i))) & 0xFFFF;
    bits += 6;
    if (bits >= 8) { bits -= 8; out += String.fromCharCode((val >> bits) & 255); }
  }
  return out;
}
// value=<base64 de un JSON {"sub":..,"lat":..,"cast":..,"rc":..}>.<firma>
function decodeOptionsValue(u) {
  var m = /[?&]value=([^&]+)/.exec(u || "");
  if (!m) return null;
  var v = m[1];
  try { v = decodeURIComponent(v); } catch (_) { /* se usa tal cual */ }
  try { return JSON.parse(b64decode(v.split(".")[0])); } catch (_) { return null; }
}
function pageTitle(html) {
  var m = /<title[^>]*>([^<]*)<\/title>/i.exec(html || "");
  return m ? decodeEntities(m[1]).trim() : "";
}
// "Black Clover Temporada 2 ep. 5 Sub Espanol Online - AnimeD23" -> "Black Clover"
function cleanPageTitle(t) {
  return stripSeasonWords(String(t || "").replace(/\s+(sub|latino|castellano)\b.*$/i, "").replace(/\bep\.?\s*\d+.*$/i, ""));
}
async function probeSlug(slug) {
  var url = AD_BASE + "/capitulo/" + slug + "/";
  try {
    var r = await fetchPage(url, { "Referer": AD_BASE + "/" });
    var cont = findContainer(r.text);
    if (cont) return { url: url, slug: slug, html: r.text, container: cont, status: r.status };
    var opt = findOptions(r.text);
    if (opt) return { url: url, slug: slug, html: r.text, optionsUrl: opt, status: r.status };
    if (looksBlocked(r.text, r.status)) return { blocked: true, slug: slug, status: r.status };
    // v1.0.3: se conserva el HTML para poder volcarlo si la pagina existe pero no trae container.php
    return { url: url, slug: slug, status: r.status, noContainer: r.ok, html: r.ok ? r.text : "" };
  } catch (e) {
    return { slug: slug, error: shortErr(e) };
  }
}

// ---- Volcado de una pagina de episodio SIN container.php (v1.0.3) ----
// Muestra todo lo que pueda delatar donde esta el reproductor: iframes, atributos data-*, scripts y palabras clave.
function dumpEpisodePage(p, title) {
  var html = p.html || "";
  var out = "URL: " + p.url + "\nHTTP " + p.status + " | " + html.length + " car | titulo: " + title;

  // 1) iframes completos
  var ifr = [], m, reI = /<iframe\b[^>]*>/gi;
  while ((m = reI.exec(html)) && ifr.length < 12) ifr.push(m[0].replace(/\s+/g, " ").slice(0, 400));
  out += "\n\n--- IFRAMES (" + ifr.length + ") ---\n" + (ifr.join("\n") || "(ninguno en el HTML)");

  // 2) etiquetas con atributos que suelen llevar el enlace del reproductor
  var tags = [], reT = /<(?:button|a|li|div|span|option|video|source|embed|object)\b[^>]*\b(?:data-player[\w-]*|data-src|data-embed[\w-]*|data-url|data-video|data-iframe|data-link|data-server|data-lang|data-id|data-post|data-nume|data-type)\s*=[^>]*>/gi;
  while ((m = reT.exec(html)) && tags.length < 25) tags.push(m[0].replace(/\s+/g, " ").slice(0, 350));
  out += "\n\n--- ETIQUETAS CON data-* (" + tags.length + ") ---\n" + (tags.join("\n") || "(ninguna)");

  // 3) scripts externos e inline
  var src = [], inl = [], reS = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  while ((m = reS.exec(html))) {
    var sm = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(m[1]);
    if (sm) src.push(sm[1].replace(/^https?:\/\//, "").slice(0, 160));
    else if (m[2].trim().length > 20) inl.push(m[2]);
  }
  var own = src.filter(function (u) { return /animed23/i.test(u) && !/wp-includes|jquery|wp-emoji/i.test(u); });
  out += "\n\n--- SCRIPTS EXTERNOS (" + src.length + "; del sitio: " + own.length + ") ---\n" + own.join("\n");
  out += "\n\n--- SCRIPTS INLINE: " + inl.length + " (tamanos " + inl.map(function (x) { return x.length; }).join(",") + ") ---";

  // 4) palabras clave con su contexto (sin repetir zonas)
  var KEYS = /container\.php|embed|player|reproductor|okru|ok\.ru|archive\.org|mp4upload|streamwish|voe\.sx|filemoon|byse|abyss|peeplayer|admin-ajax|wp-json|\/api\/|data-player|iframe|video-url|videoUrl|servers?\b/ig;
  var hits = [], last = -1, km;
  KEYS.lastIndex = 0;
  while ((km = KEYS.exec(html)) && hits.length < 40) {
    if (km.index < last) continue;
    var a = Math.max(0, km.index - 100), b = Math.min(html.length, km.index + 260);
    hits.push(html.slice(a, b).replace(/\s+/g, " ").replace(/[A-Za-z0-9+\/=_%-]{80,}/g, function (t) { return "<" + t.length + " car>"; }));
    last = b;
  }
  out += "\n\n--- PALABRAS CLAVE (" + hits.length + ") ---\n" + hits.join("\n..\n");
  dump("pagina sin container.php: " + p.slug, out);
}

// Prueba una lista de slugs en paralelo y devuelve la primera pagina cuyo titulo coincide con la serie
async function probeAll(slugs, verifyTitles, label) {
  if (!slugs.length) return null;
  trace(label + " slugs: " + slugs.join(", "));
  var probes = await Promise.all(slugs.map(probeSlug));
  var n404 = 0, found = [];
  probes.forEach(function (p) {
    if (p.container) { found.push(p); trace("slug " + p.slug + ": HTTP " + p.status + ", iframe " + p.container.id); }
    else if (p.optionsUrl) { found.push(p); trace("slug " + p.slug + ": HTTP " + p.status + ", iframe options.php"); }
    else if (p.blocked) trace("slug " + p.slug + ": bloqueado (Cloudflare) HTTP " + p.status);
    else if (p.error) trace("slug " + p.slug + ": fallo " + p.error);
    else if (p.status === 404) n404++;
    else trace("slug " + p.slug + ": HTTP " + p.status + (p.noContainer ? " sin iframe container.php" : ""));
  });
  if (n404) trace(n404 + " slugs con HTTP 404");
  for (var i = 0; i < found.length; i++) {
    var t = pageTitle(found[i].html);
    var sim = bestSimilarity(cleanPageTitle(t), verifyTitles);
    trace("titulo pagina '" + t + "' similitud " + sim.toFixed(2));
    if (sim >= 0.6) return found[i];
  }
  if (found.length) trace("hay paginas pero el titulo no coincide con la serie; se descartan");
  // v1.0.3: paginas que existen pero no traen container.php -> volcar la primera cuyo titulo coincida
  if (DEBUG && !PAGE_DUMPED) {
    for (var j = 0; j < probes.length; j++) {
      var pp = probes[j];
      if (!pp.noContainer || !pp.html) continue;
      var tt = pageTitle(pp.html);
      var ss = bestSimilarity(cleanPageTitle(tt), verifyTitles);
      trace("pagina sin container.php: '" + tt + "' similitud " + ss.toFixed(2));
      if (ss >= 0.6) {
        PAGE_DUMPED = true;
        dumpEpisodePage(pp, tt);
        break;
      }
    }
  }
  return null;
}
// Respaldo: buscador del sitio (/?s=). Sus resultados enlazan a paginas de serie /anime/<slug>/
async function searchSeriesSlugs(queries, matchTitles) {
  var scored = {};
  for (var i = 0; i < queries.length; i++) {
    try {
      var r = await fetchPage(AD_BASE + "/?s=" + encodeURIComponent(queries[i]), { "Referer": AD_BASE + "/" });
      var re = /href=["'](?:https?:\/\/animed23\.com)?\/anime\/([a-z0-9][a-z0-9\-]*)\/?["']/gi, m, n = 0;
      while ((m = re.exec(r.text))) {
        n++;
        var sim = bestSimilarity(m[1].replace(/-/g, " "), matchTitles);
        if (sim >= 0.5 && (scored[m[1]] === undefined || sim > scored[m[1]])) scored[m[1]] = sim;
      }
      trace("busqueda /?s=" + queries[i] + ": HTTP " + r.status + ", " + n + " enlaces /anime/, " + Object.keys(scored).length + " series parecidas");
    } catch (e) {
      trace("busqueda /?s=" + queries[i] + " fallo: " + shortErr(e));
    }
    if (Object.keys(scored).length >= 3) break;
  }
  return Object.keys(scored).sort(function (a, b) { return scored[b] - scored[a]; }).slice(0, 3);
}
// Abre la pagina de la serie y busca el enlace /capitulo/<slug>-ep-N/
async function episodeFromSeries(seriesSlug, season, episode, baseSlugs) {
  try {
    var r = await fetchPage(AD_BASE + "/anime/" + seriesSlug + "/", { "Referer": AD_BASE + "/" });
    var re = /\/capitulo\/([a-z0-9][a-z0-9\-]*)\/?["'#?]/gi, m, links = [];
    while ((m = re.exec(r.text))) { if (links.indexOf(m[1]) === -1) links.push(m[1]); }
    trace("serie " + seriesSlug + ": HTTP " + r.status + ", " + links.length + " enlaces /capitulo/");
    // v1.0.3: muestra de los enlaces para ver como se llaman los episodios de esta serie
    if (links.length) trace("muestra /capitulo/: " + links.slice(0, 4).join(" , ") + (links.length > 4 ? " ... " + links[links.length - 1] : ""));
    var isBase = baseSlugs.indexOf(seriesSlug) !== -1;
    for (var i = 0; i < links.length; i++) {
      var sm = /^(.*?)(?:-temporada-(\d+))?-ep-(\d+)$/.exec(links[i]);
      if (!sm || parseInt(sm[3], 10) !== episode) continue;
      var sSeason = sm[2] ? parseInt(sm[2], 10) : null;
      if (season > 1) { if (sSeason === season || (sSeason === null && !isBase)) return links[i]; }
      else if (sSeason === null || sSeason === 1) return links[i];
    }
  } catch (e) {
    trace("serie " + seriesSlug + " fallo: " + shortErr(e));
  }
  return null;
}
async function findEpisodePage(info, season, episode) {
  var tried = [];
  function fresh(list) { var out = list.filter(function (x) { return tried.indexOf(x) === -1; }); tried = tried.concat(out); return out; }
  var verifyTitles = info.titles.slice();

  // 1) Slugs que salen de TMDB (rapido: sin consultar nada mas)
  var page = await probeAll(fresh(episodeSlugs(info, season, episode, null)), verifyTitles, "TMDB");
  if (page) return page;

  // 2) Titulo romaji / del arco desde AniList
  var al = await getAniList(info);
  trace("AniList: " + al.related.length + " nombres relacionados; arco: " + (al.arc.join(" | ") || "ninguno"));
  verifyTitles = verifyTitles.concat(al.arc);
  var arcSlugs = fresh(episodeSlugs(info, season, episode, al.arc));
  if (season === 1 && !al.arc.length) {
    // Sin entrada por fecha: se prueban los nombres parecidos (la verificacion de titulo evita la serie equivocada)
    al.related.slice(0, 4).forEach(function (n) {
      var sl = slugify(n) + "-ep-" + episode;
      if (tried.indexOf(sl) === -1) { tried.push(sl); arcSlugs.push(sl); }
    });
  }
  page = await probeAll(arcSlugs, verifyTitles, "AniList");
  if (page) return page;

  // 3) Buscador del sitio -> pagina de la serie -> enlace del episodio
  var queries = info.titles.slice(0, 2).concat(al.arc.slice(0, 2));
  var series = await searchSeriesSlugs(queries, verifyTitles.concat(al.related.slice(0, 6)));
  var bases = baseSlugsOf(info);
  for (var i = 0; i < series.length; i++) {
    var slug = await episodeFromSeries(series[i], season, episode, bases);
    if (!slug || tried.indexOf(slug) !== -1) continue;
    var p = await probeSlug(slug);
    if (p.container || p.optionsUrl) { trace("episodio hallado por la serie " + series[i] + ": " + slug); return p; }
    trace("slug " + slug + " (de la serie " + series[i] + "): HTTP " + p.status + " sin iframe");
  }
  return null;
}

// ---------- reproductor (container.php) ----------
function attr(tag, name) {
  var m = new RegExp("\\b" + name + "\\s*=\\s*(\"([^\"]*)\"|'([^']*)')", "i").exec(tag);
  return m ? decodeEntities(m[2] !== undefined ? m[2] : m[3]) : "";
}
// Botones: <button class="embed-tab" data-player-url="..." data-player-kind="iframe|video" data-player-label="Byse" title="Byse · 1080p">
function parseServers(html) {
  var out = [], seen = {};
  var re = /<button\b[^>]*\bdata-player-url\s*=[^>]*>/gi, m;
  while ((m = re.exec(html || ""))) {
    var tag = m[0];
    var url = attr(tag, "data-player-url");
    if (!url || seen[url]) continue;
    seen[url] = true;
    var q = /(\d{3,4})p/i.exec(attr(tag, "title"));
    out.push({
      url: url,
      kind: attr(tag, "data-player-kind") || "iframe",
      label: attr(tag, "data-player-label") || hostOf(url),
      quality: q ? q[1] + "p" : ""
    });
  }
  return out;
}
function parseLangs(html) {
  var out = [], m;
  var re = /(?:&amp;|&|\?)lang=([A-Za-z_-]+)/g;
  while ((m = re.exec(html || ""))) {
    var l = m[1].toUpperCase();
    if (out.indexOf(l) === -1) out.push(l);
  }
  return out;
}
async function fetchLangPage(cont, lang, episodeUrl) {
  var openUrl = "https://" + cont.host + "/container.php?id=" + cont.id + "&open=1";
  var url = openUrl + "&lang=" + lang;
  var variants = [
    { tag: "A", headers: { "Referer": openUrl } },
    { tag: "B", headers: { "Referer": episodeUrl } },
    { tag: "C", headers: { "Referer": AD_BASE + "/" } },
    { tag: "D", headers: {} }
  ];
  var notes = [];
  for (var i = 0; i < variants.length; i++) {
    try {
      var r = await fetchPage(url, variants[i].headers);
      var servers = parseServers(r.text);
      if (servers.length) {
        if (i > 0) trace(lang + ": servidores leidos con variante " + variants[i].tag);
        return servers;
      }
      notes.push(variants[i].tag + " HTTP " + r.status + (looksBlocked(r.text, r.status) ? " bloqueado" : " sin botones"));
      if (i === variants.length - 1 || DEBUG) dump("container lang=" + lang + " (variante " + variants[i].tag + ", HTTP " + r.status + ")", r.text);
    } catch (e) {
      notes.push(variants[i].tag + " " + shortErr(e));
    }
  }
  trace(lang + ": sin servidores (" + notes.join("; ") + ")");
  return [];
}

// ---------- extractores ----------
function sourceKey(s) {
  var h = hostOf(s.url), l = norm(s.label);
  if (s.kind === "video" || /(^|\.)archive\.org$/.test(h)) return "Omega";
  if (/peeplayer/.test(h) || l === "epsilon") return "Epsilon";
  if (/abyss/.test(h) || l === "abyss") return "Abyss";
  if (/(^|\.)ok\.ru$/.test(h) || l === "ok" || l === "okru") return "Okru";
  if (/byse|filemoon/.test(h) || l === "byse") return "Byse";
  if (/(^|\.)mega\.nz$/.test(h) || l === "mega") return "MEGA";
  return "";
}
function playHeaders(ctx) {
  return { "Referer": ctx.embedOrigin + "/", "Origin": ctx.embedOrigin, "User-Agent": UA };
}
// Enlace directo (mp4 o m3u8): comprueba que responda y lo entrega tal cual
async function extractDirect(srv, ctx) {
  var url = srv.url;
  var headers = playHeaders(ctx);
  var isHls = /\.m3u8(\?|$)/i.test(url);
  if (isHls) {
    var r = await fetchPage(url, headers);
    if (!r.ok) throw new Error("m3u8 HTTP " + r.status);
    if (r.text.indexOf("#EXTM3U") !== 0) throw new Error("m3u8 no empieza con #EXTM3U");
    return { url: url, headers: headers, type: "hls", tag: "HLS" };
  }
  try {
    var resp = await fetch(url, { headers: { "User-Agent": UA, "Range": "bytes=0-1" } });
    if (!resp.ok && resp.status !== 206) throw new Error("mp4 HTTP " + resp.status);
    var ct = "";
    try { ct = (resp.headers && resp.headers.get && resp.headers.get("content-type")) || ""; } catch (_) { /* no legible */ }
    if (/text\/html/i.test(ct)) throw new Error("mp4: el servidor devolvio una pagina HTML");
  } catch (e) {
    if (/^mp4/.test(shortErr(e))) throw e;
    trace(srv.label + ": no se pudo verificar (" + shortErr(e) + "); se ofrece igual");
  }
  return { url: url, headers: headers, tag: "MP4" };
}
// ---- Okru (portado de animejara.js; sin probar) ----
function okDecode(t) {
  return String(t || "").replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
var OK_QUALITY = ["mobile", "lowest", "low", "sd", "hd", "full", "quad", "ultra"];
function parseOkru(html) {
  var m = /data-options=(["'])([\s\S]*?)\1/.exec(html);
  var meta = null;
  if (m) {
    try {
      var opts = JSON.parse(okDecode(m[2]));
      var raw = opts && opts.flashvars && opts.flashvars.metadata;
      meta = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch (e) { /* se prueba con regex */ }
  }
  var out = [];
  if (meta) {
    var hls = meta.hlsManifestUrl || meta.hlsMasterPlaylistUrl || meta.ondemandHls;
    if (hls) out.push({ url: hls, type: "hls", tag: "HLS" });
    var vids = (meta.videos || []).filter(function (v) { return v && v.url; });
    vids.sort(function (a, b) { return OK_QUALITY.indexOf(b.name) - OK_QUALITY.indexOf(a.name); });
    if (vids[0]) out.push({ url: vids[0].url, tag: "MP4 " + vids[0].name });
    return out;
  }
  var txt = okDecode(html).replace(/\\u0026/g, "&").replace(/\\\//g, "/");
  var hm = /"hlsManifestUrl"\s*:\s*"([^"]+)"/.exec(txt) || /"ondemandHls"\s*:\s*"([^"]+)"/.exec(txt);
  if (hm) out.push({ url: hm[1], type: "hls", tag: "HLS" });
  return out;
}
async function extractOkru(srv, ctx) {
  var url = srv.url.indexOf("//") === 0 ? "https:" + srv.url : srv.url;
  var r = await fetchPage(url, { "Referer": ctx.embedOrigin + "/" });
  if (!r.ok) throw new Error("okru HTTP " + r.status);
  var list = parseOkru(r.text);
  if (!list.length) {
    trace("okru: sin video; " + r.text.length + " caracteres, data-options=" + (/data-options=/.test(r.text) ? "si" : "no"));
    throw new Error("okru: no se encontro el video");
  }
  return list.map(function (v) {
    var o = { url: v.url, tag: v.tag, headers: { "Referer": "https://ok.ru/", "User-Agent": UA } };
    if (v.type) o.type = v.type;
    return o;
  });
}

// ---- Volcado compacto de un servidor sin extractor (DEBUG) ----
// Texto alrededor de las palabras clave que delatan de donde sale el enlace del video
var DUMP_KEYS = /m3u8|\.mp4|["']?sources?["']?\s*[:=]|["']file["']\s*:|atob\(|eval\(|JSON\.parse|decrypt|crypto\.subtle|\bAES\b|fetch\(|\/api\//ig;
function compactDump(html, status) {
  var src = [], inl = [], m;
  var reS = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  while ((m = reS.exec(html))) {
    var sm = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(m[1]);
    if (sm) src.push(sm[1]); else if (m[2].trim().length > 20) inl.push(m[2]);
  }
  var out = "HTTP " + status + " | " + html.length + " car | bloqueado: " + (looksBlocked(html, status) ? "si" : "no") +
    "\ntitulo: " + pageTitle(html) +
    "\nscripts externos (" + src.length + "): " + src.map(function (u) { return u.replace(/^https?:\/\//, ""); }).join(" , ") +
    "\nscripts inline: " + inl.length + " (tamanos " + inl.map(function (x) { return x.length; }).join(",") + ")";
  // Cadenas largas (posibles datos cifrados o codificados)
  var longs = [], lm, reL = /["'`]([A-Za-z0-9+\/=_\-%\\.:{}",\[\]]{200,})["'`]/g;
  var body = inl.join("\n");
  while ((lm = reL.exec(body)) && longs.length < 5) longs.push(lm[1].length + " car: " + lm[1].slice(0, 100));
  out += "\ncadenas largas en scripts inline (" + longs.length + "): " + longs.join(" || ");
  // Contexto de palabras clave (HTML + scripts), sin repetir zonas
  var hits = [], last = -1, km;
  var all = html;
  DUMP_KEYS.lastIndex = 0;
  while ((km = DUMP_KEYS.exec(all)) && hits.length < 14) {
    if (km.index < last) continue;
    var a = Math.max(0, km.index - 120), b = Math.min(all.length, km.index + 200);
    hits.push(all.slice(a, b).replace(/\s+/g, " ").replace(/[A-Za-z0-9+\/=_%-]{60,}/g, function (t) { return "<" + t.length + " car>"; }));
    last = b;
  }
  out += "\n--- palabras clave (" + hits.length + ") ---\n" + hits.join("\n..\n");
  return out;
}
async function dumpEmbed(srv, ctx) {
  var r = await fetchPage(srv.url, browserHeaders(ctx.embedOrigin + "/"));
  var html = r.text || "";
  dump(srv.label + " " + srv.url, compactDump(html, r.status));
  trace(srv.label + ": volcado HTTP " + r.status + ", " + html.length + " caracteres");
}
var EXTRACTORS = { Omega: extractDirect, Okru: extractOkru };

// ---------- camino options.php (v1.0.4) ----------
// Igual que parseServers pero acepta cualquier etiqueta con data-player-url (no solo <button>)
function parseServersLoose(html) {
  var out = [], seen = {};
  var re = /<[a-z][a-z0-9]*\b[^>]*\bdata-player-url\s*=[^>]*>/gi, m;
  while ((m = re.exec(html || ""))) {
    var tag = m[0];
    var url = attr(tag, "data-player-url");
    if (!url || seen[url]) continue;
    seen[url] = true;
    var q = /(\d{3,4})p/i.exec(attr(tag, "title"));
    out.push({
      url: url,
      kind: attr(tag, "data-player-kind") || "iframe",
      label: attr(tag, "data-player-label") || hostOf(url),
      quality: q ? q[1] + "p" : ""
    });
  }
  return out;
}
var VALUE_LANGS = [["lat", "LAT"], ["cast", "CAST"], ["sub", "SUB"]];
async function coreOptions(page) {
  var optUrl = page.optionsUrl;
  var ctx = { embedOrigin: originOf(optUrl) };
  trace("options.php: " + optUrl.replace(/value=[^&]+/, "value=<...>").slice(0, 200));

  // El value trae un JSON con los idiomas disponibles
  var val = decodeOptionsValue(optUrl);
  var langsV = [];
  if (val) {
    VALUE_LANGS.forEach(function (p) { if (val[p[0]]) langsV.push(p[1]); });
    trace("options value: campos " + Object.keys(val).join(",") + "; idiomas con dato: " + (langsV.join(",") || "ninguno"));
  } else {
    trace("options value: no se pudo leer el JSON");
  }

  // Un iframe con referrerpolicy strict-when-cross-origin manda solo el origen del sitio: se prueba primero ese Referer
  var variants = [
    { tag: "A", headers: { "Referer": AD_BASE + "/" } },
    { tag: "B", headers: { "Referer": page.url } },
    { tag: "C", headers: {} }
  ];
  var html = "", status = 0, servers = [], notes = [];
  for (var i = 0; i < variants.length; i++) {
    try {
      var r = await fetchPage(optUrl, variants[i].headers);
      var sv = parseServersLoose(r.text);
      notes.push(variants[i].tag + " HTTP " + r.status + (sv.length ? " " + sv.length + " botones" : (looksBlocked(r.text, r.status) ? " bloqueado" : " sin botones")));
      if (!html || r.text.length > html.length) { html = r.text; status = r.status; }
      if (sv.length) { servers = sv; if (i > 0) trace("options: servidores leidos con variante " + variants[i].tag); break; }
    } catch (e) {
      notes.push(variants[i].tag + " " + shortErr(e));
    }
  }

  var perLang = [];
  var langsP = parseLangs(html);
  if (servers.length) {
    // Sin pantalla de idiomas en la pagina: se usa el idioma que marca el value
    perLang.push({ lang: langsV.length === 1 ? langsV[0] : (langsV[0] || "SUB"), servers: servers });
  } else if (langsP.length) {
    trace("options: sin botones, pero hay enlaces lang=" + langsP.join(","));
    perLang = await Promise.all(langsP.map(function (lang) {
      var u = optUrl + "&lang=" + lang;
      return fetchPage(u, { "Referer": AD_BASE + "/" }).then(function (r) {
        return { lang: lang, servers: parseServersLoose(r.text) };
      }, function (e) {
        trace("options lang=" + lang + " fallo: " + shortErr(e));
        return { lang: lang, servers: [] };
      });
    }));
  }
  var total = 0;
  perLang.forEach(function (pl) { total += pl.servers.length; });
  if (!total) {
    trace("options: sin servidores (" + notes.join("; ") + ")");
    dump("options.php (HTTP " + status + ", " + html.length + " car)", html);
    return [];
  }
  return await finishStreams(perLang, ctx);
}

// ---------- punto de entrada ----------
async function core(tmdbId, type, season, episode) {
  if (type !== "tv") {
    trace("tipo '" + type + "': peliculas no implementadas en v" + VERSION + " (falta ver una pagina de pelicula del sitio)");
    return [];
  }
  var s = parseInt(season, 10) || 1;
  var e = parseInt(episode, 10) || 1;
  var info = await getTMDBInfo(tmdbId, s);
  if (!info || !info.titles.length) { trace("TMDB: sin datos para " + tmdbId); return []; }
  trace("TMDB " + tmdbId + " T" + s + "E" + e + ": " + info.titles.join(" | ") + " (temporada: " + (info.seasonName || "?") + ", estreno " + (info.airDate || "?") + ")");

  var page = await findEpisodePage(info, s, e);
  if (!page) { trace("no se encontro la pagina del episodio"); return []; }
  if (page.optionsUrl) {
    trace("pagina: " + page.url + " -> iframe options.php");
    return await coreOptions(page);
  }
  trace("pagina: " + page.url + " -> iframe " + page.container.host + " id " + page.container.id);
  var cont = page.container;
  var ctx = { embedOrigin: "https://" + cont.host };

  // Pantalla de idiomas
  var langs = [];
  try {
    var openUrl = "https://" + cont.host + "/container.php?id=" + cont.id + "&open=1";
    var op = await fetchPage(openUrl, { "Referer": page.url });
    langs = parseLangs(op.text);
    trace("open=1: HTTP " + op.status + ", idiomas: " + (langs.join(",") || "ninguno") + (looksBlocked(op.text, op.status) ? " (bloqueado)" : ""));
  } catch (err) {
    trace("open=1 fallo: " + shortErr(err));
  }
  if (!langs.length) { langs = LANG_FALLBACK.slice(); trace("idiomas por defecto: " + langs.join(",")); }

  var perLang = await Promise.all(langs.map(function (lang) {
    return fetchLangPage(cont, lang, page.url).then(function (servers) { return { lang: lang, servers: servers }; });
  }));

  return await finishStreams(perLang, ctx);
}

// Convierte los servidores leidos (por idioma) en streams: extractores en paralelo, sin duplicados y ordenados.
// Lo usan los dos caminos (container.php y options.php).
async function finishStreams(perLang, ctx) {
  var jobs = [];
  perLang.forEach(function (pl) {
    trace(pl.lang + ": " + pl.servers.length + " servidores (" + pl.servers.map(function (x) { return x.label; }).join(", ") + ")");
    pl.servers.forEach(function (srv) {
      var key = sourceKey(srv);
      if (!key) { trace(pl.lang + " " + srv.label + ": servidor desconocido (" + srv.url.slice(0, 120) + ")"); return; }
      if (!ENABLED_SOURCES[key]) {
        if (DEBUG && DUMP_SOURCES[key] && !(key === "Epsilon" && /peeplayer/.test(hostOf(srv.url))) && !DUMP_SOURCES["_done_" + key]) {
          DUMP_SOURCES["_done_" + key] = true; // un solo volcado por servidor
          jobs.push(withTimeout(dumpEmbed(srv, ctx), 15000, key).then(function () { return null; }, function (err) {
            trace(key + ": volcado fallo " + shortErr(err));
            return null;
          }));
        }
        return;
      }
      var fn = EXTRACTORS[key];
      if (!fn) return;
      jobs.push(withTimeout(Promise.resolve().then(function () { return fn(srv, ctx); }), 15000, srv.label).then(function (res) {
        var list = Array.isArray(res) ? res : [res];
        var q = srv.quality || "HD";
        return list.map(function (v) {
          var o = {
            name: "AnimeD23",
            title: "",
            url: v.url,
            quality: "\uD83D\uDCFA " + srv.label + " (" + v.tag + ")\n" + q + " | WEB-DL\n" + (LANG_NAMES[pl.lang] || pl.lang),
            headers: v.headers,
            type: v.type,
            _lang: pl.lang,
            _rank: SERVER_ORDER.indexOf(key)
          };
          return o;
        });
      }, function (err) {
        trace(srv.label + " (" + pl.lang + ") fallo: " + shortErr(err));
        return null;
      }));
    });
  });
  var done = await Promise.all(jobs);
  var results = [];
  done.filter(Boolean).forEach(function (arr) { results = results.concat(arr); });

  // Quita duplicados por URL y ordena: idioma LAT -> CAST -> SUB, luego servidor
  var seen = {};
  results = results.filter(function (r) { if (seen[r.url]) return false; seen[r.url] = true; return true; });
  function langRank(l) { var i = LANG_ORDER.indexOf(l); return i === -1 ? 99 : i; }
  results.sort(function (a, b) {
    if (a._lang !== b._lang) return langRank(a._lang) - langRank(b._lang);
    return a._rank - b._rank;
  });
  results.forEach(function (r) {
    delete r._lang; delete r._rank;
    if (!r.type) delete r.type;
  });
  return results;
}

async function getStreams(tmdbId, type, season, episode) {
  TRACE = [];
  DUMPS = [];
  PAGE_DUMPED = false;
  DUMP_SOURCES._done_Epsilon = false;
  DUMP_SOURCES._done_Abyss = false;
  var results = [];
  try {
    results = await core(tmdbId, type, season, episode);
  } catch (err) {
    trace("error: " + shortErr(err));
    console.error("[AnimeD23] Error: " + shortErr(err));
  }
  console.log("[AnimeD23] " + results.length + " streams");
  var failed = TRACE.some(function (t) { return /fallo|sin servidores|no se encontro|bloqueado|error|desconocido/.test(t); });
  if (results.length === 0 || (DEBUG && (failed || DUMPS.length))) results = results.concat(diagnostic());
  return results;
}

// Entradas informativas (no reproducibles) para ver en la lista de Nuvio por que no salio nada
function diagnostic() {
  if (!DEBUG) return [];
  var out = [{
    name: "AnimeD23",
    title: "",
    url: AD_BASE + "/",
    quality: "\uD83D\uDEE0 DIAGNOSTICO (no reproducir)\nv" + VERSION + "\n" + TRACE.join("\n"),
    headers: {}
  }];
  DUMPS.forEach(function (d) {
    out.push({
      name: "AnimeD23",
      title: "",
      url: AD_BASE + "/",
      quality: "\uD83D\uDEE0 VOLCADO (no reproducir)\n" + d.title + "\n" + d.text.slice(0, DUMP_MAX),
      headers: {}
    });
  });
  return out;
}

exports.getStreams = getStreams;
if (typeof globalThis !== "undefined") globalThis.getStreams = getStreams;
