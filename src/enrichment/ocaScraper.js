/**
 * OCA (Orthodox Church in America) clergy directory scraper.
 * Source: https://www.oca.org/clergy/state/{STATE}
 * Data available: clergy name, title, parish, city, state, phone, (email obfuscated)
 */
const axios  = require('axios');
const cheerio = require('cheerio');

// ── TIME ZONES ────────────────────────────────────────────────────────────────
const TIMEZONES = {
  eastern: {
    label: '🌅 Eastern Time (ET)',
    states: ['ME','VT','NH','MA','CT','RI','NY','NJ','PA','DE','MD','DC',
             'VA','WV','NC','SC','GA','FL','OH','MI','IN','KY','TN'],
  },
  central: {
    label: '🌄 Central Time (CT)',
    states: ['WI','IL','MN','IA','MO','ND','SD','NE','KS','OK','TX',
             'LA','MS','AL','AR'],
  },
  mountain: {
    label: '🏔 Mountain Time (MT)',
    states: ['MT','WY','CO','NM','AZ','UT','ID'],
  },
  pacific: {
    label: '🌊 Pacific Time (PT)',
    states: ['WA','OR','CA','NV'],
  },
  alaska: {
    label: '🌨 Alaska (AKT)',
    states: ['AK'],
  },
  hawaii: {
    label: '🌺 Hawaii (HT)',
    states: ['HI'],
  },
  all: {
    label: '🇺🇸 All USA States',
    states: ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID',
             'IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS',
             'MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK',
             'OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV',
             'WI','WY','DC'],
  },
};

const STATE_NAMES = {
  AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',
  CO:'Colorado',CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',
  HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',
  KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',
  MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',
  MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',
  NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',
  OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',
  SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',
  VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',
  DC:'Washington D.C.',
};

// Build reverse map: state → timezone
const STATE_TIMEZONE = {};
Object.entries(TIMEZONES).forEach(([tz, { states }]) => {
  if (tz !== 'all') states.forEach(s => { STATE_TIMEZONE[s] = tz; });
});

// ── SCRAPER ────────────────────────────────────────────────────────────────────
async function scrapeStateClergy(state) {
  const url = `https://www.oca.org/clergy/state/${state}`;
  try {
    const res = await axios.get(url, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    return parseClergy(res.data, state);
  } catch (err) {
    console.error(`[ocaScraper] Failed state ${state}: ${err.message}`);
    return [];
  }
}

// ── PARSER ─────────────────────────────────────────────────────────────────────
function parseClergy(html, state) {
  const $ = cheerio.load(html);
  const results = [];
  const seen   = new Set();

  $('a[href^="/parishes/"]').each((_, parishEl) => {
    const $parish = $(parishEl);

    // Skip header / nav / footer / breadcrumb links
    if ($parish.closest('nav,header,footer,.breadcrumbs,.site-nav,.nav-bar').length) return;

    const parishName = $parish.text().trim();
    const parishPath = $parish.attr('href') || '';
    const parishId   = parishPath.replace('/parishes/', '').toLowerCase();

    if (!parishName || parishName.length < 3 || seen.has(parishId)) return;
    seen.add(parishId);

    // ── Walk up DOM to find the container block for this clergy entry ──
    // Stop when we find a phone number OR when the parent would contain other entries
    let $block    = $parish.parent();
    let blockText = $block.text();

    for (let depth = 0; depth < 7; depth++) {
      if (/\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/.test(blockText)) break;
      const $up = $block.parent();
      if (!$up.length || $up.is('html,body,main,[role="main"]')) break;
      // Don't go up if the parent contains 3+ separate parish links (would merge entries)
      if ($up.find('a[href^="/parishes/"]').length > 3) break;
      $block    = $up;
      blockText = $block.text();
    }

    const fullText = blockText.replace(/[\r\n]+/g, ' ').replace(/\s{2,}/g, ' ').trim();

    // ── Phone ──
    const phoneMatch = fullText.match(/(\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4})/);
    const phone = phoneMatch
      ? phoneMatch[1].replace(/[\s.]/g, '-').trim()
      : null;

    // ── City ──
    const stateFullNames = Object.values(STATE_NAMES).join('|');
    const cityRx  = new RegExp(`([A-Za-z][A-Za-z .'-]+?),\\s+(?:${stateFullNames})`, 'i');
    const cityMatch = fullText.match(cityRx);
    const city    = cityMatch ? cityMatch[1].trim() : null;

    // ── Clergy name ──
    // Format on OCA site: "LastName, V. Rev. FirstName" or "LastName, Rev. FirstName" etc.
    const titlePart = '(?:V\\.\\s*Rev\\.|Very\\s+Rev\\.|Rev\\.\\s+Dn\\.|Archpriest|Protodeacon|Proto-deacon|Rev\\.|Fr\\.|Dn\\.|Dcn\\.|Hierodeacon|Hieromonk|Archimandrite|Bishop|Archbishop)';
    const nameRx = new RegExp(
      `([A-Z][a-z'\\-]+,\\s+${titlePart}\\s+[A-Za-z][A-Za-z\\s.'\\-]+?)` +
      `(?:\\s{2,}|Retired|On\\s+Leave|Widowed|$)`,
    );
    const nameMatch = fullText.match(nameRx);

    // Convert "LastName, Title FirstName" → "Title FirstName LastName"
    let clergyName  = null;
    let clergyTitle = 'Priest';
    if (nameMatch) {
      const raw   = nameMatch[1].trim();
      const parts = raw.match(/^([^,]+),\s+(.+)$/);
      if (parts) {
        clergyName  = `${parts[2].trim()} ${parts[1].trim()}`;
        // Extract the title portion
        const titleMatch = parts[2].trim().match(new RegExp(`^(${titlePart})`, 'i'));
        if (titleMatch) clergyTitle = titleMatch[1].trim();
      } else {
        clergyName = raw;
      }
    }

    // ── Status ──
    const statusMatch = fullText.match(/\b(Retired|On Leave|Widowed Priest|Temporary Assignment)\b/i);
    const status = statusMatch ? statusMatch[1] : null;

    results.push({
      parishName,
      parishId,
      state,
      stateName: STATE_NAMES[state] || state,
      city,
      phone,
      clergyName,
      clergyTitle: status ? `${clergyTitle} (${status})` : clergyTitle,
      denomination: 'OCA',
      timezone: STATE_TIMEZONE[state] || 'eastern',
      source: 'directory-oca',
    });
  });

  return results;
}

module.exports = { TIMEZONES, STATE_NAMES, STATE_TIMEZONE, scrapeStateClergy };
