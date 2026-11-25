import {
  BPS,
  BotState,
  type Batch,
  type Curve,
  type OrderInput,
  type Pubkey,
  runBot,
} from './vendor/makefun-bot.ts';

// Strategy v2: Confirmed pullback-rebound on proven, low-concentration bonding curves
const MIN_AGE_SLOTS = 12;
const MAX_AGE_SLOTS = 6000;
const MIN_PEAK_REAL_SOL = 20_000_000_000n; // 20 SOL proven demand
const MIN_CUR_REAL_SOL = 8_000_000_000n; // 8 SOL minimum active reserve
const MAX_CUR_REAL_SOL = 72_000_000_000n; // 72 SOL ceiling before completion
const MIN_UNIQUE_BUYERS = 24;
const MIN_BUY_SLOTS = 14;
const MAX_SINGLE_BUYER_BPS = 2800n; // max 28% of total buy volume from one wallet

const MIN_PULLBACK_BPS = 1000n; // at least 10% below peak spot price
const MAX_PULLBACK_BPS = 2800n; // at most 28% below peak spot price
const RECENT_FLOW_WINDOW = 5;
const MIN_RECENT_BUYS = 3;

const MIN_BUY_LAMPORTS = 15_000_000n; // 0.015 SOL (> 0.01 SOL guardrail)
const MAX_STAKE_LAMPORTS = 450_000_000n; // 0.45 SOL max per position
const BUY_COOLDOWN_SLOTS = 15;
const MAX_BUY_ATTEMPTS = 2;

const BUY_SLIPPAGE_BPS = 850;
const TP_SLIPPAGE_BPS = 1200;
const EXIT_SLIPPAGE_BPS = 1500;

const HARD_STOP_PCT = 82n; // -18% net of fees
const POST_TP1_STOP_PCT = 98n; // protect remaining runner near breakeven after TP1 fills
const TP1_PCT = 117n; // +17% net of fees -> sell 50%
const TP2_PCT = 175n; // +75% net of fees -> sell 100%
const TRAIL_ARM_PCT = 116n; // arm trailing stop at +16% net
const TRAIL_DROP_BPS = 1000n; // 10% pullback from peak price after arming
const STALE_HOLD_SLOTS = 280;
const STALE_MIN_PCT = 112n;

const PRICE_SCALE = 1_000_000_000_000n;

interface FlowSample {
  isBuy: boolean;
  quoteLamports: bigint;
}

interface MintTracker {
  mint: Pubkey;
  creator: Pubkey | null;
  uniqueBuyers: Set<Pubkey>;
  buySlots: Set<number>;
  userBuySol: Map<Pubkey, bigint>;
  maxUserBuySol: bigint;
  buyVol: bigint;
  sellVol: bigint;
  creatorBuyTok: bigint;
  creatorSellTok: bigint;
  peakRealSol: bigint;
  peakPriceScaled: bigint;
  recent: FlowSample[];
  lastBuyTrigger: boolean;
  buyAttempts: number;
  lastAttemptSlot: number;
  everFilled: boolean;
}

interface PositionMeta {
  entrySlot: number;
  tp1Done: boolean;
  tp1ClientId: string | null;
  trailingArmed: boolean;
  peakPriceScaled: bigint;
  peakNetValue: bigint;
}

const trackers = new Map<Pubkey, MintTracker>();
const posMeta = new Map<Pubkey, PositionMeta>();
let runSeed = 0n;

function spotPriceScaled(curve: Curve): bigint {
  if (curve.virtual_token_reserves <= 0n || curve.virtual_quote_reserves <= 0n) return 0n;
  return (curve.virtual_quote_reserves * PRICE_SCALE) / curve.virtual_token_reserves;
}

function estimateNetSellLamports(
  curve: Curve,
  tokenAmount: bigint,
  curveFeeBps: bigint,
  txFee: bigint,
): bigint {
  if (tokenAmount <= 0n || curve.virtual_token_reserves <= 0n || curve.virtual_quote_reserves <= 0n) {
    return 0n;
  }
  const grossSol =
    (curve.virtual_quote_reserves * tokenAmount) / (curve.virtual_token_reserves + tokenAmount);
  const afterCurveFee = (grossSol * (BPS - curveFeeBps)) / BPS;
  return afterCurveFee > txFee ? afterCurveFee - txFee : 0n;
}

function getOrCreateTracker(mint: Pubkey): MintTracker {
  let t = trackers.get(mint);
  if (t === undefined) {
    t = {
      mint,
      creator: null,
      uniqueBuyers: new Set<Pubkey>(),
      buySlots: new Set<number>(),
      userBuySol: new Map<Pubkey, bigint>(),
      maxUserBuySol: 0n,
      buyVol: 0n,
      sellVol: 0n,
      creatorBuyTok: 0n,
      creatorSellTok: 0n,
      peakRealSol: 0n,
      peakPriceScaled: 0n,
      recent: [],
      lastBuyTrigger: false,
      buyAttempts: 0,
      lastAttemptSlot: -1,
      everFilled: false,
    };
    trackers.set(mint, t);
  }
  return t;
}

function processBatchUpdates(state: BotState, batch: Batch): void {
  for (const ev of batch.events) {
    if (ev.event === 'CreateEvent') {
      const t = getOrCreateTracker(ev.mint);
      t.creator = ev.creator;
    } else if (ev.event === 'TradeEvent') {
      const t = getOrCreateTracker(ev.mint);
      const q = BigInt(ev.quote_amount);
      const tok = BigInt(ev.token_amount);

      if (ev.is_buy) {
        t.uniqueBuyers.add(ev.user);
        t.buySlots.add(ev.slot);
        t.buyVol += q;
        const prevUserBuy = t.userBuySol.get(ev.user) ?? 0n;
        const nextUserBuy = prevUserBuy + q;
        t.userBuySol.set(ev.user, nextUserBuy);
        if (nextUserBuy > t.maxUserBuySol) t.maxUserBuySol = nextUserBuy;
        if (t.creator !== null && ev.user === t.creator) t.creatorBuyTok += tok;
      } else {
        t.sellVol += q;
        if (t.creator !== null && ev.user === t.creator) t.creatorSellTok += tok;
      }

      t.lastBuyTrigger = ev.is_buy;
      t.recent.push({ isBuy: ev.is_buy, quoteLamports: q });
      if (t.recent.length > RECENT_FLOW_WINDOW) t.recent.shift();

      const curve = state.curves.get(ev.mint);
      if (curve !== undefined) {
        if (curve.real_quote_reserves > t.peakRealSol) {
          t.peakRealSol = curve.real_quote_reserves;
        }
        const p = spotPriceScaled(curve);
        if (p > t.peakPriceScaled) t.peakPriceScaled = p;
      }
    }
  }

  for (const f of batch.fills) {
    if (f.side === 'buy' && f.status === 'filled') {
      const t = trackers.get(f.mint);
      if (t !== undefined) t.everFilled = true;

      if (!posMeta.has(f.mint)) {
        const curve = state.curves.get(f.mint);
        const unitPrice = curve !== undefined ? spotPriceScaled(curve) : 0n;
        posMeta.set(f.mint, {
          entrySlot: f.slot,
          tp1Done: false,
          tp1ClientId: null,
          trailingArmed: false,
          peakPriceScaled: unitPrice,
          peakNetValue: BigInt(f.quote_lamports),
        });
      }
    } else if (f.side === 'sell') {
      const meta = posMeta.get(f.mint);
      if (meta !== undefined && meta.tp1ClientId === f.client_id) {
        if (f.status === 'filled') {
          meta.tp1Done = true;
        }
        meta.tp1ClientId = null;
      }
    }
  }

  for (const mint of posMeta.keys()) {
    if (!state.positions.has(mint)) {
      posMeta.delete(mint);
    }
  }
}

function hasPendingForMint(state: BotState, mint: Pubkey): boolean {
  for (const p of state.pending.values()) {
    if (p.order.mint === mint) return true;
  }
  return false;
}

function decideExits(state: BotState, batch: Batch, curveFeeBps: bigint): OrderInput[] {
  const orders: OrderInput[] = [];
  const txFee = state.txFeeLamports();

  for (const [mint, holding] of state.positions) {
    if (orders.length >= state.hello.caps.max_orders_per_batch) break;
    if (hasPendingForMint(state, mint)) continue;

    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) continue;

    let meta = posMeta.get(mint);
    const curPrice = spotPriceScaled(curve);
    const netValue = estimateNetSellLamports(curve, holding.token_amount, curveFeeBps, txFee);

    if (meta === undefined) {
      meta = {
        entrySlot: batch.slot,
        tp1Done: false,
        tp1ClientId: null,
        trailingArmed: false,
        peakPriceScaled: curPrice,
        peakNetValue: netValue,
      };
      posMeta.set(mint, meta);
    }

    if (curPrice > meta.peakPriceScaled) meta.peakPriceScaled = curPrice;
    if (netValue > meta.peakNetValue) meta.peakNetValue = netValue;

    const cost = holding.cost_lamports;
    if (cost > 0n && meta.peakNetValue * 100n >= cost * TRAIL_ARM_PCT) {
      meta.trailingArmed = true;
    }

    // 1. Hard stop-loss (tightens to near-breakeven once TP1 fill is confirmed)
    const activeStopPct = meta.tp1Done ? POST_TP1_STOP_PCT : HARD_STOP_PCT;
    if (cost > 0n && netValue * 100n <= cost * activeStopPct) {
      orders.push({
        side: 'sell',
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: EXIT_SLIPPAGE_BPS,
      });
      continue;
    }

    // 2. Full take-profit (TP2)
    if (cost > 0n && netValue * 100n >= cost * TP2_PCT) {
      orders.push({
        side: 'sell',
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: TP_SLIPPAGE_BPS,
      });
      continue;
    }

    // 3. Armed trailing stop on pullback from post-entry peak
    if (
      meta.trailingArmed &&
      meta.peakPriceScaled > 0n &&
      curPrice * BPS <= meta.peakPriceScaled * (BPS - TRAIL_DROP_BPS)
    ) {
      orders.push({
        side: 'sell',
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: EXIT_SLIPPAGE_BPS,
      });
      continue;
    }

    // 4. Partial take-profit (TP1: sell 50% of tokens; confirm via fill client_id)
    if (!meta.tp1Done && meta.tp1ClientId === null && cost > 0n && netValue * 100n >= cost * TP1_PCT) {
      const half = holding.token_amount / 2n;
      if (half > 0n) {
        const client_id = state.clientId();
        meta.tp1ClientId = client_id;
        orders.push({
          side: 'sell',
          mint,
          client_id,
          token_amount: half,
          max_slippage_bps: TP_SLIPPAGE_BPS,
        });
        continue;
      }
    }

    // 5. Stale rotation exit to keep capital rotating across 20+ coins
    if (batch.slot - meta.entrySlot >= STALE_HOLD_SLOTS && netValue * 100n < cost * STALE_MIN_PCT) {
      orders.push({
        side: 'sell',
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: EXIT_SLIPPAGE_BPS,
      });
    }
  }

  return orders;
}

function scoreReboundCandidate(curve: Curve, t: MintTracker, slot: number): bigint {
  if (curve.complete || curve.created_slot === null) return -1n;
  if (t.everFilled || t.buyAttempts >= MAX_BUY_ATTEMPTS) return -1n;
  if (t.lastAttemptSlot >= 0 && slot - t.lastAttemptSlot < BUY_COOLDOWN_SLOTS) return -1n;

  const age = slot - curve.created_slot;
  if (age < MIN_AGE_SLOTS || age > MAX_AGE_SLOTS) return -1n;

  if (t.peakRealSol < MIN_PEAK_REAL_SOL) return -1n;
  if (curve.real_quote_reserves < MIN_CUR_REAL_SOL || curve.real_quote_reserves > MAX_CUR_REAL_SOL) {
    return -1n;
  }
  if (t.uniqueBuyers.size < MIN_UNIQUE_BUYERS || t.buySlots.size < MIN_BUY_SLOTS) return -1n;
  if (t.buyVol <= 0n) return -1n;

  // Guard against single-wallet concentration / artificial volume
  if (t.maxUserBuySol * BPS > t.buyVol * MAX_SINGLE_BUYER_BPS) return -1n;

  // Guard against creator dumping >90% of creator tokens
  if (t.creatorBuyTok > 0n && t.creatorSellTok * 10n >= t.creatorBuyTok * 9n) return -1n;

  // Require healthy pullback zone (10%..28% below peak spot price)
  if (t.peakPriceScaled <= 0n) return -1n;
  const curPrice = spotPriceScaled(curve);
  if (curPrice <= 0n) return -1n;
  if (curPrice * BPS > t.peakPriceScaled * (BPS - MIN_PULLBACK_BPS)) return -1n;
  if (curPrice * BPS < t.peakPriceScaled * (BPS - MAX_PULLBACK_BPS)) return -1n;

  // Require fresh rebound buy confirmation on the latest window
  if (!t.lastBuyTrigger || t.recent.length < RECENT_FLOW_WINDOW) return -1n;
  let recBuyCount = 0;
  let recBuyVol = 0n;
  let recSellVol = 0n;
  for (const s of t.recent) {
    if (s.isBuy) {
      recBuyCount++;
      recBuyVol += s.quoteLamports;
    } else {
      recSellVol += s.quoteLamports;
    }
  }
  if (recBuyCount < MIN_RECENT_BUYS || recBuyVol * 10n < recSellVol * 18n) return -1n;

  return recBuyVol - recSellVol + BigInt(t.uniqueBuyers.size) * 40_000_000n + curve.real_quote_reserves / 20n;
}

function decideEntries(state: BotState, batch: Batch, orders: OrderInput[]): void {
  const maxPos = state.hello.caps.max_open_positions;
  const maxBatch = state.hello.caps.max_orders_per_batch;
  let committed = state.committedPositionCount();
  let freeCash = state.freeCashLamports();
  const txFee = state.txFeeLamports();

  if (committed >= maxPos || orders.length >= maxBatch) return;

  const candidates: Array<{ mint: Pubkey; score: bigint }> = [];
  const seen = new Set<Pubkey>();

  for (const ev of batch.events) {
    if (ev.event !== 'TradeEvent') continue;
    const mint = ev.mint;
    if (seen.has(mint)) continue;
    seen.add(mint);
    if (state.positions.has(mint) || hasPendingForMint(state, mint)) continue;

    const curve = state.curves.get(mint);
    const tracker = trackers.get(mint);
    if (curve === undefined || tracker === undefined) continue;

    const score = scoreReboundCandidate(curve, tracker, batch.slot);
    if (score > 0n) candidates.push({ mint, score });
  }

  candidates.sort((a, b) => (a.score > b.score ? -1 : a.score < b.score ? 1 : a.mint < b.mint ? -1 : 1));

  for (const c of candidates) {
    if (committed >= maxPos || orders.length >= maxBatch) break;

    const safeCap = (state.maxBuyLamports(c.mint) * 95n) / 100n;
    const remainingSlots = BigInt(Math.max(1, maxPos - committed));
    const slotBudget = freeCash > txFee ? (freeCash - txFee) / remainingSlots : 0n;

    let size = safeCap;
    if (MAX_STAKE_LAMPORTS < size) size = MAX_STAKE_LAMPORTS;
    if (slotBudget < size) size = slotBudget;

    if (size < MIN_BUY_LAMPORTS) continue;
    if (freeCash < size + txFee) continue;

    const tracker = trackers.get(c.mint);
    if (tracker !== undefined) {
      tracker.buyAttempts += 1;
      tracker.lastAttemptSlot = batch.slot;
    }

    orders.push({
      side: 'buy',
      mint: c.mint,
      quote_lamports: size,
      max_slippage_bps: BUY_SLIPPAGE_BPS,
    });
    committed++;
    freeCash -= size + txFee;
  }
}

await runBot({
  onHello(state) {
    runSeed = BigInt(state.hello.seed);
    console.error(`Bot v2 initialized: seed=${runSeed}, capital=${state.hello.capital.lamports}`);
  },
  onBatch(state, batch) {
    processBatchUpdates(state, batch);
    const curveFeeBps =
      BigInt(state.hello.fees.protocol_bps_fallback) + BigInt(state.hello.fees.creator_bps_fallback);
    const orders = decideExits(state, batch, curveFeeBps);
    decideEntries(state, batch, orders);
    return orders;
  },
  onDone(state, done) {
    const netPnl = BigInt(done.account.cash_lamports) - BigInt(state.hello.capital.lamports);
    console.error(`Done (${done.reason}): cash=${done.account.cash_lamports}, netPnl=${netPnl}`);
  },
});
