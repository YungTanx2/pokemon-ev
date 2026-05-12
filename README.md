# Lorcana Booster Box EV Calculator

Fetches live card prices from TCGPlayer and calculates the statistical expected value (EV) of opening a Disney Lorcana booster box, comparing it against the current market price of the box.

Supports all **10 main booster sets**. Available as both a **webapp** (interactive, with live progress) and a **CLI** that writes a static HTML report.

## Setup

```bash
cd lorcana-ev
npm install
```

Requires Node.js ≥ 18.

## Webapp

```bash
npm start
# → http://localhost:3000

PORT=8080 npm start   # custom port
```

Open the browser, pick a set from the dropdown, choose options, and click **Analyze**. Progress streams live as each step completes, then the full report renders in the page.

## CLI

```bash
# Analyze the default set (Winterspell)
npm run analyze

# Analyze a specific set
npm run analyze -- --set the-first-chapter
npm run analyze -- --set wilds-unknown

# Conservative EV — exclude Enchanted + Iconic from calculation
npm run analyze -- --exclude-ultra-rares

# Override box price instead of auto-fetching from TCGPlayer
npm run analyze -- --box-price 149.99

# Custom output file name
npm run analyze -- --output my-report.html

# Combine flags
npm run analyze -- --set azurite-sea --exclude-ultra-rares --box-price 149.99
```

The CLI writes a self-contained `lorcana-ev-report.html` with the full breakdown.

### Supported set IDs

| `--set` ID | Set Name | Set # |
|---|---|---|
| `the-first-chapter` | The First Chapter | 1 |
| `rise-of-the-floodborn` | Rise of the Floodborn | 2 |
| `into-the-inklands` | Into the Inklands | 3 |
| `ursulas-return` | Ursula's Return | 4 |
| `shimmering-skies` | Shimmering Skies | 5 |
| `azurite-sea` | Azurite Sea | 6 |
| `archazias-island` | Archazia's Island | 7 |
| `whispers-in-the-well` | Whispers in the Well | 8 |
| `winterspell` | Winterspell | 9 |
| `wilds-unknown` | Wilds Unknown | 10 |

## Data Source

All data comes from a single source:

| Source | Purpose |
|--------|---------|
| [TCGCSV](https://tcgcsv.com) | Card names, rarities, and live prices (~24hr TCGPlayer cache) |

Card rarities are read from the `extendedData` field of each product entry — no separate card-list API needed. The booster box price is found dynamically by scanning the same product list for a sealed product named "booster box". No API keys required.

## How EV Is Calculated

### 1. Fetch card prices

Card prices are fetched from [TCGCSV](https://tcgcsv.com), a ~24-hour cache of TCGPlayer market data. Each card entry exposes two prices:

- **marketPrice** — weighted average of recent actual sales (preferred)
- **midPrice** — median of currently listed prices (fallback when `marketPrice` is zero)

The booster box price is fetched from the same source: the calculator scans the product list for a sealed product named "booster box" (no rarity) and reads its Normal `marketPrice`.

---

### 2. Pack structure

Every Lorcana booster pack contains a fixed set of **slots**. Each slot always provides exactly one card, but different slots draw from different rarity pools:

| Slot | Cards per pack | Rarity |
|------|:-:|---|
| Common | 6 | Always Common |
| Uncommon | 3 | Always Uncommon |
| Rare+ | 2 | Rare, Super Rare, or Legendary (weighted) |
| Foil | 1 | Any rarity — Cold Foil or Holofoil |

Slot counts are defined in each set's `config/pull-rates-{set-id}.json`.

---

### 3. Rarity distributions

The **Rare+** and **Foil** slots use probability distributions to determine which rarity fills them on any given pack. These are community-estimated odds.

**Example (Winterspell):**

```json
"rarePlusDistribution": {
  "Rare": 0.65, "Super Rare": 0.25, "Legendary": 0.10
},
"foilDistribution": {
  "Common": 0.560, "Uncommon": 0.270, "Rare": 0.090,
  "Super Rare": 0.040, "Legendary": 0.006,
  "Enchanted": 0.014, "Epic": 0.014, "Iconic": 0.006
}
```

Foil cards also have a subtype that determines which price column to use:

- **Cold Foil** → Common, Uncommon, Rare, Super Rare, Legendary
- **Holofoil** → Enchanted, Epic, Iconic

---

### 4. EV per slot (per pack)

**Common slot:**
```
EV_common = slots.common × avg_price(Common, Normal)
          = 6 × avg_price(Common, Normal)
```

**Uncommon slot:**
```
EV_uncommon = slots.uncommon × avg_price(Uncommon, Normal)
            = 3 × avg_price(Uncommon, Normal)
```

**Rare+ slot** — weighted average across all rarities in the distribution:
```
EV_rarePlus = slots.rarePlus × Σ [ P(rarity) × avg_price(rarity, Normal) ]
            = 2 × ( 0.65 × avg_Rare + 0.25 × avg_SuperRare + 0.10 × avg_Legendary )
```

**Foil slot** — weighted average using foil-specific prices:
```
EV_foil = slots.foil × Σ [ P(rarity) × avg_foil_price(rarity) ]"
        = 1 × ( 0.560 × avg_Common_ColdFoil
              + 0.270 × avg_Uncommon_ColdFoil
              + 0.090 × avg_Rare_ColdFoil
              + 0.040 × avg_SuperRare_ColdFoil
              + 0.006 × avg_Legendary_ColdFoil
              + 0.014 × avg_Enchanted_Holofoil
              + 0.014 × avg_Epic_Holofoil
              + 0.006 × avg_Iconic_Holofoil )
```

`avg_price(rarity, subType)` is the simple arithmetic mean of all TCGPlayer market prices for cards of that rarity and foil type. Cards with no price data are excluded from the average.

---

### 5. Scale to a box

```
EV_per_pack = EV_common + EV_uncommon + EV_rarePlus + EV_foil

EV_per_box  = EV_per_pack × packsPerBox   (typically 24)

Profit/Loss = EV_per_box − box_cost
```

A positive number means the expected card value exceeds what you paid for the box. In practice EV almost always trails box cost — the gap represents the retailer margin and the sealed-product premium.

---

### 6. Ultra-Rare Exclusion option

Enchanted and Iconic cards are classified as **ultra rares**. Their TCGPlayer prices can be very high, but the pull rate is extremely low (≤ 1.4%). Because a single lucky pull dramatically skews the EV upward, you can exclude ultra rares to get a more conservative floor estimate. When excluded, those rarities contribute $0 to the foil EV calculation.

---

## Pull Rate Config

Community-estimated rates live in `config/pull-rates-{set-id}.json`. Each file matches the slug from the table above. Edit them to match updated community data.

```json
{
  "packsPerBox": 24,
  "slots": { "common": 6, "uncommon": 3, "rarePlus": 2, "foil": 1 },
  "rarePlusDistribution": { "Rare": 0.65, "Super Rare": 0.25, "Legendary": 0.10 },
  "foilDistribution": { "Common": 0.560, "Uncommon": 0.270, ... }
}
```

> **Note:** Sets 1–4 predate the Epic and Iconic rarities, so their `foilDistribution` omits those keys. Sets 5–7 introduced them progressively. All rates are community estimates — Ravensburger does not publish official pack odds.

## Architecture

```
src/
  server.ts     Express server — serves webapp, streams SSE progress, /api/sets endpoint
  index.ts      CLI entry point (--set, --box-price, --exclude-ultra-rares, --output)
  sets.ts       Central set registry (IDs, names, set numbers, TCGCSV group IDs)
  tcgcsv.ts     TCGCSV API client — fetchProducts(groupId), fetchPrices(groupId)
  calculator.ts EV calculation logic
  report.ts     Static HTML report generator (used by CLI)
  types.ts      Shared TypeScript types
public/
  index.html    Self-contained webapp (vanilla HTML/CSS/JS, no build step)
config/
  pull-rates-{set-id}.json   Per-set pack slot counts and rarity pull probabilities (×10)
  pull-rates.json            Original config kept for backward compatibility
```

## Caveats

Pull rates are **community estimates** — Ravensburger does not publish official pack odds.
EV is a statistical expectation over many boxes; individual results will vary significantly.
