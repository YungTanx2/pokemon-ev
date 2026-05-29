// All rarity strings that appear in Pokemon SV / ME era TCGCSV data.
// Note: TCGCSV uses "Rare" (not "Rare Holo") for the base holo rare in SV+ sets.
export type Rarity =
  | 'Common'
  | 'Uncommon'
  | 'Rare'
  | 'Double Rare'
  | 'Ultra Rare'
  | 'Illustration Rare'
  | 'Special Illustration Rare'
  | 'Hyper Rare'
  | 'ACE SPEC Rare'
  | 'Mega Hyper Rare'
  | 'Poke Ball Holo'      // any non-Master-Ball ball-pattern reverse holo
  | 'Master Ball Holo'   // Master Ball pattern reverse holo
  // Paldean Fates exclusive (shiny-style variants)
  | 'Shiny Rare'
  | 'Shiny Ultra Rare'
  // Ascended Heroes exclusive
  | 'Mega Attack Rare'
  // Black Bolt / White Flare exclusive
  | 'Black White Rare';

// TCGCSV subType names for Pokemon cards.
// Note: Double Rare / Ultra Rare / IR / SIR / HR only have Holofoil (no Normal print);
// extractCards() applies a Normal→Holofoil fallback for those cards.
export type SubType = 'Normal' | 'Holofoil' | 'Reverse Holofoil';

export interface PokemonCard {
  name: string;
  rarity: Rarity;
  image?: string;
}

export interface PriceEntry {
  productId: number;
  name: string;
  rarity?: Rarity;
  subType: SubType;
  marketPrice: number;
  midPrice: number;
  image?: string;
}

export interface RarityStats {
  rarity: string;
  /** Average effective price for Normal (or Holofoil fallback) cards of this rarity. */
  avgNormalPrice: number | null;
  /** Average effective price for Reverse Holofoil cards of this rarity. */
  avgRhPrice: number | null;
  normalPriced: number;
  normalTotal: number;
  rhPriced: number;
  rhTotal: number;
  evContribution: number;
}

export interface SlotBreakdown {
  commonEv: number;
  uncommonEv: number;
  reverseHoloEv: number;
  hitEv: number;
}

export interface HitRarityBreakdown {
  fraction: number;       // P(rarity per pack) from hitDistribution
  avgPrice: number | null; // bulk-adjusted avg price for this rarity
  evPerBox: number;       // fraction × avgPrice × packsPerBox
}

export interface EvResult {
  evPerPack: number;
  evPerBox: number;
  boxCost: number;
  /** How the box price was determined. */
  boxPriceSource: 'box' | 'bundle' | 'manual' | 'unknown';
  profit: number;
  excludedCaseHits: boolean;
  byRarity: Record<string, RarityStats>;
  /** Top hit-slot cards by price, excluding case-hit rarities (< 1/50 packs). */
  topHoloPulls: PriceEntry[];
  /** Top hit-slot cards that qualify as case hits (< 1/50 packs pull rate). */
  topCaseHitPulls: PriceEntry[];
  /** Top Reverse Holofoil cards by price (includes Poke Ball / Master Ball pattern holos) */
  topReverseHoloPulls: PriceEntry[];
  slotBreakdown: SlotBreakdown;
  /** Per-rarity EV breakdown for the hit slot, keyed by rarity name. */
  hitBreakdown: Record<string, HitRarityBreakdown>;
  pricedCardCount: number;
  totalCardCount: number;
}

export interface Sale {
  condition: string;
  variant: string;
  quantity: number;
  purchasePrice: number;
  orderDate: string;
}

export interface ScanCardResult {
  productId: number;
  subType: string;
  name: string;
  rarity: string;
  currentMarketPrice: number;
  recentAvgPrice: number;
  recentSalesCount: number;
  dailyPctChange: number;
  dailyAbsChange: number;
  dailySpiking: boolean;
  weeklyPctChange: number | null;
  weeklyAbsChange: number | null;
  weeklySpiking: boolean;
  price7dAgo: number | null;
  error?: boolean;
}
