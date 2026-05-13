import { PriceEntry, Rarity, EvResult, RarityStats, SlotBreakdown, HitRarityBreakdown } from './types';

/**
 * Pull-rate config shape for a Pokemon set.
 *
 * Distributions are probabilities per pack (not per slot), empirically derived
 * from community data.
 *
 * Slot breakdown per pack:
 *   commonCount  × Common Normal
 *   uncommonCount × Uncommon Normal
 *   1 × Reverse Holofoil (rarity from reverseHoloDistribution)
 *   1 × Hit slot (rarity from hitDistribution, stored as subType='Normal' via Holofoil fallback)
 */
interface PullRates {
  packsPerBox: number;
  commonCount: number;
  uncommonCount: number;
  /**
   * Fractions (sum ≈ 1.0) for the single reverse-holo slot.
   * Keys are rarity names: "Common", "Uncommon", "Rare",
   * and optionally "Poke Ball Holo", "Master Ball Holo" for pattern sets.
   */
  reverseHoloDistribution: Record<string, number>;
  /**
   * Probabilities per pack for hit-slot rarities:
   * "Rare", "Double Rare", "Ultra Rare", "Illustration Rare",
   * "Special Illustration Rare", "Hyper Rare", "ACE SPEC Rare", "Mega Hyper Rare"
   */
  hitDistribution: Record<string, number>;
}

/**
 * Per-card threshold separating "individually sellable" from "bulk-only".
 * TCGPlayer Market prices embed ~$0.50 of single-sale overhead (fees + shipping);
 * cards below this threshold are realistically sold to bulk buyers at the
 * going rate (~$0.01/card). EV math uses this realizable value, not the
 * inflated single-sale list price.
 */
const BULK_THRESHOLD = 0.50;
const BULK_RATE      = 0.01;

/** Realizable effective price for EV math: prefer marketPrice, fall back to
 *  midPrice, then clamp sub-threshold prices to the bulk rate. */
function effectivePrice(entry: PriceEntry): number {
  const raw = entry.marketPrice > 0 ? entry.marketPrice : entry.midPrice;
  return raw >= BULK_THRESHOLD ? raw : BULK_RATE;
}

/** Average effective price over a list of entries. Returns null if empty. */
function avgPrice(entries: PriceEntry[]): number | null {
  if (entries.length === 0) return null;
  return entries.reduce((sum, e) => sum + effectivePrice(e), 0) / entries.length;
}

/**
 * Groups entries by rarity × subType.
 * Key format: `${rarity}::${subType}`
 */
function groupEntries(entries: PriceEntry[]): Map<string, PriceEntry[]> {
  const map = new Map<string, PriceEntry[]>();
  for (const entry of entries) {
    const key = `${entry.rarity ?? 'Unknown'}::${entry.subType}`;
    const existing = map.get(key) ?? [];
    existing.push(entry);
    map.set(key, existing);
  }
  return map;
}

function getGroup(grouped: Map<string, PriceEntry[]>, rarity: string, subType: string): PriceEntry[] {
  return grouped.get(`${rarity}::${subType}`) ?? [];
}

// All Pokemon rarities shown in byRarity breakdown (SV + ME era).
const ALL_RARITIES: Rarity[] = [
  'Common', 'Uncommon', 'Rare',
  'Double Rare', 'Ultra Rare',
  'Illustration Rare', 'Special Illustration Rare',
  'Hyper Rare', 'ACE SPEC Rare', 'Mega Hyper Rare',
  'Poke Ball Holo', 'Master Ball Holo',
  'Shiny Rare', 'Shiny Ultra Rare',  // Paldean Fates
  'Mega Attack Rare',                 // Ascended Heroes
];

/**
 * Calculate expected value (EV) for a Pokemon booster box.
 *
 * Pack structure per box:
 *   commonCount  × Normal Common  (uniform over all Normal Common cards in set)
 *   uncommonCount × Normal Uncommon (uniform over all Normal Uncommon cards)
 *   1 × Reverse Holofoil           (weighted by reverseHoloDistribution)
 *   1 × Hit slot                   (weighted by hitDistribution; prices via Holofoil fallback)
 *
 * @param entries     - Priced card entries from matchPrices()
 * @param pullRates   - Slot config from the set's pull-rates-{id}.json
 * @param boxCost     - Current retail price of the box in USD
 */
export function calculateEV(
  entries: PriceEntry[],
  pullRates: PullRates,
  boxCost: number,
): EvResult {
  const grouped = groupEntries(entries);
  const { packsPerBox, commonCount, uncommonCount, reverseHoloDistribution, hitDistribution } = pullRates;

  // ── Per-rarity stats ──────────────────────────────────────────────────────
  const byRarity: Record<string, RarityStats> = {};
  for (const rarity of ALL_RARITIES) {
    const normalGroup = getGroup(grouped, rarity, 'Normal');
    const rhGroup     = getGroup(grouped, rarity, 'Reverse Holofoil');
    byRarity[rarity] = {
      rarity,
      avgNormalPrice: avgPrice(normalGroup),
      avgRhPrice:     avgPrice(rhGroup),
      normalPriced:   normalGroup.length,
      normalTotal:    0,  // populated after extractCards total is known
      rhPriced:       rhGroup.length,
      rhTotal:        0,
      evContribution: 0,
    };
  }

  // ── Common slot ───────────────────────────────────────────────────────────
  const commonEv = commonCount * (byRarity['Common']?.avgNormalPrice ?? 0);
  if (byRarity['Common']) byRarity['Common'].evContribution += commonEv;

  // ── Uncommon slot ─────────────────────────────────────────────────────────
  const uncommonEv = uncommonCount * (byRarity['Uncommon']?.avgNormalPrice ?? 0);
  if (byRarity['Uncommon']) byRarity['Uncommon'].evContribution += uncommonEv;

  // ── Reverse Holo slot ─────────────────────────────────────────────────────
  // Each pack has one RH slot: the rarity is drawn from reverseHoloDistribution.
  // Pattern holos (Poke Ball / Master Ball) are separate rarity keys in the distribution.
  let reverseHoloEv = 0;
  for (const [rarity, fraction] of Object.entries(reverseHoloDistribution)) {
    const avg = byRarity[rarity]?.avgRhPrice ?? 0;
    const ev  = fraction * avg;
    reverseHoloEv += ev;
    if (byRarity[rarity]) byRarity[rarity].evContribution += ev;
  }

  // ── Hit slot ──────────────────────────────────────────────────────────────
  // hitDistribution values are P(rarity per pack), stored as subType='Normal'
  // (via Holofoil fallback in tcgcsv.ts for ex/V/IR/SIR/HR cards).
  let hitEv = 0;
  const hitBreakdown: Record<string, HitRarityBreakdown> = {};
  for (const [rarity, fraction] of Object.entries(hitDistribution)) {
    const avgPrice = byRarity[rarity]?.avgNormalPrice ?? null;
    const ev       = fraction * (avgPrice ?? 0);
    hitEv += ev;
    if (byRarity[rarity]) byRarity[rarity].evContribution += ev;
    hitBreakdown[rarity] = { fraction, avgPrice, evPerBox: ev * packsPerBox };
  }

  const slotBreakdown: SlotBreakdown = { commonEv, uncommonEv, reverseHoloEv, hitEv };
  const evPerPack = commonEv + uncommonEv + reverseHoloEv + hitEv;
  const evPerBox  = evPerPack * packsPerBox;

  // ── Top pulls ─────────────────────────────────────────────────────────────
  // topHoloPulls: Holofoil-finish cards (hit-slot rarities) — stored as subType='Normal'
  //   via the Holofoil fallback. Excludes Common/Uncommon/Rare (which are the RH slot).
  const hitRarities = new Set<Rarity>([
    'Double Rare', 'Ultra Rare',
    'Illustration Rare', 'Special Illustration Rare',
    'Hyper Rare', 'ACE SPEC Rare', 'Mega Hyper Rare',
    'Rare',  // include base Rare for completeness (some are worth >$1)
  ]);

  const topHoloPulls = entries
    .filter(e => e.subType === 'Normal' && hitRarities.has(e.rarity as Rarity) && effectivePrice(e) >= 1.0)
    .sort((a, b) => effectivePrice(b) - effectivePrice(a))
    .slice(0, 20);

  const topReverseHoloPulls = entries
    .filter(e => e.subType === 'Reverse Holofoil' && effectivePrice(e) >= 1.0)
    .sort((a, b) => effectivePrice(b) - effectivePrice(a))
    .slice(0, 20);

  return {
    evPerPack,
    evPerBox,
    boxCost,
    boxPriceSource: 'unknown' as const, // overwritten by server.ts
    profit: evPerBox - boxCost,
    byRarity,
    topHoloPulls,
    topReverseHoloPulls,
    slotBreakdown,
    hitBreakdown,
    pricedCardCount: new Set(entries.map((e) => `${e.productId}::${e.subType}`)).size,
    totalCardCount: 0, // populated by server.ts after extractCards
  };
}
