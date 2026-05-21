const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');
const fs      = require('fs');
const path    = require('path');

const app        = express();
const PORT       = process.env.PORT || 3000;
// CACHE_DIR lets the cache live on a persistent volume (e.g. a Railway volume)
// so the "product of the day" survives restarts. Defaults to the app dir.
const CACHE_DIR  = process.env.CACHE_DIR || __dirname;
const CACHE_FILE = path.join(CACHE_DIR, '.product-cache.json');

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
    siteLanguages: ['nl', 'fr', 'de'],
    defaultScrapeLang: 'nl',
    acceptLanguage: {
      nl: 'nl-BE,nl;q=0.9',
      fr: 'fr-BE,fr;q=0.9',
      de: 'de-BE,de;q=0.9',
    },
    poolStrategy: 'sitemap',
    productStrategy: 'be',
    sitemapPath: '/{lang}/.aldi-nord-sitemap-pages.xml',
    productPathFilter: '/{lang}/p/',
    // Cross-lang: the same product ID appears in all three sitemaps,
    // only the slug differs: /nl/p/bronwater-320-1-0 ↔ /fr/p/eau-de-source-320-1-0
    crossLangIdRegex: /-(\d+(?:-\d+)*)\.article\.html$/,
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
};

const DEFAULT_MARKET = 'be';

function getMarket(id) { return MARKETS[id] || MARKETS[DEFAULT_MARKET]; }
function resolveScrapeLang(market, requested) {
  return market.siteLanguages.includes(requested) ? requested : market.defaultScrapeLang;
}

function buildHeaders(market, scrapeLang, accept) {
  return {
    'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept-Language': market.acceptLanguage[scrapeLang] || market.acceptLanguage[market.defaultScrapeLang],
    'Accept':          accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Sec-Fetch-Dest':  'document',
    'Sec-Fetch-Mode':  'navigate',
    'Sec-Fetch-Site':  'none',
    'Upgrade-Insecure-Requests': '1',
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

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
    const sitemapUrl = market.baseUrl + market.sitemapPath.replace('{lang}', scrapeLang);
    const filter    = market.productPathFilter.replace('{lang}', scrapeLang);
    const resp = await axios.get(sitemapUrl, {
      headers: buildHeaders(market, scrapeLang, 'application/xml,text/xml,*/*'),
      timeout: 20000,
    });
    const urls = new Set();
    for (const m of resp.data.matchAll(/<loc>(https?:\/\/[^<]+)<\/loc>/g)) {
      if (m[1].includes(filter)) urls.add(m[1]);
    }
    return [...urls];
  },

  // Sitemap only lists brand pages; products are embedded within each brand page (Süd)
  async 'sued-brands'(market, scrapeLang) {
    const sitemapUrl = market.baseUrl + market.sitemapPath;
    const resp = await axios.get(sitemapUrl, {
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
        const r = await axios.get(brandUrl, { headers: buildHeaders(market, scrapeLang), timeout: 12000 });
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
};

async function scrapeProduct(url, market, scrapeLang) {
  const resp = await axios.get(url, { headers: buildHeaders(market, scrapeLang), timeout: 12000 });
  const html = resp.data;
  const $    = cheerio.load(html);
  const fn   = PRODUCT_STRATEGIES[market.productStrategy];
  if (!fn) throw new Error(`Unknown product strategy: ${market.productStrategy}`);
  const raw  = fn(html, $, url, market);
  const { key, emoji } = guessCategory(raw.name, url);
  return {
    name: raw.name,
    price: raw.price,
    imageUrl: raw.imageUrl,
    categoryKey: key,
    description: raw.description,
    productUrl: url,
    emoji,
  };
}

// Stable English keys; the frontend translates them to the active UI language.
function guessCategory(name, url) {
  const s = (name + ' ' + url).toLowerCase();
  if (/vis|inktvis|calamari|zalm|kabeljauw|garnaal|tonijn|makreel|zeevruchten|fisch|lachs|thunfisch/.test(s)) return { key: 'fish',          emoji: '🐟' };
  if (/kip|gevogelte|kalkoen|poulet|hähn|huhn|pute/.test(s))                                                  return { key: 'poultry',       emoji: '🍗' };
  if (/vlees|varken|rund|ham|salami|charcuterie|gehakt|worst|steak|spek|fleisch|schwein|wurst/.test(s))       return { key: 'meat',          emoji: '🥩' };
  if (/kaas|käse/.test(s))                                                                                    return { key: 'cheese',        emoji: '🧀' };
  if (/melk|yoghurt|boter|room|kwark|milch|butter|sahne|quark/.test(s))                                       return { key: 'dairy',         emoji: '🥛' };
  if (/eier|ei\./.test(s))                                                                                    return { key: 'eggs',          emoji: '🥚' };
  if (/brood|baguette|croissant|pistolet|wrap|pita|brot|brötchen/.test(s))                                    return { key: 'bakery',        emoji: '🥖' };
  if (/appel|peer|banaan|sinaasappel|aardbei|druif|mango|fruit|apfel|birne|erdbeer/.test(s))                  return { key: 'fruit',         emoji: '🍎' };
  if (/groente|sla|tomaat|komkommer|wortel|paprika|ui|prei|broccoli|spinazie|gemüse|salat|tomate|gurke|möhre|zwiebel/.test(s)) return { key: 'vegetables', emoji: '🥦' };
  if (/aardappel|kartoffel/.test(s))                                                                          return { key: 'vegetables',    emoji: '🥔' };
  if (/pasta|spaghetti|penne|fusilli|lasagne|nudel/.test(s))                                                  return { key: 'pasta',         emoji: '🍝' };
  if (/rijst|noedel|couscous|quinoa|reis/.test(s))                                                            return { key: 'grains',        emoji: '🍚' };
  if (/saus|ketchup|mayo|mosterd|dressing|pesto|soße|senf/.test(s))                                           return { key: 'sauces',        emoji: '🫙' };
  if (/olijfolie|zonnebloemolie|olie|öl/.test(s))                                                             return { key: 'oils',          emoji: '🫒' };
  if (/soep|suppe/.test(s))                                                                                   return { key: 'soup',          emoji: '🍲' };
  if (/bier/.test(s))                                                                                         return { key: 'beer',          emoji: '🍺' };
  if (/wijn|prosecco|cava|wein/.test(s))                                                                      return { key: 'wine',          emoji: '🍷' };
  if (/bronwater|mineraalwater|bruisend water|water|wasser/.test(s))                                          return { key: 'water',         emoji: '💧' };
  if (/frisdrank|cola|fanta|sprite|limonade|sap|juice|saft/.test(s))                                          return { key: 'drinks',        emoji: '🥤' };
  if (/koffie|espresso|kaffee/.test(s))                                                                       return { key: 'coffee',        emoji: '☕' };
  if (/thee|tee/.test(s))                                                                                     return { key: 'tea',           emoji: '🍵' };
  if (/chocolade|schokolade/.test(s))                                                                         return { key: 'chocolate',     emoji: '🍫' };
  if (/koek|biscuit|wafel|keks|waffel/.test(s))                                                               return { key: 'cookies',       emoji: '🍪' };
  if (/chips|popcorn|pretzels|brezel/.test(s))                                                                return { key: 'snacks',        emoji: '🥨' };
  if (/snoep|gummy|drop|süßigkeit|gummibär/.test(s))                                                          return { key: 'candy',         emoji: '🍬' };
  if (/noten|amandelen|cashew|pistache|nuss|mandel/.test(s))                                                  return { key: 'nuts',          emoji: '🥜' };
  if (/jam|confituur|honing|siroop|honig|marmelade/.test(s))                                                  return { key: 'spread',        emoji: '🍯' };
  if (/diepvries|frozen|tiefkühl/.test(s))                                                                    return { key: 'frozen',        emoji: '❄️' };
  if (/tortilla|tapas|serrano|hummus/.test(s))                                                                return { key: 'international', emoji: '🌍' };
  if (/shampoo|douchegel|zeep|tandpasta|seife|zahnpasta/.test(s))                                             return { key: 'care',          emoji: '🧴' };
  if (/wasmiddel|afwasmiddel|schoonmaakmiddel|waschmittel|spülmittel/.test(s))                                return { key: 'cleaning',      emoji: '🧹' };
  return { key: 'default', emoji: '🛒' };
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

// ── Product of the day ───────────────────────────────────────────────────────
async function getProductOfDay(dateKey, marketId, requestedLang) {
  if (warmupPromise) await warmupPromise.catch(() => {});

  const market   = getMarket(marketId);
  const lang     = resolveScrapeLang(market, requestedLang || market.defaultScrapeLang);
  const cache    = loadCache();
  const cacheKey = `${market.id}:${lang}:${dateKey}`;
  if (cache[cacheKey]) {
    let cached = cache[cacheKey];
    // Migrate legacy cache entries that predate categoryKey: re-derive from name/URL.
    if (!cached.categoryKey) {
      const { key, emoji } = guessCategory(cached.name || '', cached.productUrl || '');
      cached = { ...cached, categoryKey: key, emoji: cached.emoji || emoji };
      delete cached.category;
      const fresh = loadCache();
      fresh[cacheKey] = cached;
      saveCache(fresh);
    }
    return cached;
  }

  const rng = seededRandom(dateToSeed(`${market.id}:${dateKey}`));
  let product = null;
  let tries   = 0;

  if (market.crossLangIdRegex) {
    // Multilang path: pick a product ID, resolve to URL in the requested language.
    const index = await ensureCrossLangIndex(market);
    const ids = Object.keys(index).sort();
    if (!ids.length) throw new Error(`Empty cross-lang index for ${market.id}`);
    while (!product && tries < 5) {
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
    while (!product && tries < 5) {
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

  if (!product) throw new Error('Could not fetch a valid product after 5 attempts');
  // Reload cache: it may have been modified during scraping (sitemap fetches wrote to disk).
  const fresh = loadCache();
  fresh[cacheKey] = product;
  saveCache(fresh);
  return product;
}

// ── Express ───────────────────────────────────────────────────────────────────
app.use((_, res, next) => { res.header('Access-Control-Allow-Origin', '*'); next(); });

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

app.use(express.static(__dirname));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'Aldidle.html')));

// Exported for tests / manual use.
module.exports = { MARKETS, getMarket, fetchProductPool, scrapeProduct, resolveScrapeLang };

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n✅  Aldidle running at http://localhost:${PORT}\n`);
    warmupPromise = warmupPool(DEFAULT_MARKET).catch(e => console.error('Warmup failed:', e.message));
  });
}
