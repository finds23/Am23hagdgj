/**
 * AnimeD23 (animed23.com) - plugin para Nuvio
 * Flujo: TMDB -> pagina del episodio /capitulo/<slug>-temporada-N-ep-M/
 *        -> iframe https://animed23.online/container.php?id=<ID>
 *        -> container.php?id=<ID>&open=1 (pantalla de idiomas) -> &lang=LAT|SUB|... (botones data-player-url)
 *        -> extractor por servidor.
 * Servidores vistos en el idioma LAT: Omega (mp4 en archive.org), Byse, MEGA, Epsilon, Abyss.
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
  Omega: true,     // mp4 directo en archive.org; sin probar que reproduce
  Epsilon: false,  // peeplayer.com: sin extractor. Con DEBUG se vuelca su HTML para investigarlo
  Abyss: false,    // abyssplayer.com: sin extractor. Con DEBUG se vuelca su HTML para ver si responde con cabeceras de navegador
  Byse: false,     // bysesukior.com: descartado (antibot)
  MEGA: false      // mega.nz: cifrado en el cliente, no sirve para un plugin
};
// Servidores sin extractor cuyo HTML se vuelca en pantalla cuando DEBUG esta activo
var DUMP_SOURCES = { Epsilon: true, Abyss: true };

var VERSION = "1.0.0"; // se muestra en el diagnostico para saber que copia del plugin esta cargando Nuvio
var DEBUG = true; // TEMPORAL: muestra el diagnostico. Poner en false cuando todo funcione.
var DUMP_MAX = 30000; // maximo de caracteres por volcado
var TRACE = [];
var DUMPS = [];
function trace(msg) { TRACE.push(String(msg).replace(/\s+/g, " ").slice(0, 300)); }
function dump(title, text) { DUMPS.push({ title: String(title), text: String(text || "") }); }

var SERVER_ORDER = ["Omega", "Epsilon", "Abyss", "Byse", "MEGA"];
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
function looksBlocked(html) {
  return /just a moment|cf-chl|challenge-platform|attention required|enable javascript and cookies/i.test(html || "");
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
var ASIAN_COUNTRIES = ["JP", "CN", "KR", "TW", "HK"];
async function getTMDBInfo(tmdbId) {
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
  return { titles: latin, year: year };
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

// ---------- pagina del episodio ----------
// Candidatos de slug. Forma vista: black-clover-temporada-2-ep-5. La de la temporada 1 es una suposicion.
function episodeSlugs(titles, season, episode) {
  var bases = [];
  titles.forEach(function (t) {
    var b = slugify(stripSeasonWords(t));
    if (b && bases.indexOf(b) === -1) bases.push(b);
  });
  var out = [];
  function add(s) { if (out.indexOf(s) === -1) out.push(s); }
  bases.forEach(function (b) {
    if (season > 1) {
      add(b + "-temporada-" + season + "-ep-" + episode);
      add(b + "-" + season + "-ep-" + episode);
      add(b + "-season-" + season + "-ep-" + episode);
    } else {
      add(b + "-ep-" + episode);
      add(b + "-temporada-1-ep-" + episode);
    }
  });
  return out;
}
// Busca el iframe del reproductor: .../container.php?id=<ID>
function findContainer(html) {
  var m = /(?:https?:)?(?:\\?\/){2}([a-z0-9.-]+)(?:\\?\/)container\.php\?id=([A-Za-z0-9_-]+)/i.exec(html || "");
  return m ? { host: m[1].toLowerCase(), id: m[2] } : null;
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
    if (looksBlocked(r.text)) return { blocked: true, slug: slug, status: r.status };
    return { slug: slug, status: r.status, noContainer: r.ok };
  } catch (e) {
    return { slug: slug, error: shortErr(e) };
  }
}
// Plan B: buscador del sitio (/?s=). Sin probar: no se sabe como devuelve los resultados.
async function searchEpisode(titles, season, episode) {
  var found = [];
  for (var i = 0; i < Math.min(titles.length, 2); i++) {
    var url = AD_BASE + "/?s=" + encodeURIComponent(titles[i]);
    try {
      var r = await fetchPage(url, { "Referer": AD_BASE + "/" });
      var re = /href=["'](https?:\/\/animed23\.com\/capitulo\/([^"'\/?#]+)\/?)["']/gi, m;
      var n = 0;
      while ((m = re.exec(r.text))) {
        n++;
        var sm = /^(.*?)(?:-temporada-(\d+))?-ep-(\d+)$/.exec(m[2]);
        if (!sm) continue;
        var sSeason = sm[2] ? parseInt(sm[2], 10) : 1;
        if (parseInt(sm[3], 10) !== episode || sSeason !== season) continue;
        var sim = bestSimilarity(sm[1].replace(/-/g, " "), titles);
        if (sim >= 0.8) found.push({ url: m[1], slug: m[2], sim: sim });
      }
      trace("busqueda /?s=" + titles[i] + ": HTTP " + r.status + ", " + n + " enlaces /capitulo/, " + found.length + " candidatos");
    } catch (e) {
      trace("busqueda /?s=" + titles[i] + " fallo: " + shortErr(e));
    }
  }
  found.sort(function (a, b) { return b.sim - a.sim; });
  return found;
}
async function findEpisodePage(info, season, episode) {
  var slugs = episodeSlugs(info.titles, season, episode);
  trace("slugs probables: " + slugs.join(", "));
  var probes = await Promise.all(slugs.map(probeSlug));
  var withContainer = probes.filter(function (p) { return p.container; });
  probes.forEach(function (p) {
    if (p.container) trace("slug " + p.slug + ": HTTP " + p.status + ", iframe " + p.container.id);
    else if (p.blocked) trace("slug " + p.slug + ": bloqueado (Cloudflare) HTTP " + p.status);
    else if (p.error) trace("slug " + p.slug + ": fallo " + p.error);
    else trace("slug " + p.slug + ": HTTP " + p.status + (p.noContainer ? " sin iframe container.php" : ""));
  });
  // Verifica con el titulo de la pagina que sea la serie correcta
  for (var i = 0; i < withContainer.length; i++) {
    var t = pageTitle(withContainer[i].html);
    var sim = bestSimilarity(cleanPageTitle(t), info.titles);
    trace("titulo pagina '" + t + "' similitud " + sim.toFixed(2));
    if (sim >= 0.6) return withContainer[i];
  }
  if (withContainer.length) {
    trace("ninguna pagina coincide con el titulo; se usa la primera sin verificar");
    return withContainer[0];
  }
  var found = await searchEpisode(info.titles, season, episode);
  for (var j = 0; j < found.length; j++) {
    var p = await probeSlug(found[j].slug);
    if (p.container) { trace("episodio hallado por busqueda: " + p.slug); return p; }
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
      notes.push(variants[i].tag + " HTTP " + r.status + (looksBlocked(r.text) ? " bloqueado" : " sin botones"));
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
// Servidor sin extractor: solo vuelca su HTML en pantalla (DEBUG)
async function dumpEmbed(srv, ctx) {
  var r = await fetchPage(srv.url, browserHeaders(ctx.embedOrigin + "/"));
  var html = r.text || "";
  var src = [], inl = [], m;
  var reS = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  while ((m = reS.exec(html))) {
    var sm = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(m[1]);
    if (sm) src.push(sm[1]); else if (m[2].trim().length > 20) inl.push(m[2]);
  }
  var head = "HTTP " + r.status + " | " + html.length + " caracteres | bloqueado: " + (looksBlocked(html) ? "si" : "no") +
    "\ntitulo: " + pageTitle(html) +
    "\nscripts externos: " + src.join(" , ") +
    "\n--- scripts inline ---\n" + inl.join("\n/*-----*/\n") +
    "\n--- inicio del HTML ---\n" + html.slice(0, 4000);
  dump(srv.label + " " + srv.url, head);
  trace(srv.label + ": volcado HTTP " + r.status + ", " + html.length + " caracteres");
}
var EXTRACTORS = { Omega: extractDirect };

// ---------- punto de entrada ----------
async function core(tmdbId, type, season, episode) {
  if (type !== "tv") {
    trace("tipo '" + type + "': peliculas no implementadas en v" + VERSION + " (falta ver una pagina de pelicula del sitio)");
    return [];
  }
  var s = parseInt(season, 10) || 1;
  var e = parseInt(episode, 10) || 1;
  var info = await getTMDBInfo(tmdbId);
  if (!info || !info.titles.length) { trace("TMDB: sin datos para " + tmdbId); return []; }
  trace("TMDB " + tmdbId + " T" + s + "E" + e + ": " + info.titles.join(" | "));

  var page = await findEpisodePage(info, s, e);
  if (!page) { trace("no se encontro la pagina del episodio"); return []; }
  trace("pagina: " + page.url + " -> iframe " + page.container.host + " id " + page.container.id);
  var cont = page.container;
  var ctx = { embedOrigin: "https://" + cont.host };

  // Pantalla de idiomas
  var langs = [];
  try {
    var openUrl = "https://" + cont.host + "/container.php?id=" + cont.id + "&open=1";
    var op = await fetchPage(openUrl, { "Referer": page.url });
    langs = parseLangs(op.text);
    trace("open=1: HTTP " + op.status + ", idiomas: " + (langs.join(",") || "ninguno") + (looksBlocked(op.text) ? " (bloqueado)" : ""));
    if (DEBUG) dump("container open=1 (HTTP " + op.status + ")", op.text);
  } catch (err) {
    trace("open=1 fallo: " + shortErr(err));
  }
  if (!langs.length) { langs = LANG_FALLBACK.slice(); trace("idiomas por defecto: " + langs.join(",")); }

  var perLang = await Promise.all(langs.map(function (lang) {
    return fetchLangPage(cont, lang, page.url).then(function (servers) { return { lang: lang, servers: servers }; });
  }));

  var jobs = [];
  perLang.forEach(function (pl) {
    trace(pl.lang + ": " + pl.servers.length + " servidores (" + pl.servers.map(function (x) { return x.label; }).join(", ") + ")");
    pl.servers.forEach(function (srv) {
      var key = sourceKey(srv);
      if (!key) { trace(pl.lang + " " + srv.label + ": servidor desconocido (" + hostOf(srv.url) + ")"); return; }
      if (!ENABLED_SOURCES[key]) {
        if (DEBUG && DUMP_SOURCES[key] && !DUMP_SOURCES["_done_" + key]) {
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
      jobs.push(withTimeout(fn(srv, ctx), 15000, srv.label).then(function (v) {
        var q = srv.quality || "HD";
        return {
          name: "AnimeD23",
          title: "",
          url: v.url,
          quality: "\uD83D\uDCFA " + srv.label + " (" + v.tag + ")\n" + q + " | WEB-DL\n" + (LANG_NAMES[pl.lang] || pl.lang),
          headers: v.headers,
          type: v.type,
          _lang: pl.lang,
          _rank: SERVER_ORDER.indexOf(key)
        };
      }, function (err) {
        trace(srv.label + " (" + pl.lang + ") fallo: " + shortErr(err));
        return null;
      }));
    });
  });
  var done = await Promise.all(jobs);
  var results = done.filter(Boolean);

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
  var failed = TRACE.some(function (t) { return /fallo|sin servidores|no se encontro|bloqueado|error/.test(t); });
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
