const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');
const fs      = require('fs');
const path    = require('path');

const app        = express();
const PORT       = process.env.PORT || 3000;
const CACHE_FILE = path.join(__dirname, '.product-cache.json');
const BASE_URL   = 'https://www.aldi.be';

const LANGS = { nl: 'nl', fr: 'fr', de: 'de' };

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'nl-BE,nl;q=0.9',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Seed helpers (identical to frontend) ─────────────────────────────────────
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

// ── 1. Sitemap: permanente assortiment (~1200+ producten) ─────────────────────
async function fetchSitemapUrls(lang = 'nl') {
  const l = LANGS[lang] || 'nl';
  const sitemapUrl = `${BASE_URL}/${l}/.aldi-nord-sitemap-pages.xml`;
  const resp = await axios.get(sitemapUrl, {
    headers: { ...HEADERS, Accept: 'application/xml,text/xml,*/*' },
    timeout: 20000,
  });
  const urls = [];
  for (const m of resp.data.matchAll(/<loc>(https?:\/\/[^<]+\.article\.html)<\/loc>/g)) {
    if (m[1].includes(`/${l}/p/`)) urls.push(m[1]);
  }
  return urls;
}

// ── 2. Weekaanbiedingen: links van homepage + recente aanbiedingenspagina's ───
async function fetchOfferUrls(lang = 'nl') {
  const l = LANGS[lang] || 'nl';
  const seen = new Set();
  const pagesToCheck = [`${BASE_URL}/${l}/`];

  // Voeg de laatste 10 woensdagen toe als kandidaat-URL's
  const now = new Date();
  const daysToLastWed = (now.getDay() + 4) % 7;
  for (let w = 0; w < 10; w++) {
    const d = new Date(now);
    d.setDate(now.getDate() - daysToLastWed - w * 7);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    pagesToCheck.push(`${BASE_URL}/${l}/onze-aanbiedingen/aanbiedingen-${dd}-${mm}/`);
  }

  for (const pageUrl of pagesToCheck) {
    try {
      const resp = await axios.get(pageUrl, { headers: HEADERS, timeout: 8000 });
      const $ = cheerio.load(resp.data);
      $('a[href*=".article.html"]').each((_, el) => {
        const href = $(el).attr('href') || '';
        if (href) seen.add(href.startsWith('http') ? href : `${BASE_URL}${href}`);
      });
    } catch { /* 404 of timeout — gewoon overslaan */ }
    await sleep(150);
  }
  return [...seen];
}

// ── Gecombineerde pool bouwen ──────────────────────────────────────────────────
async function fetchProductPool(lang = 'nl') {
  const [sitemap, offers] = await Promise.allSettled([
    fetchSitemapUrls(lang),
    fetchOfferUrls(lang),
  ]);
  const sitemapUrls = sitemap.status === 'fulfilled' ? sitemap.value : [];
  const offerUrls   = offers.status  === 'fulfilled' ? offers.value  : [];
  const all = [...new Set([...sitemapUrls, ...offerUrls])];
  console.log(`Pool (${lang}): ${sitemapUrls.length} assortiment + ${offerUrls.length} aanbiedingen = ${all.length} totaal`);
  return all;
}

// ── Productpagina scrapen ─────────────────────────────────────────────────────
async function scrapeProduct(url) {
  const resp = await axios.get(url, { headers: HEADERS, timeout: 12000 });
  const $    = cheerio.load(resp.data);

  // Naam
  const name = $('h1, h2').filter((_, el) => $(el).text().trim().length > 3)
                            .first().text().replace(/\s+/g, ' ').trim();

  // Prijs — zoek elementen met alleen een prijs-getal (bijv. "0.38" of "4.49")
  let price = 0;
  $('span, strong, b, div, p').each((_, el) => {
    if (price) return false;
    const t = $(el).clone().children().remove().end().text().trim();
    if (/^\d{1,4}[,.]\d{2}$/.test(t)) {
      const n = parseFloat(t.replace(',', '.'));
      if (n > 0.05 && n < 500) price = n;
    }
  });

  // Afbeelding — voorkeur og:image, dan eerste /content/aldi/-img
  let imageUrl = $('meta[property="og:image"]').attr('content') || '';
  if (imageUrl && !imageUrl.startsWith('http')) imageUrl = BASE_URL + imageUrl;
  if (!imageUrl) {
    const src = $('img[src*="/content/aldi/"]').first().attr('src') || '';
    imageUrl  = src ? (src.startsWith('http') ? src : BASE_URL + src) : '';
  }

  // Beschrijving — gewicht/volume in tekst
  const desc = $('span, p, li').filter((_, el) => {
    const t = $(el).text().trim();
    return t.length > 4 && t.length < 120 && /\d+\s*(g|kg|ml|l|cl|st\.?|stuks|pak|blik)/i.test(t);
  }).first().text().trim();

  const { cat, emoji } = guessCategory(name, url);
  return { name, price, imageUrl, category: cat, description: desc, productUrl: url, emoji };
}

// ── Categorie & emoji uit naam/URL ────────────────────────────────────────────
function guessCategory(name, url) {
  const s = (name + ' ' + url).toLowerCase();
  if (/vis|inktvis|calamari|zalm|kabeljauw|garnaal|tonijn|makreel|zeevruchten/.test(s)) return { cat: 'Vis & zeevruchten', emoji: '🐟' };
  if (/kip|gevogelte|kalkoen|poulet/.test(s))  return { cat: 'Gevogelte',      emoji: '🍗' };
  if (/vlees|varken|rund|ham|salami|charcuterie|gehakt|worst|steak|spek/.test(s)) return { cat: 'Vlees', emoji: '🥩' };
  if (/kaas/.test(s))                          return { cat: 'Kaas',           emoji: '🧀' };
  if (/melk|yoghurt|boter|room|kwark/.test(s)) return { cat: 'Zuivel',         emoji: '🥛' };
  if (/eier|ei\./.test(s))                     return { cat: 'Eieren',         emoji: '🥚' };
  if (/brood|baguette|croissant|pistolet|wrap|pita/.test(s)) return { cat: 'Bakkerij', emoji: '🥖' };
  if (/appel|peer|banaan|sinaasappel|aardbei|druif|mango|fruit/.test(s)) return { cat: 'Fruit', emoji: '🍎' };
  if (/groente|sla|tomaat|komkommer|wortel|paprika|ui|prei|broccoli|spinazie/.test(s)) return { cat: 'Groenten', emoji: '🥦' };
  if (/aardappel/.test(s))                     return { cat: 'Groenten',       emoji: '🥔' };
  if (/pasta|spaghetti|penne|fusilli|lasagne/.test(s)) return { cat: 'Pasta',  emoji: '🍝' };
  if (/rijst|noedel|couscous|quinoa/.test(s))  return { cat: 'Granen & rijst', emoji: '🍚' };
  if (/saus|ketchup|mayo|mosterd|dressing|pesto/.test(s)) return { cat: 'Sauzen', emoji: '🫙' };
  if (/olijfolie|zonnebloemolie|olie/.test(s)) return { cat: 'Oliën',          emoji: '🫒' };
  if (/soep/.test(s))                          return { cat: 'Soep',           emoji: '🍲' };
  if (/bier/.test(s))                          return { cat: 'Bier',           emoji: '🍺' };
  if (/wijn|prosecco|cava/.test(s))            return { cat: 'Wijn',           emoji: '🍷' };
  if (/bronwater|mineraalwater|bruisend water|water/.test(s)) return { cat: 'Water', emoji: '💧' };
  if (/frisdrank|cola|fanta|sprite|limonade|sap|juice/.test(s)) return { cat: 'Dranken', emoji: '🥤' };
  if (/koffie|espresso/.test(s))               return { cat: 'Koffie',         emoji: '☕' };
  if (/thee/.test(s))                          return { cat: 'Thee',           emoji: '🍵' };
  if (/chocolade/.test(s))                     return { cat: 'Chocolade',      emoji: '🍫' };
  if (/koek|biscuit|wafel/.test(s))            return { cat: 'Koekjes',        emoji: '🍪' };
  if (/chips|popcorn|pretzels/.test(s))        return { cat: 'Chips & snacks', emoji: '🥨' };
  if (/snoep|gummy|drop/.test(s))              return { cat: 'Snoep',          emoji: '🍬' };
  if (/noten|amandelen|cashew|pistache/.test(s)) return { cat: 'Noten',        emoji: '🥜' };
  if (/jam|confituur|honing|siroop/.test(s))   return { cat: 'Beleg',          emoji: '🍯' };
  if (/diepvries|frozen/.test(s))              return { cat: 'Diepvries',      emoji: '❄️' };
  if (/tortilla|tapas|serrano|hummus/.test(s)) return { cat: 'Internationaal', emoji: '🌍' };
  if (/shampoo|douchegel|zeep|tandpasta/.test(s)) return { cat: 'Verzorging',  emoji: '🧴' };
  if (/wasmiddel|afwasmiddel|schoonmaakmiddel/.test(s)) return { cat: 'Schoonmaak', emoji: '🧹' };
  return { cat: 'Aanbieding', emoji: '🛒' };
}

// ── Cache ─────────────────────────────────────────────────────────────────────
function loadCache() {
  try { return fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : {}; }
  catch { return {}; }
}
function saveCache(data) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2)); } catch {}
}

// ── Warmup: pool alvast ophalen bij opstarten ─────────────────────────────────
let warmupPromise = null;

async function warmupPool(lang = 'nl') {
  const cache    = loadCache();
  const poolKey  = `__pool:${lang}`;
  const dateKey  = `__poolDate:${lang}`;
  const poolAge  = cache[dateKey]
    ? Math.floor((Date.now() - cache[dateKey]) / 86400000) : 99;
  if (cache[poolKey] && cache[poolKey].length >= 10 && poolAge < 7) {
    console.log(`Pool al gecached: ${cache[poolKey].length} producten`);
    return;
  }
  console.log('Opwarmen: productpool ophalen…');
  cache[poolKey] = await fetchProductPool(lang);
  cache[dateKey] = Date.now();
  saveCache(cache);
  console.log(`Opgewarmd: ${cache[poolKey].length} producten klaar`);
}

// ── Product van de dag ────────────────────────────────────────────────────────
async function getProductOfDay(dateKey, lang = 'nl') {
  // Wacht tot warmup klaar is (als die nog bezig is)
  if (warmupPromise) await warmupPromise.catch(() => {});

  const cache    = loadCache();
  const cacheKey = `${lang}:${dateKey}`;
  if (cache[cacheKey]) return cache[cacheKey];

  const poolKey     = `__pool:${lang}`;
  const poolDateKey = `__poolDate:${lang}`;
  const poolAge     = cache[poolDateKey]
    ? Math.floor((Date.now() - cache[poolDateKey]) / 86400000) : 99;
  if (!cache[poolKey] || cache[poolKey].length < 10 || poolAge >= 7) {
    console.log(`Productpool vernieuwen (${lang})…`);
    cache[poolKey]     = await fetchProductPool(lang);
    cache[poolDateKey] = Date.now();
    if (!cache[poolKey].length) throw new Error(`Geen producten gevonden op aldi.be/${lang}`);
    saveCache(cache);
  }

  // Deterministisch product kiezen op basis van datum
  const rng = seededRandom(dateToSeed(dateKey));
  let product = null;
  let tries   = 0;

  // Maximaal 5 kandidaten proberen als scrapen mislukt of geen prijs
  while (!product && tries < 5) {
    const idx = Math.floor(rng() * cache[poolKey].length);
    const url  = cache[poolKey][(idx + tries) % cache[poolKey].length];
    tries++;
    try {
      console.log(`Product ophalen (${lang}, poging ${tries}): ${url}`);
      const p = await scrapeProduct(url);
      if (p.name && p.price > 0) product = p;
      else console.log(`  → geen prijs gevonden, volgende proberen`);
    } catch (e) {
      console.log(`  → fout: ${e.message}`);
    }
  }

  if (!product) throw new Error('Kon geen geldig product ophalen na 5 pogingen');
  cache[cacheKey] = product;
  saveCache(cache);
  return product;
}

// ── Express ───────────────────────────────────────────────────────────────────
app.use((_, res, next) => { res.header('Access-Control-Allow-Origin', '*'); next(); });

app.get('/api/product', async (req, res) => {
  const dateKey = req.query.date || getTodayKey();
  const lang = req.query.lang || 'nl';
  try {
    const product = await getProductOfDay(dateKey, lang);
    res.json(product);
  } catch (err) {
    console.error('Fout:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(__dirname));
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'Aldidle.html')));

app.listen(PORT, () => {
  console.log(`\n✅  Aldidle draait op http://localhost:${PORT}\n`);
  warmupPromise = warmupPool('nl').catch(e => console.error('Warmup mislukt:', e.message));
});
