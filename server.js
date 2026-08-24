const express = require('express');
const cheerio = require('cheerio');
const fs      = require('fs');
const path    = require('path');
const { STORES } = require('./assets/stores.js');

const app        = express();
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');
const PORT       = process.env.PORT || 3000;
// CACHE_DIR lets the cache live on a persistent volume (e.g. a Railway volume)
// so the "product of the day" survives restarts. Defaults to the app dir.
const CACHE_DIR  = process.env.CACHE_DIR || __dirname;
const CACHE_FILE = path.join(CACHE_DIR, '.product-cache.json');
const ANALYTICS_FILE = path.join(CACHE_DIR, 'analytics.jsonl');

// ── Markets registry ─────────────────────────────────────────────────────────
// Add a new market by adding one entry. Fields:
//   baseUrl           : root of the Aldi site
//   siteLanguages     : languages the site offers products in
//   defaultScrapeLang : language used when the requested lang isn't supported
//   acceptLanguage    : Accept-Language header per scrapeLang
//   poolStrategy      : key in POOL_STRATEGIES (which pool builder to use)
//   productStrategy   : key in PRODUCT_STRATEGIES (which scraper to use)
//   sitemapPath       : optional, used by sitemap-based strategies; {lang} placeholder supported
//   productPathFilter : optional, substring filter for product URLs; {lang} placeholder supported
const MARKETS = {
  'be': {
    id: 'be',
    baseUrl: 'https://www.aldi.be',
    siteLanguages: ['nl', 'fr'],
    defaultScrapeLang: 'nl',
    acceptLanguage: {
      nl: 'nl-BE,nl;q=0.9',
      fr: 'fr-BE,fr;q=0.9',
    },
    poolStrategy: 'sitemap',
    productStrategy: 'nord',
    // aldi.be runs on the Aldi-Nord platform. The nl products sitemap lives at
    // the site root; other languages are served under a /{lang} prefix.
    sitemapPath: '{langPrefix}/sitemaps/.aldi-nord-sitemap-products.xml',
    productPathFilter: '/product/',
    // Cross-lang: the same product ID ends every URL, only the slug differs:
    // /product/popcorn-9870.html ↔ /fr/product/pop-corn-9870.html
    crossLangIdRegex: /-(\d+)\.html$/,
  },
  'de-nord': {
    id: 'de-nord',
    baseUrl: 'https://www.aldi-nord.de',
    siteLanguages: ['de'],
    defaultScrapeLang: 'de',
    acceptLanguage: { de: 'de-DE,de;q=0.9' },
    poolStrategy: 'sitemap',
    productStrategy: 'nord',
    sitemapPath: '/sitemaps/.aldi-nord-sitemap-products.xml',
    productPathFilter: '/produkt/',
  },
  'de-sued': {
    id: 'de-sued',
    baseUrl: 'https://www.aldi-sued.de',
    siteLanguages: ['de'],
    defaultScrapeLang: 'de',
    acceptLanguage: { de: 'de-DE,de;q=0.9' },
    poolStrategy: 'sued-brands',
    productStrategy: 'sued',
    sitemapPath: '/sitemap.xml',
    productPathFilter: '/produkt/',
  },
  'ah-be': {
    id: 'ah-be',
    baseUrl: 'https://www.ah.be',
    siteLanguages: ['nl'],
    defaultScrapeLang: 'nl',
    acceptLanguage: { nl: 'nl-BE,nl;q=0.9' },
    poolStrategy: 'sitemap',
    productStrategy: 'ahbe',
    sitemapPath: '/sitemaps/entities/products/detail.xml',
    productPathFilter: '/producten/product/',
  },
  'hubo-be': {
    id: 'hubo-be',
    baseUrl: 'https://www.hubo.be',
    siteLanguages: ['nl', 'fr'],
    defaultScrapeLang: 'nl',
    acceptLanguage: {
      nl: 'nl-BE,nl;q=0.9',
      fr: 'fr-BE,fr;q=0.9',
    },
    poolStrategy: 'sitemap-index',
    productStrategy: 'hubo',
    // Nested sitemap: an index points to ~257 sub-sitemaps (1000 urls each).
    // We only pull the first few for a varied-enough daily pool (see sitemapLimit).
    sitemapPath: '/sitemap/product-sitemap-index.xml',
    productPathFilter: '/{lang}/p/',
    sitemapLimit: 4,
    // Cross-lang: nl and fr share the trailing numeric id:
    // /nl/p/…-geel/103059/ ↔ /fr/p/…-jaune/103059/
    crossLangIdRegex: /\/(\d+)\/?$/,
  },
  'ikea-be': {
    id: 'ikea-be',
    baseUrl: 'https://www.ikea.com',
    siteLanguages: ['nl', 'fr'],
    defaultScrapeLang: 'nl',
    acceptLanguage: {
      nl: 'nl-BE,nl;q=0.9',
      fr: 'fr-BE,fr;q=0.9',
    },
    poolStrategy: 'sitemap-index',
    productStrategy: 'ikea',
    // Master sitemap lists per-country product sub-sitemaps; keep only
    // prod-<lang>-BE_*. One sub (~7000 products) overlaps 1:1 across languages,
    // since IKEA product names lead the slug and are language-independent.
    sitemapPath: '/sitemaps/sitemap.xml',
    sitemapSubFilter: 'prod-{lang}-BE_',
    productPathFilter: '/be/{lang}/p/',
    sitemapLimit: 1,
    // Cross-lang: nl and fr share the trailing id, which may carry an 's' prefix
    // for combination products: /be/nl/p/…-50598681/ or …-s09122851/.
    crossLangIdRegex: /-(s?\d+)\/?$/,
  },
};

const DEFAULT_MARKET = 'be';

function getMarket(id) { return MARKETS[id] || MARKETS[DEFAULT_MARKET]; }
function resolveScrapeLang(market, requested) {
  return market.siteLanguages.includes(requested) ? requested : market.defaultScrapeLang;
}

function buildHeaders(market, scrapeLang, accept) {
  const headers = {
    'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept-Language': market.acceptLanguage[scrapeLang] || market.acceptLanguage[market.defaultScrapeLang],
    'Accept':          accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Sec-Fetch-Dest':  'document',
    'Sec-Fetch-Mode':  'navigate',
    'Upgrade-Insecure-Requests': '1',
  };

  if (market.id === 'ah-be') {
    headers.Origin = 'https://www.ah.be';
    headers.Referer = 'https://www.ah.be/';
    headers['Sec-Fetch-Site'] = 'same-origin';
  } else {
    headers['Sec-Fetch-Site'] = 'none';
  }

  return headers;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Minimal axios-compatible GET backed by Node's native fetch (undici). undici's
// TLS fingerprint gets past Cloudflare on some stores (e.g. Hubo) where axios is
// blocked with a 403. It also auto-decompresses, so we drop Accept-Encoding and
// let it manage that. Returns { data, status } so callers can use resp.data.
async function httpGet(url, { headers = {}, timeout = 15000 } = {}) {
  const { ['Accept-Encoding']: _drop, ...h } = headers;
  const urlHost = (() => { try { return new URL(url).hostname; } catch { return ''; } })();
  const shouldUseAhBrowserHeaders = urlHost === 'www.ah.be' || urlHost === 'ah.be';

  const requestHeaders = shouldUseAhBrowserHeaders
    ? { ...h, Origin: 'https://www.ah.be', Referer: 'https://www.ah.be/', 'Sec-Fetch-Site': 'same-origin' }
    : h;

  let res = await fetch(url, { headers: requestHeaders, redirect: 'follow', signal: AbortSignal.timeout(timeout) });

  const shouldRetryAh403 = res.status === 403 && shouldUseAhBrowserHeaders && (
    !(h.Origin || h.Referer || h['Sec-Fetch-Site'] === 'same-origin') ||
    (h.Origin === 'https://www.ah.be' && h.Referer === 'https://www.ah.be/' && h['Sec-Fetch-Site'] === 'same-origin')
  );

  if (shouldRetryAh403) {
    const retryHeaders = { ...requestHeaders, Origin: 'https://www.ah.be', Referer: 'https://www.ah.be/', 'Sec-Fetch-Site': 'same-origin' };
    res = await fetch(url, { headers: retryHeaders, redirect: 'follow', signal: AbortSignal.timeout(timeout) });
  }

  if (!res.ok) {
    const e = new Error(`Request failed with status code ${res.status}`);
    e.status = res.status;
    throw e;
  }

  return { data: await res.text(), status: res.status };
}

// ── Seed helpers ─────────────────────────────────────────────────────────────
// dateToSeed: stable integer hash from a string (must match the frontend).
// seededRandom: mulberry32 PRNG, deterministic given the seed.
function dateToSeed(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = Math.imul(31, h) + s.charCodeAt(i) | 0;
  return Math.abs(h);
}
function seededRandom(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function getTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ── Pool strategies ──────────────────────────────────────────────────────────
const POOL_STRATEGIES = {
  // Simple sitemap that lists product URLs directly (BE, Nord)
  async sitemap(market, scrapeLang) {
    // {langPrefix}: empty for the default language (served at the site root),
    // "/<lang>" for the others. {lang} kept for any legacy per-lang paths.
    const langPrefix = scrapeLang === market.defaultScrapeLang ? '' : `/${scrapeLang}`;
    const sitemapUrl = market.baseUrl + market.sitemapPath
      .replace('{langPrefix}', langPrefix)
      .replace('{lang}', scrapeLang);
    const filter    = market.productPathFilter ? market.productPathFilter.replace('{lang}', scrapeLang) : '';
    console.log(`Fetching sitemap (${market.id}/${scrapeLang}): ${sitemapUrl}`);
    const resp = await httpGet(sitemapUrl, {
      headers: buildHeaders(market, scrapeLang, 'application/xml,text/xml,*/*'),
      timeout: 20000,
    });
    const urls = new Set();
    for (const m of resp.data.matchAll(/<loc>(https?:\/\/[^<]+)<\/loc>/g)) {
      if (!filter || m[1].includes(filter)) urls.add(m[1]);
    }
    return [...urls];
  },

  // Nested sitemap: an index lists sub-sitemaps, each listing product URLs (Hubo, IKEA).
  // Bounded by market.sitemapLimit so warmup stays cheap. market.sitemapSubFilter (with
  // {lang}) narrows a multi-country index to the right sub-sitemaps; productPathFilter
  // then keeps only the requested language's product URLs.
  async 'sitemap-index'(market, scrapeLang) {
    const indexUrl = market.baseUrl + market.sitemapPath;
    const filter   = market.productPathFilter.replace('{lang}', scrapeLang);
    console.log(`Fetching sitemap index (${market.id}/${scrapeLang}): ${indexUrl}`);
    const idxResp  = await httpGet(indexUrl, {
      headers: buildHeaders(market, scrapeLang, 'application/xml,text/xml,*/*'),
      timeout: 20000,
    });
    let subs = [...idxResp.data.matchAll(/<loc>(https?:\/\/[^<]+)<\/loc>/g)].map(m => m[1]);
    if (market.sitemapSubFilter) {
      const subFilter = market.sitemapSubFilter.replace('{lang}', scrapeLang);
      subs = subs.filter(u => u.includes(subFilter));
    }
    const limit = market.sitemapLimit || subs.length;
    const urls = new Set();
    for (const sub of subs.slice(0, limit)) {
      try {
        // Product sitemaps can be large (IKEA ~50MB decompressed) — allow more time.
        const r = await httpGet(sub, {
          headers: buildHeaders(market, scrapeLang, 'application/xml,text/xml,*/*'),
          timeout: 60000,
        });
        for (const m of r.data.matchAll(/<loc>(https?:\/\/[^<]+)<\/loc>/g)) {
          if (m[1].includes(filter)) urls.add(m[1]);
        }
      } catch (e) {
        console.log(`  skipped sub-sitemap (${sub}): ${e.message}`);
      }
      await sleep(120);
    }
    return [...urls];
  },

  // Sitemap only lists brand pages; products are embedded within each brand page (Süd)
  async 'sued-brands'(market, scrapeLang) {
    const sitemapUrl = market.baseUrl + market.sitemapPath;
    const resp = await httpGet(sitemapUrl, {
      headers: buildHeaders(market, scrapeLang, 'application/xml,text/xml,*/*'),
      timeout: 20000,
    });
    const brandUrls = [];
    for (const m of resp.data.matchAll(/<loc>(https?:\/\/[^<]+\/marken\/[^<]+)<\/loc>/g)) {
      brandUrls.push(m[1]);
    }
    brandUrls.push(`${market.baseUrl}/de/produkte.html`);

    const products = new Set();
    for (const brandUrl of brandUrls) {
      try {
        const r = await httpGet(brandUrl, { headers: buildHeaders(market, scrapeLang), timeout: 12000 });
        for (const m of r.data.matchAll(/\/produkt\/[a-z0-9-]+/g)) {
          products.add(market.baseUrl + m[0]);
        }
      } catch (e) {
        console.log(`  skipped brand page (${brandUrl}): ${e.message}`);
      }
      await sleep(120);
    }
    return [...products];
  },
};

async function fetchProductPool(market, scrapeLang) {
  const fn = POOL_STRATEGIES[market.poolStrategy];
  if (!fn) throw new Error(`Unknown pool strategy: ${market.poolStrategy}`);
  const urls = await fn(market, scrapeLang);
  urls.sort();
  console.log(`Pool (${market.id}/${scrapeLang}): ${urls.length} URLs`);
  return urls;
}

// ── Product strategies ──────────────────────────────────────────────────────
function cleanText(s) { return (s || '').replace(/\s+/g, ' ').trim(); }

const PRODUCT_STRATEGIES = {
  // Belgian Aldi: products show a visible €-value in HTML, name in h1/h2
  be(html, $, url, market) {
    const name = cleanText(
      $('h1, h2').filter((_, el) => $(el).text().trim().length > 3).first().text()
    );
    let price = 0;
    $('span, strong, b, div, p').each((_, el) => {
      if (price) return false;
      const t = $(el).clone().children().remove().end().text().trim();
      if (/^\d{1,4}[,.]\d{2}$/.test(t)) {
        const n = parseFloat(t.replace(',', '.'));
        if (n > 0.05 && n < 500) price = n;
      }
    });
    let imageUrl = $('meta[property="og:image"]').attr('content') || '';
    if (imageUrl && !imageUrl.startsWith('http')) imageUrl = market.baseUrl + imageUrl;
    if (!imageUrl) {
      const src = $('img[src*="/content/aldi/"]').first().attr('src') || '';
      imageUrl  = src ? (src.startsWith('http') ? src : market.baseUrl + src) : '';
    }
    const desc = cleanText($('span, p, li').filter((_, el) => {
      const t = $(el).text().trim();
      return t.length > 4 && t.length < 120 && /\d+\s*(g|kg|ml|l|cl|st\.?|stuks|pak|blik)/i.test(t);
    }).first().text());
    return { name, price, imageUrl, description: desc };
  },

  // Aldi Nord: Next.js JSON embedded in HTML; <title> contains the product name
  nord(html, $, url, market) {
    const name = cleanText($('title').text());
    let price = 0;
    const pm = html.match(/priceValue\\?"\s*:\s*(\d+\.\d+)/);
    if (pm) price = parseFloat(pm[1]);
    const imageUrl = $('meta[property="og:image"]').attr('content') || '';
    // Description: the meta tag combines name + short description; strip the name prefix.
    let desc = cleanText($('meta[name="description"]').attr('content') || '');
    if (desc && name && desc.toUpperCase().startsWith(name.toUpperCase())) {
      desc = desc.slice(name.length).replace(/^[\s;:,-]+/, '').trim();
    }
    // Fallback: shortDescription field in embedded JSON.
    if (!desc) {
      const dm = html.match(/shortDescription\\?"\s*:\s*\\?"([^"\\]{1,200})/);
      if (dm) desc = dm[1];
    }
    return { name, price, imageUrl, description: desc };
  },

  // Aldi Süd: price embedded in JSON ("price":"X,XX"); name in h1/title
  sued(html, $, url, market) {
    const name = cleanText($('h1').first().text() || $('title').text());
    let price = 0;
    const pm = html.match(/"price"\s*:\s*"?(\d+[.,]\d+)"?/);
    if (pm) price = parseFloat(pm[1].replace(',', '.'));
    const imageUrl = $('meta[property="og:image"]').attr('content') || '';
    // Prefer embedded JSON description (product spec); fall back to meta tag.
    let desc = '';
    const dm = html.match(/"description"\s*:\s*"([^"]{4,200})"/);
    if (dm) desc = cleanText(dm[1]);
    if (!desc) {
      desc = cleanText($('meta[name="description"]').attr('content') || '')
        .replace(/^So viel Spaß macht.+?Preisen\.\s*/i, '')
        .replace(/\s*➔\s*Jetzt bei ALDI S(?:ÜD|UED) kaufen!?\s*$/i, '')
        .replace(/\s*zum günstigen ALDI Preis\s*\.?\s*$/i, '')
        .trim();
    }
    return { name, price, imageUrl, description: desc };
  },

  // Albert Heijn BE: a JSON-LD Product block carries name, price, image and weight.
  ahbe(html, $, url, market) {
    let name = '', price = 0, imageUrl = '', desc = '';
    $('script[type="application/ld+json"]').each((_, el) => {
      if (name && price) return false;
      let data;
      try { data = JSON.parse($(el).contents().text() || $(el).text()); } catch { return; }
      for (const node of (Array.isArray(data) ? data : [data])) {
        if (!node || node['@type'] !== 'Product') continue;
        name = cleanText(node.name || name);

        const candidates = [];
        const offers = Array.isArray(node.offers) ? node.offers : [node.offers].filter(Boolean);
        for (const offer of offers) {
          if (!offer) continue;
          if (offer.price != null) candidates.push(parseFloat(String(offer.price).replace(',', '.')));
          if (offer.priceSpecification && offer.priceSpecification.price != null) {
            candidates.push(parseFloat(String(offer.priceSpecification.price).replace(',', '.')));
          }
        }
        if (node.price != null) candidates.push(parseFloat(String(node.price).replace(',', '.')));
        if (node.priceSpecification && node.priceSpecification.price != null) {
          candidates.push(parseFloat(String(node.priceSpecification.price).replace(',', '.')));
        }
        const positive = candidates.filter(v => Number.isFinite(v) && v > 0);
        if (positive.length) price = Math.max(...positive);

        if (node.image) imageUrl = Array.isArray(node.image) ? node.image[0] : node.image;
        if (node.weight && node.weight.value) desc = cleanText(node.weight.value);
      }
    });
    // AH page titles carry a " reserveren | Albert Heijn" suffix — strip it.
    name = name.replace(/\s*\|\s*Albert Heijn\s*$/i, '').replace(/\s+reserveren\s*$/i, '').trim();
    // Prefer the og:image (entities-decoded by cheerio); bump to a crisper rendition.
    const og = $('meta[property="og:image"]').attr('content');
    if (og) imageUrl = og;
    if (imageUrl) imageUrl = imageUrl.replace(/rendition=\d+x\d+_/, 'rendition=400x400_');
    return { name, price, imageUrl, description: desc };
  },

  // Hubo (DIY): name in <title>, price embedded as "offers":{"price":"X.XX"}.
  hubo(html, $, url, market) {
    let name = cleanText($('title').text() || $('meta[property="og:title"]').attr('content') || '');
    name = name.replace(/\s*\|\s*Hubo\s*$/i, '').trim();
    let price = 0;
    const pm = html.match(/"offers":\s*\{\s*"price":\s*"([\d.]+)"/);
    if (pm) price = parseFloat(pm[1]);
    const imageUrl = $('meta[property="og:image"]').attr('content') || '';
    const desc = cleanText($('meta[name="description"]').attr('content') || '');
    return { name, price, imageUrl, description: desc };
  },

  // IKEA: og:title is "NAME descriptor, variant, size"; price in "price":X.XX.
  ikea(html, $, url, market) {
    let full = cleanText($('meta[property="og:title"]').attr('content') || $('title').text() || '');
    full = full.replace(/\s*-\s*IKEA.*$/i, '').trim();
    // The (language-independent) product name is the leading run of all-caps words;
    // the descriptor is the rest (e.g. "ZAMIOCULCAS" + "plant, …, 17 cm").
    let name = full, desc = '';
    const words = full.split(' ');
    let i = 0;
    while (i < words.length && words[i] && !/\p{Ll}/u.test(words[i])) i++;
    if (i > 0 && i < words.length) {
      name = words.slice(0, i).join(' ');
      desc = words.slice(i).join(' ').replace(/,\s*\.\s*,/g, ',').trim();
    }
    // Combination products list "price":0 placeholders before the real price —
    // take the first non-zero value.
    let price = 0;
    for (const pm of html.matchAll(/"price":\s*"?(\d+(?:[.,]\d+)?)"?/g)) {
      const v = parseFloat(pm[1].replace(',', '.'));
      if (v > 0) { price = v; break; }
    }
    const imageUrl = $('meta[property="og:image"]').attr('content') || '';
    return { name, price, imageUrl, description: desc };
  },
};

async function scrapeProduct(url, market, scrapeLang) {
  const resp = await httpGet(url, { headers: buildHeaders(market, scrapeLang), timeout: 12000 });
  const html = resp.data;
  const $    = cheerio.load(html);
  const fn   = PRODUCT_STRATEGIES[market.productStrategy];
  if (!fn) throw new Error(`Unknown product strategy: ${market.productStrategy}`);
  const raw  = fn(html, $, url, market);
  return {
    name: raw.name,
    price: raw.price,
    imageUrl: raw.imageUrl,
    description: raw.description,
    productUrl: url,
  };
}

// ── Cache ─────────────────────────────────────────────────────────────────────
function loadCache() {
  try { return fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : {}; }
  catch { return {}; }
}
function saveCache(data) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2)); } catch {}
}

// ── Cross-language index for multilang markets ───────────────────────────────
// Builds { id → { lang: url, … } } from each siteLanguages sitemap, then keeps
// only IDs present in EVERY language so the deterministic pick yields the same
// product regardless of the selected language.
async function ensureCrossLangIndex(market) {
  const cache       = loadCache();
  const indexKey    = `__crossLangIndex:${market.id}`;
  const indexDateKey = `__crossLangIndexDate:${market.id}`;
  const age         = cache[indexDateKey]
    ? Math.floor((Date.now() - cache[indexDateKey]) / 86400000) : 99;
  if (cache[indexKey] && Object.keys(cache[indexKey]).length >= 10 && age < 7) {
    return cache[indexKey];
  }

  console.log(`Building cross-lang index (${market.id})…`);
  const idToUrls = {};
  for (const lang of market.siteLanguages) {
    const urls = await POOL_STRATEGIES[market.poolStrategy](market, lang);
    for (const url of urls) {
      const m = url.match(market.crossLangIdRegex);
      if (!m) continue;
      const id = m[1];
      if (!idToUrls[id]) idToUrls[id] = {};
      idToUrls[id][lang] = url;
    }
  }
  // Keep only IDs that exist in every language → identical pool across languages
  const filtered = {};
  for (const id of Object.keys(idToUrls)) {
    if (market.siteLanguages.every(l => idToUrls[id][l])) filtered[id] = idToUrls[id];
  }
  cache[indexKey]     = filtered;
  cache[indexDateKey] = Date.now();
  saveCache(cache);
  console.log(`Cross-lang index (${market.id}): ${Object.keys(filtered).length} products across ${market.siteLanguages.length} languages`);
  return filtered;
}

// ── Warmup ────────────────────────────────────────────────────────────────────
let warmupPromise = null;

async function warmupPool(marketId, scrapeLang) {
  const market = getMarket(marketId);
  if (market.crossLangIdRegex) {
    await ensureCrossLangIndex(market);
    return;
  }
  const lang     = resolveScrapeLang(market, scrapeLang || market.defaultScrapeLang);
  const cache    = loadCache();
  const poolKey  = `__pool:${market.id}:${lang}`;
  const dateKey  = `__poolDate:${market.id}:${lang}`;
  const poolAge  = cache[dateKey]
    ? Math.floor((Date.now() - cache[dateKey]) / 86400000) : 99;
  if (cache[poolKey] && cache[poolKey].length >= 10 && poolAge < 7) {
    console.log(`Pool already cached (${market.id}/${lang}): ${cache[poolKey].length} products`);
    return;
  }
  console.log(`Warming up pool (${market.id}/${lang})…`);
  cache[poolKey] = await fetchProductPool(market, lang);
  cache[dateKey] = Date.now();
  saveCache(cache);
  console.log(`Warmed up (${market.id}/${lang}): ${cache[poolKey].length} products ready`);
}

// ── Special pinned products ──────────────────────────────────────────────────
// On landmark dates, override the deterministic pick with a hand-picked product.
// The `special` tag travels to the frontend, which shows a matching easter egg.
// An entry exists for exactly one date, so the easter egg is shown only that day.
const SPECIAL_PRODUCTS = {
  // 2026-05-22 — Aldidle turns one week old. A bottle of bubbly to toast with.
  '2026-05-22': {
    special: 'birthday',
    byLang: {
      nl: { name: 'VEUVE DURAND® Champagne brut',  url: 'https://www.aldi.be/nl/p/champagne-brut-1225-1-0.article.html' },
      fr: { name: 'VEUVE DURAND® Champagne brut',  url: 'https://www.aldi.be/fr/p/champagne-brut-1225-1-0.article.html' },
      de: { name: 'VEUVE DURAND® Champagner brut', url: 'https://www.aldi.be/de/p/champagner-brut-1225-1-0.article.html' },
    },
    // Snapshot — used only if the live scrape fails on the day itself.
    snapshot: {
      price: 17.99,
      description: '75 cl',
      imageUrl: 'https://www.aldi.be/content/aldi/belgium/promotions/source-localenhancement/2019/2019-01/2019-01-02/vast_assortiment/1225/1/0/_jcr_content/assets/imported-images/BILD_INTERNET1/1225_champagne_brut.png/_jcr_content/renditions/original.transform/288w/img.260521.png',
    },
  },
};

// Resolve a special product for a date/lang, or null. Scrapes live first so
// price/image stay current; falls back to the snapshot if scraping fails.
async function getSpecialProduct(dateKey, lang) {
  const special = SPECIAL_PRODUCTS[dateKey];
  if (!special) return null;
  const sLang = special.byLang[lang] ? lang : 'nl';
  const loc   = special.byLang[sLang];
  try {
    const live = await scrapeProduct(loc.url, getMarket('be'), sLang);
    if (live.name && live.price > 0) {
      return { ...live, special: special.special };
    }
  } catch (e) {
    console.log(`Special product scrape failed (${dateKey}/${sLang}), using snapshot: ${e.message}`);
  }
  return {
    name: loc.name,
    productUrl: loc.url,
    special: special.special,
    ...special.snapshot,
  };
}

// ── Product of the day ───────────────────────────────────────────────────────
async function getProductOfDay(dateKey, marketId, requestedLang) {
  if (warmupPromise) await warmupPromise.catch(() => {});

  const market   = getMarket(marketId);
  const lang     = resolveScrapeLang(market, requestedLang || market.defaultScrapeLang);

  // Landmark dates short-circuit the deterministic pick (and the cache).
  const special = await getSpecialProduct(dateKey, lang);
  if (special) return special;

  const cache    = loadCache();
  const cacheKey = `${market.id}:${lang}:${dateKey}`;
  if (cache[cacheKey]) return cache[cacheKey];

  const rng = seededRandom(dateToSeed(`${market.id}:${dateKey}`));
  let product = null;
  let tries   = 0;

  if (market.crossLangIdRegex) {
    // Multilang path: pick a product ID, resolve to URL in the requested language.
    const index = await ensureCrossLangIndex(market);
    const ids = Object.keys(index).sort();
    if (!ids.length) throw new Error(`Empty cross-lang index for ${market.id}`);
    const maxAttempts = market.id === 'ah-be' ? 20 : 5;
    while (!product && tries < maxAttempts) {
      const idx = Math.floor(rng() * ids.length);
      const id  = ids[(idx + tries) % ids.length];
      const url = index[id][lang] || index[id][market.defaultScrapeLang];
      tries++;
      try {
        console.log(`Fetching product (${market.id}/${lang}, ID ${id}, attempt ${tries}): ${url}`);
        const p = await scrapeProduct(url, market, lang);
        if (p.name && p.price > 0) product = p;
        else console.log(`  → no name/price found, trying next`);
      } catch (e) {
        console.log(`  → error: ${e.message}`);
      }
    }
  } else {
    // Single-lang path: per-language pool.
    const poolKey     = `__pool:${market.id}:${lang}`;
    const poolDateKey = `__poolDate:${market.id}:${lang}`;
    const poolAge     = cache[poolDateKey]
      ? Math.floor((Date.now() - cache[poolDateKey]) / 86400000) : 99;
    if (!cache[poolKey] || cache[poolKey].length < 10 || poolAge >= 7) {
      console.log(`Refreshing product pool (${market.id}/${lang})…`);
      cache[poolKey]     = await fetchProductPool(market, lang);
      cache[poolDateKey] = Date.now();
      if (!cache[poolKey].length) throw new Error(`No products found for ${market.id}/${lang}`);
      saveCache(cache);
    }
    const maxAttempts = market.id === 'ah-be' ? 20 : 5;
    while (!product && tries < maxAttempts) {
      const idx = Math.floor(rng() * cache[poolKey].length);
      const url = cache[poolKey][(idx + tries) % cache[poolKey].length];
      tries++;
      try {
        console.log(`Fetching product (${market.id}/${lang}, attempt ${tries}): ${url}`);
        const p = await scrapeProduct(url, market, lang);
        if (p.name && p.price > 0) product = p;
        else console.log(`  → no name/price found, trying next`);
      } catch (e) {
        console.log(`  → error: ${e.message}`);
      }
    }
  }

  if (!product) throw new Error(`Could not fetch a valid product after ${market.id === 'ah-be' ? 20 : 5} attempts`);
  // Reload cache: it may have been modified during scraping (sitemap fetches wrote to disk).
  const fresh = loadCache();
  fresh[cacheKey] = product;
  saveCache(fresh);
  return product;
}

// ── Analytics ────────────────────────────────────────────────────────────────
// Append-only JSONL log; one event per line. Stays on the same persistent
// volume as the product cache so it survives restarts.
const ALLOWED_EVENTS = new Set(['visit', 'guess', 'finish']);

function recordEvent(evt) {
  try {
    fs.appendFileSync(ANALYTICS_FILE, JSON.stringify(evt) + '\n');
  } catch (e) {
    console.log('analytics write failed:', e.message);
  }
}

function readEvents() {
  if (!fs.existsSync(ANALYTICS_FILE)) return [];
  const out = [];
  for (const line of fs.readFileSync(ANALYTICS_FILE, 'utf8').split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function aggregateStats(events) {
  const byDay = {};
  let visits = 0, guesses = 0, finishes = 0, wins = 0, winAttemptsSum = 0;
  const marketCounts = {}, langCounts = {};
  for (const e of events) {
    const day = (e.t || '').slice(0, 10);
    if (!byDay[day]) byDay[day] = { visits: 0, guesses: 0, finishes: 0, wins: 0, winAttemptsSum: 0 };
    if (e.type === 'visit')  { visits++;   byDay[day].visits++; }
    if (e.type === 'guess')  { guesses++;  byDay[day].guesses++; }
    if (e.type === 'finish') {
      finishes++; byDay[day].finishes++;
      if (e.won) { wins++; byDay[day].wins++;
        if (typeof e.attempts === 'number') { winAttemptsSum += e.attempts; byDay[day].winAttemptsSum += e.attempts; }
      }
    }
    if (e.market) marketCounts[e.market] = (marketCounts[e.market] || 0) + 1;
    if (e.lang)   langCounts[e.lang]     = (langCounts[e.lang]     || 0) + 1;
  }
  return { visits, guesses, finishes, wins, winAttemptsSum, byDay, marketCounts, langCounts };
}

// ── Express ───────────────────────────────────────────────────────────────────
app.use((_, res, next) => { res.header('Access-Control-Allow-Origin', '*'); next(); });
app.use(express.json({ limit: '2kb' }));

app.get('/api/markets', (_, res) => {
  res.json(Object.keys(MARKETS).map(id => ({
    id,
    siteLanguages: MARKETS[id].siteLanguages,
    defaultScrapeLang: MARKETS[id].defaultScrapeLang,
  })));
});

app.get('/api/product', async (req, res) => {
  const dateKey = req.query.date || getTodayKey();
  const market  = req.query.market || DEFAULT_MARKET;
  const lang    = req.query.lang || 'nl';
  try {
    const product = await getProductOfDay(dateKey, market, lang);
    res.json(product);
  } catch (err) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/event', (req, res) => {
  const b = req.body || {};
  if (!ALLOWED_EVENTS.has(b.type)) return res.status(400).json({ error: 'bad type' });
  const evt = { t: new Date().toISOString(), type: b.type };
  if (typeof b.market === 'string' && b.market.length < 32) evt.market = b.market;
  if (typeof b.lang   === 'string' && b.lang.length   < 8)  evt.lang   = b.lang;
  if (b.type === 'finish') {
    if (Number.isInteger(b.attempts) && b.attempts >= 1 && b.attempts <= 20) evt.attempts = b.attempts;
    evt.won = !!b.won;
  }
  recordEvent(evt);
  res.json({ ok: true });
});

app.get('/stats', (req, res) => {
  const token = process.env.STATS_TOKEN;
  console.log(`[stats] STATS_TOKEN ${token ? `set (len=${token.length})` : 'NOT set'}; query token ${req.query.token ? `provided (len=${String(req.query.token).length})` : 'absent'}; match=${!!token && req.query.token === token}`);
  if (token && req.query.token !== token) return res.status(404).send('Not found');
  const s = aggregateStats(readEvents());
  const avgWinAttempts = s.wins ? (s.winAttemptsSum / s.wins).toFixed(2) : '—';
  const winRate        = s.finishes ? ((s.wins / s.finishes) * 100).toFixed(1) + '%' : '—';
  const days = Object.keys(s.byDay).sort().reverse().slice(0, 30);
  const dayRows = days.map(d => {
    const r = s.byDay[d];
    return {
      day: d,
      visits: r.visits,
      guesses: r.guesses,
      finishes: r.finishes,
      wins: r.wins,
      winRate: r.finishes ? ((r.wins / r.finishes) * 100).toFixed(0) + '%' : '—',
      avgAttempts: r.wins ? (r.winAttemptsSum / r.wins).toFixed(2) : '—',
    };
  });
  const marketRows = Object.entries(s.marketCounts).sort((a, b) => b[1] - a[1]);
  const langRows    = Object.entries(s.langCounts).sort((a, b) => b[1] - a[1]);
  res.render('stats', { stats: s, avgWinAttempts, winRate, dayRows, marketRows, langRows });
});

app.use(express.static(__dirname));

// Landing page: pick a store.
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'landing.html')));

// Per-store game page (/aldi, /albertheijn, …). The game reads its store from
// the URL path. Unknown slugs bounce back to the landing page.
app.get('/:store', (req, res) => {
  if (Object.prototype.hasOwnProperty.call(STORES, req.params.store)) {
    return res.sendFile(path.join(__dirname, 'Aldidle.html'));
  }
  res.redirect('/');
});

// Exported for tests / manual use.
module.exports = { MARKETS, getMarket, fetchProductPool, scrapeProduct, resolveScrapeLang, buildHeaders, httpGet };

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n✅  Aldidle running at http://localhost:${PORT}\n`);
    warmupPromise = warmupPool(DEFAULT_MARKET).catch(e => console.error('Warmup failed:', e.message));
  });
}
