// Builds src/data/catalog.json: a browsable catalog of LEGO sets and IKEA products,
// each verified to have downloadable instructions. Run: node scripts/build-catalog.mjs

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";
const PER_THEME = 8;
const decode = (s) => s.replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/®|™/g, "").trim();

// Candidate set numbers by theme. Ones without instructions on lego.com get dropped.
const LEGO_CANDIDATES = {
  Creator: [31163, 31153, 31159, 31152, 31155, 31156, 31157, 31158, 31160, 31161, 31162, 31164, 31165, 31166, 31139, 31141, 31142, 31144, 31145, 31146, 31147, 31148, 31149, 31150, 31151],
  City: [60398, 60402, 60403, 60404, 60405, 60406, 60407, 60408, 60409, 60410, 60411, 60412, 60413, 60414, 60415, 60416, 60417, 60418, 60419, 60420, 60421, 60422, 60423, 60424],
  Technic: [42151, 42152, 42153, 42154, 42155, 42156, 42157, 42158, 42159, 42160, 42161, 42162, 42163, 42164, 42165, 42166, 42167, 42168, 42169, 42170, 42171, 42172, 42173],
  Icons: [10311, 10313, 10314, 10328, 10329, 10342, 10343, 10280, 10281, 10289, 10309, 10316, 10317, 10318, 10320, 10321, 10323, 10325, 10326, 10327, 10330, 10331, 10332, 10333],
  "Star Wars": [75375, 75376, 75377, 75378, 75379, 75380, 75381, 75382, 75383, 75384, 75385, 75386, 75387, 75388, 75389, 75390, 75391, 75392, 75393, 75394],
  Ideas: [21345, 21346, 21347, 21348, 21349, 21350, 21351, 21352, 21353, 21354],
  Architecture: [21058, 21060, 21061, 21062, 21063, 21064],
  "Harry Potter": [76426, 76427, 76428, 76429, 76430, 76431, 76432, 76433, 76434, 76435],
  Minecraft: [21250, 21251, 21252, 21253, 21254, 21255, 21256, 21257, 21258, 21259, 21260, 21261, 21262, 21263, 21264, 21265],
  Friends: [42630, 42631, 42632, 42633, 42634, 42635, 42636, 42637, 42638, 42639, 42640],
  "Speed Champions": [76921, 76922, 76923, 76924, 76925, 76926, 76927, 76928, 76929, 76930],
  Classic: [11030, 11031, 11032, 11033, 11034, 11035, 11036, 11037, 11038, 11039, 11040],
};

const IKEA_QUERIES = [
  "lack side table", "lack coffee table", "kallax shelf unit", "billy bookcase", "malm 3-drawer chest", "hemnes 3-drawer chest",
  "alex drawer unit", "linnmon tabletop", "micke desk", "lagkapten tabletop", "ingo table", "lerhamn table",
  "poang armchair", "frosta stool", "bekvam step stool", "sniglar crib", "flisat children's table", "trofast storage frame",
  "ivar shelving unit", "brimnes bed frame", "malm bed frame", "tarva bed frame", "hauga 6-drawer dresser", "nordli 8-drawer dresser",
  "rast 3-drawer chest", "gursken chest of drawers", "vittsjo shelving unit", "fjallbo shelf unit", "tonstad sideboard", "idanas wardrobe",
  "stuva storage combination", "pax wardrobe frame", "hemnes shoe cabinet", "kullen 3-drawer chest", "mittzon desk", "gladom tray table",
  "vihals shelving unit", "baggebo shelf unit", "tjusig bench", "bror shelving unit",
];

// Retries with backoff: lego.com throttles bursts of requests.
async function get(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { "User-Agent": UA } }).catch(() => null);
    if (res?.ok) return res;
    if (res && res.status === 404) return null;
    await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
  }
  return null;
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const i = next++;
        try {
          out[i] = await fn(items[i]);
        } catch {
          out[i] = null;
        }
      }
    }),
  );
  return out;
}

const THEME_NAMES = { MINECRAFT: "Minecraft", "3in1": "Creator", "Creator 3in1": "Creator", Trains: "City", "Botanical Collection": "Botanicals" };
const tidyTheme = (t) => THEME_NAMES[t] ?? t;

const coverOf = (fileId) => `https://www.lego.com/cdn/product-assets/product.bi.core.img/${fileId}.png?format=webply&fit=crop&quality=75&width=400&height=400`;

// The set's product photo, as the page itself references it (older sets use other file names).
function productImage(html) {
  const src = html.match(/https:\/\/www\.lego\.com\/cdn\/product-assets\/product\.img\.pri\/[^"?\s]+/)?.[0];
  return src ? `${src}?format=webply&fit=bounds&quality=75&width=480&height=480` : null;
}

async function imageOk(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } }).catch(() => null);
  return Boolean(res?.ok && res.headers.get("content-type")?.startsWith("image/"));
}

async function legoSet(theme, set) {
  const res = await get(`https://www.lego.com/en-us/service/buildinginstructions/${set}`);
  if (!res) return null;
  const html = await res.text();

  const card = /<h3[^>]*>([^<]+)<\/h3><p[^>]*>([^<]*)<\/p><\/div><a href="https:\/\/www\.lego\.com\/cdn\/product-assets\/product\.bi\.core\.pdf\/(\d+)\.pdf"/g;
  const books = [...html.matchAll(card)].map(([, name, size, fileId]) => {
    const b = decode(name).match(/\((\d+)\/(\d+)\)\s*$/);
    return { label: b ? `Book ${b[1]} of ${b[2]}` : "Instructions", size: decode(size).replace(/\s*\(PDF\)/i, ""), fileId };
  });
  if (!books.length) return null;

  // Product header text, e.g. "LEGO Creator | Playful Cat | 8+ | #31163 | 407 pieces | Year: 2025"
  const tokens = html.replace(/<[^>]+>/g, "|").split("|").map((t) => decode(t)).filter(Boolean);
  const at = tokens.findIndex((t) => t === `#${set}`);
  if (at < 2) return null;
  const pieces = Number(tokens.slice(at, at + 4).join(" ").match(/(\d[\d,]*) pieces/)?.[1].replace(/,/g, ""));
  const year = Number(tokens.slice(at, at + 5).join(" ").match(/Year:\s*(\d{4})/)?.[1]);
  return {
    id: `lego-${set}`,
    source: "lego",
    set: String(set),
    name: tokens[at - 2],
    // Theme as LEGO states it ("LEGO Creator" -> "Creator"); fall back to our grouping.
    category: tidyTheme(tokens[at - 3]?.replace(/^LEGO\s*/i, "").trim() || theme),
    age: tokens[at - 1],
    pieces: Number.isFinite(pieces) ? pieces : undefined,
    year: Number.isFinite(year) ? year : undefined,
    image: productImage(html) ?? coverOf(books[0].fileId),
    manuals: books.map((b) => ({ label: b.label, size: b.size, pdfPath: `/manual-pdf/lego/${b.fileId}.pdf`, coverUrl: coverOf(b.fileId) })),
  };
}

function ikeaCategory(type) {
  const t = type.toLowerCase();
  if (/child|crib|toddler|junior/.test(t)) return "Kids";
  if (/bed/.test(t)) return "Beds";
  if (/chair|stool|bench|armchair|sofa/.test(t)) return "Seating";
  if (/table|desk|tabletop/.test(t)) return "Tables & desks";
  return "Storage";
}

async function ikeaProduct(query) {
  const url = `https://sik.search.blue.cdtapps.com/us/en/search-result-page?q=${encodeURIComponent(query)}&size=5&types=PRODUCT`;
  const data = await (await fetch(url, { headers: { "User-Agent": UA } })).json();
  for (const { product: p } of data?.searchResultPage?.products?.main?.items ?? []) {
    if (!p?.pipUrl?.startsWith("https://www.ikea.com/") || !p.mainImageUrl) continue;
    const html = await (await fetch(p.pipUrl, { headers: { "User-Agent": UA } })).text();
    const all = [...new Set(html.match(/https:\/\/www\.ikea\.com\/[^"\s]*assembly_instructions\/[^"\s]+\.pdf/g) ?? [])];
    const slug = p.name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const own = all.filter((u) => u.split("/assembly_instructions/")[1]?.startsWith(slug));
    if (!own.length) continue;
    const name = p.name.charAt(0) + p.name.slice(1).toLowerCase();
    return {
      id: `ikea-${p.itemNo}`,
      source: "ikea",
      itemNo: p.itemNo,
      name: `${name} ${p.typeName.toLowerCase()}`,
      category: ikeaCategory(p.typeName),
      image: p.mainImageUrl,
      manuals: own.map((u, i) => ({ label: own.length > 1 ? `Part ${i + 1} of ${own.length}` : "Assembly instructions", pdfPath: `/manual-pdf/ikea/${u.slice("https://www.ikea.com/".length)}` })),
    };
  }
  return null;
}

// Cache of everything found so far: lego.com throttles, so each run only re-checks what's missing.
const CACHE = "scripts/catalog-cache.json";
const cache = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : { lego: {}, ikea: {} };
if (!existsSync(CACHE) && existsSync("src/data/catalog.json")) {
  const prev = JSON.parse(readFileSync("src/data/catalog.json", "utf8"));
  for (const s of prev.lego) cache.lego[s.set] = s;
  for (const p of prev.ikea) cache.ikea[p.query ?? p.id] = p;
}

const legoJobs = Object.entries(LEGO_CANDIDATES).flatMap(([theme, sets]) => sets.map((s) => [theme, s])).filter(([, s]) => !cache.lego[s]);
const ikeaJobs = IKEA_QUERIES.filter((q) => !cache.ikea[q] && !Object.values(cache.ikea).some((p) => p.query === q));
console.log(`Checking ${legoJobs.length} LEGO sets and ${ikeaJobs.length} IKEA products not yet cached…`);
const legoFound = await pool(legoJobs, 3, ([theme, set]) => legoSet(theme, set));
legoJobs.forEach(([, set], i) => legoFound[i] && (cache.lego[set] = legoFound[i]));
const ikeaFound = await pool(ikeaJobs, 4, ikeaProduct);
ikeaJobs.forEach((q, i) => ikeaFound[i] && (cache.ikea[q] = { ...ikeaFound[i], query: q }));
writeFileSync(CACHE, JSON.stringify(cache));

// Repair cached LEGO photos that don't load: use the page's real photo, else the book cover.
await pool(Object.values(cache.lego), 4, async (item) => {
  if (await imageOk(item.image)) return;
  const res = await get(`https://www.lego.com/en-us/service/buildinginstructions/${item.set}`);
  const found = res && productImage(await res.text());
  item.image = found && (await imageOk(found)) ? found : item.manuals[0].coverUrl;
});
writeFileSync(CACHE, JSON.stringify(cache));

const legoAll = Object.values(cache.lego);
const ikeaAll = Object.values(cache.ikea);

// Keep the newest few per theme so every theme shows variety.
const themes = [...new Set(legoAll.map((s) => s.category))];
const lego = themes.flatMap((theme) =>
  legoAll.filter((s) => s.category === theme).sort((a, b) => (b.year ?? 0) - (a.year ?? 0)).slice(0, PER_THEME),
);
const seen = new Set();
const ikea = ikeaAll.filter((p) => !seen.has(p.id) && seen.add(p.id));

mkdirSync("src/data", { recursive: true });
writeFileSync("src/data/catalog.json", JSON.stringify({ builtAt: new Date().toISOString(), lego, ikea }, null, 1));
console.log(`LEGO: ${legoAll.length} found, ${lego.length} kept across ${new Set(lego.map((s) => s.category)).size} themes. IKEA: ${ikea.length}.`);
