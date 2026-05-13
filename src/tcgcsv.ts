import axios from 'axios';
import { PriceEntry, Rarity } from './types';

// Pokemon's category ID on TCGCSV (tcgcsv.com/tcgplayer/3/...).
const CATEGORY_ID = 3;

// All rarities that appear in Pokemon SV / ME era TCGCSV data.
// "Rare" (not "Rare Holo") is the base holo rare in SV+ sets.
const VALID_RARITIES = new Set<string>([
  'Common', 'Uncommon', 'Rare',
  'Double Rare', 'Ultra Rare',
  'Illustration Rare', 'Special Illustration Rare',
  'Hyper Rare', 'ACE SPEC Rare', 'Mega Hyper Rare',
  'Poke Ball Holo', 'Master Ball Holo',
  'Shiny Rare', 'Shiny Ultra Rare',  // Paldean Fates
  'Mega Attack Rare',                 // Ascended Heroes
]);

export interface ExtendedDataEntry {
  name: string;
  displayName: string;
  value: string;
}

export interface TCGProduct {
  productId: number;
  name: string;
  cleanName?: string;
  imageUrl?: string;
  extendedData?: ExtendedDataEntry[];
}

export interface TCGPrice {
  productId: number;
  subTypeName: string;
  lowPrice: number | null;
  midPrice: number | null;
  highPrice: number | null;
  marketPrice: number | null;
}

function extractRarity(extendedData: ExtendedDataEntry[] = []): Rarity | null {
  const entry = extendedData.find((e) => e.name === 'Rarity');
  if (!entry || !VALID_RARITIES.has(entry.value)) return null;
  return entry.value as Rarity;
}

const HEADERS = { 'User-Agent': 'pokemon-ev/1.0' };

/**
 * Fetch all products (cards + sealed products) for a Pokemon set from TCGCSV.
 * @param groupId - TCGCSV group ID for the set (see sets.ts for the full list)
 */
export async function fetchProducts(groupId: number): Promise<TCGProduct[]> {
  console.log('  [tcgcsv] Fetching products…');
  const base = `https://tcgcsv.com/tcgplayer/${CATEGORY_ID}/${groupId}`;
  const res = await axios.get<{ results: TCGProduct[] }>(`${base}/products`, { timeout: 15000, headers: HEADERS });
  return res.data.results ?? [];
}

/**
 * Fetch current market prices for all products in a Pokemon set from TCGCSV.
 * Each product may have multiple price rows (Normal, Holofoil, Reverse Holofoil).
 * @param groupId - TCGCSV group ID for the set
 */
export async function fetchPrices(groupId: number): Promise<TCGPrice[]> {
  console.log('  [tcgcsv] Fetching prices…');
  const base = `https://tcgcsv.com/tcgplayer/${CATEGORY_ID}/${groupId}`;
  const res = await axios.get<{ results: TCGPrice[] }>(`${base}/prices`, { timeout: 15000, headers: HEADERS });
  return res.data.results ?? [];
}

/**
 * Derives the Pokemon card list from TCGCSV product data.
 * Products with a valid Rarity in extendedData are individual cards;
 * sealed products (booster packs, boxes) have no Rarity and are skipped.
 */
export function extractCards(products: TCGProduct[]): { name: string; rarity: Rarity }[] {
  const cards: { name: string; rarity: Rarity }[] = [];
  for (const product of products) {
    const rarity = extractRarity(product.extendedData);
    if (!rarity) continue;
    cards.push({ name: product.name, rarity });
  }
  return cards;
}

/**
 * Builds a pre-keyed price map from the raw prices array.
 * Key format: `${productId}::${subTypeName}`
 */
export function buildPriceMap(prices: TCGPrice[]): Map<string, TCGPrice> {
  const map = new Map<string, TCGPrice>();
  for (const p of prices) {
    map.set(`${p.productId}::${p.subTypeName}`, p);
  }
  return map;
}

/**
 * Builds PriceEntry[] by joining products (which carry rarity via extendedData)
 * with prices by productId.
 *
 * Special handling:
 * 1. Ball-pattern cards (e.g. "Pikachu (Poke Ball Pattern)") — detected by name regex
 *    FIRST, emitted as Poke Ball Holo / Master Ball Holo with Reverse Holofoil subType.
 *
 * 2. Holofoil fallback — ex / V / Double Rare+ cards only have a "Holofoil" subType on
 *    TCGCSV (they don't have a Normal print). We store their price under subType="Normal"
 *    so the calculator can treat them uniformly. The fallback order is: Normal ?? Holofoil.
 *
 * 3. Reverse Holofoil — Common/Uncommon/Rare cards also appear with a Reverse Holofoil
 *    price, emitted as a separate entry with subType="Reverse Holofoil".
 */
export function matchPrices(products: TCGProduct[], prices: TCGPrice[]): PriceEntry[] {
  const priceMap = buildPriceMap(prices);
  const entries: PriceEntry[] = [];

  for (const product of products) {
    const rarity = extractRarity(product.extendedData);
    if (!rarity) continue; // skip sealed products

    const image = product.imageUrl ?? undefined;

    // ── 1. Ball-pattern holos ──────────────────────────────────────────────
    // Must run BEFORE Normal/Holofoil fallback — pattern cards appear under
    // 'Holofoil' on TCGCSV but are physically reverse-holo prints.
    const ballPattern = product.name.match(/\((.+?) Pattern\)$/);
    if (ballPattern) {
      const isMasterBall = ballPattern[1] === 'Master Ball';
      const patternRarity: Rarity = isMasterBall ? 'Master Ball Holo' : 'Poke Ball Holo';
      const hp = priceMap.get(`${product.productId}::Holofoil`);
      if (hp) {
        const marketPrice = hp.marketPrice ?? 0;
        const midPrice    = hp.midPrice    ?? 0;
        if (marketPrice > 0 || midPrice > 0) {
          entries.push({ productId: product.productId, name: product.name, rarity: patternRarity, subType: 'Reverse Holofoil', marketPrice, midPrice, image });
        }
      }
      continue; // pattern cards have no Normal or separate RH entry
    }

    // ── 2. Normal / Holofoil fallback (stored as subType 'Normal') ─────────
    const normalPrice = priceMap.get(`${product.productId}::Normal`);
    const holoPrice   = priceMap.get(`${product.productId}::Holofoil`);
    const effectivePrice = normalPrice ?? holoPrice;
    if (effectivePrice) {
      const marketPrice = effectivePrice.marketPrice ?? 0;
      const midPrice    = effectivePrice.midPrice    ?? 0;
      if (marketPrice > 0 || midPrice > 0) {
        entries.push({ productId: product.productId, name: product.name, rarity, subType: 'Normal', marketPrice, midPrice, image });
      }
    }

    // ── 3. Reverse Holofoil (separate entry, real RH price) ────────────────
    const rhPrice = priceMap.get(`${product.productId}::Reverse Holofoil`);
    if (rhPrice) {
      const marketPrice = rhPrice.marketPrice ?? 0;
      const midPrice    = rhPrice.midPrice    ?? 0;
      if (marketPrice > 0 || midPrice > 0) {
        entries.push({ productId: product.productId, name: product.name, rarity, subType: 'Reverse Holofoil', marketPrice, midPrice, image });
      }
    }
  }

  return entries;
}
