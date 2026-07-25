// Shared store registry — used by the landing page, the game, and the server.
//
// A "store" is a brand you can play (Aldi, Albert Heijn, …). It groups one or
// more scraping "markets" (be, de-nord, ah-be, …) that live in server.js and in
// the game's own MARKETS table. Add a store here and it appears on the landing
// page, gets its own /<slug> URL, and is shareable — no other wiring needed.
//
//   slug          : URL segment → winkle.daiza.be/<slug> (keep stable; it's shared)
//   name          : display name
//   logo          : short wordmark shown on the landing tile + game header
//   markets        : market ids this store offers (must exist in the MARKETS tables)
//   defaultMarket : the market selected first
//   color / accent: brand colours for the landing tile
(function (root) {
  const STORES = {
    aldi: {
      slug: 'aldi', name: 'Aldi', logo: 'ALDI',
      markets: ['be', 'de-nord', 'de-sued'], defaultMarket: 'be',
      color: '#003087', accent: '#E2001A',
    },
    albertheijn: {
      slug: 'albertheijn', name: 'Albert Heijn', logo: 'AH',
      markets: ['ah-be'], defaultMarket: 'ah-be',
      color: '#0091d4', accent: '#ffffff',
    },
    hubo: {
      slug: 'hubo', name: 'Hubo', logo: 'HUBO',
      markets: ['hubo-be'], defaultMarket: 'hubo-be',
      color: '#001D85', accent: '#D33641',
    },
    ikea: {
      slug: 'ikea', name: 'IKEA', logo: 'IKEA',
      markets: ['ikea-be'], defaultMarket: 'ikea-be',
      color: '#0058A3', accent: '#FFDB00',
    },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = { STORES };
  else root.STORES = STORES;
})(typeof window !== 'undefined' ? window : this);
