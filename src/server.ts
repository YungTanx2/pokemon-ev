import express from 'express';
import path from 'path';
import fs from 'fs';
import cron from 'node-cron';
import { fetchProducts, fetchPrices, extractCards, matchPrices, ExtendedDataEntry } from './tcgcsv';
import { calculateEV } from './calculator';
import { SUPPORTED_SETS, DEFAULT_SET_ID } from './sets';
import { scanCard } from './spike-check';
import { ScanCardResult } from './types';
import { initDb } from './price-history-db';
import { backfillMissingDays, ingestToday } from './archive-ingest';

const app = express();
const PORT = process.env.PORT ?? 3005;

const scanCache = new Map<string, { result: ScanCardResult; timestamp: number }>();
const SCAN_CACHE_TTL = 30 * 60 * 1000;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// Init SQLite and start backfill on startup (non-blocking)
initDb();
backfillMissingDays(10).catch(err => console.error('[startup] backfill failed:', err));
cron.schedule('0 21 * * *', () => ingestToday().catch(console.error));

// Serve static files from public/ (one level above src/)
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/api/sets', (_req, res) => {
  res.json(SUPPORTED_SETS);
});

app.get('/api/pull-rates', (req, res) => {
  const setId = (req.query.set as string | undefined)?.trim() ?? DEFAULT_SET_ID;
  try {
    const configPath = path.join(__dirname, `../config/pull-rates-${setId}.json`);
    const rates = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    res.json(rates);
  } catch {
    res.status(404).json({ error: `No pull-rate config found for set "${setId}".` });
  }
});

app.get('/api/analyze', async (req, res) => {
  // ── SSE headers ─────────────────────────────────────────────────────────
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  function send(obj: object): void {
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  }

  // ── Query params ─────────────────────────────────────────────────────────
  const boxPriceParam = (req.query.boxPrice as string | undefined)?.trim();
  const setId = (req.query.set as string | undefined)?.trim() ?? DEFAULT_SET_ID;

  const setDef = SUPPORTED_SETS.find((s) => s.id === setId);
  if (!setDef) {
    send({ type: 'error', message: `Unknown set ID: "${setId}". Valid IDs: ${SUPPORTED_SETS.map((s) => s.id).join(', ')}` });
    res.end();
    return;
  }

  // ── Load pull rates for this set (custom from query param, or from file) ──
  const customRatesParam = req.query.customRates as string | undefined;
  let pullRates: ReturnType<typeof JSON.parse>;
  if (customRatesParam) {
    try {
      pullRates = JSON.parse(customRatesParam);
    } catch {
      send({ type: 'error', message: 'Invalid customRates JSON in query parameter.' });
      res.end();
      return;
    }
  } else {
    try {
      const configPath = path.join(__dirname, `../config/pull-rates-${setId}.json`);
      pullRates = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      send({ type: 'error', message: `Could not load pull-rate config for set "${setId}".` });
      res.end();
      return;
    }
  }

  try {
    // ── Step 1: Fetch products + prices (parallel) ─────────────────────────
    send({ type: 'progress', step: 1, status: 'running', message: 'Fetching products and prices from TCGCSV…' });
    const [products, prices] = await Promise.all([fetchProducts(setDef.groupId), fetchPrices(setDef.groupId)]);
    send({ type: 'progress', step: 1, status: 'done', message: `Got ${products.length} products, ${prices.length} price entries` });

    // ── Step 2: Extract card list ──────────────────────────────────────────
    send({ type: 'progress', step: 2, status: 'running', message: 'Extracting card list from product data…' });
    const cards = extractCards(products);

    if (cards.length === 0) {
      send({ type: 'error', message: 'No cards with rarity data found in TCGCSV products.' });
      res.end();
      return;
    }

    send({ type: 'progress', step: 2, status: 'done', message: `Found ${cards.length} ${setDef.name} cards` });

    // ── Step 3: Resolve box price ──────────────────────────────────────────
    send({ type: 'progress', step: 3, status: 'running', message: 'Resolving booster box price…' });
    let boxCost: number;

    if (boxPriceParam !== undefined && boxPriceParam !== '') {
      boxCost = parseFloat(boxPriceParam);
      if (isNaN(boxCost) || boxCost < 0) {
        send({ type: 'error', message: `Invalid box price value: "${boxPriceParam}"` });
        res.end();
        return;
      }
      send({ type: 'progress', step: 3, status: 'done', message: `Using manual box price: $${boxCost.toFixed(2)}` });
    } else {
      const boxProduct = products.find(
        (p) => !extractRarity(p.extendedData) && p.name.toLowerCase().includes('booster box'),
      );
      const boxEntry = boxProduct
        ? prices.find((pr) => pr.productId === boxProduct.productId && pr.subTypeName === 'Normal')
        : undefined;
      const fetched = boxEntry ? (boxEntry.marketPrice ?? boxEntry.midPrice ?? null) : null;
      boxCost = fetched ?? 0;
      const priceMsg = boxCost > 0
        ? `Box market price: $${boxCost.toFixed(2)}`
        : 'Could not find box price in TCGCSV data — using $0';
      send({ type: 'progress', step: 3, status: 'done', message: priceMsg });
    }

    // ── Step 4: Match prices + calculate EV ───────────────────────────────
    send({ type: 'progress', step: 4, status: 'running', message: 'Matching prices and calculating EV…' });
    const entries = matchPrices(products, prices);
    const pricedCards = new Set(entries.map((e) => `${e.productId}::${e.subType}`)).size;

    const result = calculateEV(entries, pullRates, boxCost);
    result.totalCardCount = cards.length;
    result.pricedCardCount = pricedCards;

    send({ type: 'progress', step: 4, status: 'done', message: `Matched prices for ${cards.length} cards (${pricedCards} price entries)` });

    // ── Send final result ──────────────────────────────────────────────────
    send({ type: 'result', data: result, packsPerBox: pullRates.packsPerBox });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[server] Error during analysis:', message);
    send({ type: 'error', message });
  } finally {
    res.end();
  }
});

app.get('/api/scan-set', async (req, res) => {
  const setId = (req.query.set as string)?.trim() ?? DEFAULT_SET_ID;
  const setDef = SUPPORTED_SETS.find(s => s.id === setId);
  if (!setDef) { res.status(400).json({ error: `Unknown set: ${setId}` }); return; }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event: string, data: object) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const [products, prices] = await Promise.all([
      fetchProducts(setDef.groupId), fetchPrices(setDef.groupId),
    ]);
    const entries = matchPrices(products, prices);

    // Filter to cards with market price >= $1; one entry per card+subType
    const MIN_PRICE = 1.0;
    const eligible = entries.filter(e => {
      const price = e.marketPrice > 0 ? e.marketPrice : e.midPrice;
      return price >= MIN_PRICE;
    });

    const now = Date.now();
    send('start', { totalCards: eligible.length });

    const BATCH_SIZE = 3;
    const BATCH_DELAY_MS = 200;

    for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
      const batch = eligible.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (entry, batchIdx) => {
        const marketPrice = entry.marketPrice > 0 ? entry.marketPrice : entry.midPrice;
        const key = `${entry.productId}:${entry.subType}`;
        const cached = scanCache.get(key);
        let result: ScanCardResult;
        if (cached && now - cached.timestamp < SCAN_CACHE_TTL) {
          result = cached.result;
        } else {
          result = await scanCard(
            entry.productId, entry.subType, entry.name,
            entry.rarity ?? 'Unknown', marketPrice,
          );
          scanCache.set(key, { result, timestamp: now });
        }
        send('card-result', result);
        send('progress', { completed: i + batchIdx + 1, total: eligible.length, cardName: entry.name });
      }));
      if (i + BATCH_SIZE < eligible.length) await delay(BATCH_DELAY_MS);
    }

    send('done', { total: eligible.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send('error', { message });
  } finally {
    res.end();
  }
});

/** Local helper to detect sealed products (no Rarity extendedData entry). */
function extractRarity(extendedData: ExtendedDataEntry[] = []): string | null {
  const VALID_RARITIES = new Set([
    'Common', 'Uncommon', 'Rare',
    'Double Rare', 'Ultra Rare',
    'Illustration Rare', 'Special Illustration Rare',
    'Hyper Rare', 'ACE SPEC Rare', 'Mega Hyper Rare',
    'Poke Ball Holo', 'Master Ball Holo',
    'Shiny Rare', 'Shiny Ultra Rare',   // Paldean Fates
    'Mega Attack Rare',                  // Ascended Heroes
  ]);
  const entry = extendedData.find((e) => e.name === 'Rarity');
  if (!entry || !VALID_RARITIES.has(entry.value)) return null;
  return entry.value;
}

app.listen(PORT, () => {
  console.log(`\n══════════════════════════════════════════════════════════`);
  console.log(`  Pokemon EV Calculator running at http://localhost:${PORT}`);
  console.log(`══════════════════════════════════════════════════════════\n`);
});
