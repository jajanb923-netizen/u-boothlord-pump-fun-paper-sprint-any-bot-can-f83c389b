// Sprinter: a two-signal pump.fun paper-trading bot for agent-fun/replay/v2.
//
// Two complementary signals share the 5 position slots and the 10 SOL of paper cash:
//
//  1. Launch sniper (breadth): buy a coin in its first 3 slots when the launch looks
//     clean — small creator buy, at most 2 other early buyers, no creator sale yet —
//     stake 0.05 SOL, sell at +15% / -8% / after 10 slots, or the moment the creator
//     sells. This trades ~50 coins per 6h window, so the 20-coin minimum bar is cleared
//     with margin, and each loss is tiny (fees plus at most 8% of 0.05 SOL).
//
//  2. Dip rider (right tail): buy a 30-45% dip from the 2500-slot high on a strong
//     curve (real SOL >= 3 at entry and at the high), only while buyers are still
//     stepping in (last trade a buy, >= 3 of the last 6 trades buys, net SOL flow >= 0).
//     Tranche 0.15 SOL, up to 0.75 SOL per coin, take profit +30%, stop -15%, at most
//     300 slots held. Most dip buys lose a little; the rare one that rides a curve to
//     completion pays for them. The weak tier (tiny probes on weak curves) is
//     deliberately off: on the dev window it only added fee bleed.
//
// Both signals are pure functions of the batches: no clock, no randomness, no I/O, so
// the two graded executions produce byte-identical action logs.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  // Sniper.
  snipeMaxAge: number;
  snipeStakeLamports: number;
  snipeMinRealSol: number;
  snipeMaxRealSol: number;
  snipeMaxDevBuy: number;
  snipeMaxBuyers: number;
  snipeTpBps: number;
  snipeSlBps: number;
  snipeMaxHold: number;
  // Dip rider.
  dipHighWindow: number;
  dipMin: number;
  dipMax: number;
  dipMinRealSol: bigint;
  dipMinHighRealSol: bigint;
  dipFlowTrades: number;
  dipMinBuys: number;
  dipTranche: bigint;
  dipMaxPosition: bigint;
  dipAddBand: number;
  dipTp: number;
  dipSl: number;
  dipMaxHold: number;
  dipCooldown: number;
  // Shared.
  buySlipBps: number;
  sellSlipBps: number;
}

export const DEFAULT_PARAMS: Params = {
  snipeMaxAge: 3,
  snipeStakeLamports: 50_000_000,
  snipeMinRealSol: 1_000_000_000,
  snipeMaxRealSol: 30_000_000_000,
  snipeMaxDevBuy: 2_500_000_000,
  snipeMaxBuyers: 2,
  snipeTpBps: 1500,
  snipeSlBps: 800,
  snipeMaxHold: 10,
  dipHighWindow: 2500,
  dipMin: 0.3,
  dipMax: 0.45,
  dipMinRealSol: 3_000_000_000n,
  dipMinHighRealSol: 3_000_000_000n,
  dipFlowTrades: 6,
  dipMinBuys: 3,
  dipTranche: 150_000_000n,
  dipMaxPosition: 750_000_000n,
  dipAddBand: 0.05,
  dipTp: 0.3,
  dipSl: 0.15,
  dipMaxHold: 300,
  dipCooldown: 300,
  buySlipBps: 10_000,
  sellSlipBps: 10_000,
};

const BPS = 10_000n;
const FEE_BPS = 125n;
const LAMPORTS = 1e9;

interface SnipeCoin {
  mint: Pubkey;
  created: number;
  creator: Pubkey;
  devBuy: bigint;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  devSold: boolean;
  buysSent: number;
  done: boolean;
}

interface DipTick {
  slot: number;
  price: number;
  realSol: bigint;
  isBuy: boolean;
  sol: bigint;
}

interface DipBook {
  ticks: DipTick[];
  committed: bigint;
  entryPrice: number;
  entrySlot: number;
  coolUntil: number;
  exiting: boolean;
}

interface Held {
  kind: 'snipe' | 'dip';
  opened: number;
  best: bigint;
  devSoldAtOpen: boolean;
}

/** What selling `tokens` against (vq, vt) pays after the 95+30 bps curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const snipes = new Map<Pubkey, SnipeCoin>();
  const dips = new Map<Pubkey, DipBook>();
  const held = new Map<Pubkey, Held>();
  const selling = new Set<Pubkey>();
  /** Mints created in the last few batches: the only ones the sniper can still buy. */
  let young: Pubkey[] = [];

  const dipBook = (mint: Pubkey): DipBook => {
    let b = dips.get(mint);
    if (b === undefined) {
      b = { ticks: [], committed: 0n, entryPrice: 0, entrySlot: -1, coolUntil: -1, exiting: false };
      dips.set(mint, b);
    }
    return b;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();

      // --- Read the batch into both books. ---
      const touchedDip: Pubkey[] = [];
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          snipes.set(e.mint, {
            mint: e.mint,
            created: e.slot,
            creator: e.creator,
            devBuy: 0n,
            buyers: new Set(),
            bought: 0n,
            soldByOthers: 0n,
            devSold: false,
            buysSent: 0,
            done: false,
          });
          dipBook(e.mint);
          young.push(e.mint);
        } else if (e.event === 'TradeEvent') {
          const s = snipes.get(e.mint);
          if (s !== undefined) {
            const sol = BigInt(e.sol_amount);
            if (e.is_buy) {
              s.bought += sol;
              if (e.user === s.creator && e.slot === s.created) s.devBuy += sol;
              else if (e.user !== s.creator) s.buyers.add(e.user);
            } else if (e.user === s.creator) {
              s.devSold = true;
            } else {
              s.soldByOthers += sol;
            }
          }
          const b = dipBook(e.mint);
          const vt = BigInt(e.virtual_token_reserves);
          b.ticks.push({
            slot: e.slot,
            price: vt === 0n ? 0 : Number(BigInt(e.virtual_quote_reserves)) / Number(vt),
            realSol: BigInt(e.real_quote_reserves),
            isBuy: e.is_buy,
            sol: BigInt(e.sol_amount),
          });
          if (b.ticks.length > 400) b.ticks.splice(0, b.ticks.length - 400);
          if (touchedDip[touchedDip.length - 1] !== e.mint && !touchedDip.includes(e.mint)) touchedDip.push(e.mint);
        } else {
          const s = snipes.get(e.mint);
          if (s !== undefined) s.done = true;
        }
      }
      young = young.filter((m) => {
        const s = snipes.get(m);
        return s !== undefined && now - s.created <= p.snipeMaxAge;
      });

      // --- Resolve fills. ---
      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        if (f.side === 'buy' && f.status === 'filled' && !held.has(f.mint)) {
          const s = snipes.get(f.mint);
          const b = dips.get(f.mint);
          held.set(f.mint, {
            kind: b !== undefined && b.entrySlot >= 0 ? 'dip' : 'snipe',
            opened: f.slot,
            best: 0n,
            devSoldAtOpen: s?.devSold ?? false,
          });
        }
        const b = dips.get(f.mint);
        if (b !== undefined && f.side === 'sell') {
          b.exiting = false;
          if (!state.positions.has(f.mint)) {
            b.committed = 0n;
            b.entrySlot = -1;
            b.coolUntil = now + p.dipCooldown;
          }
        } else if (b !== undefined && f.side === 'buy' && f.status !== 'filled' && !state.positions.has(f.mint)) {
          let stillPending = false;
          for (const o of state.pending.values()) if (o.order.mint === f.mint) stillPending = true;
          if (!stillPending) {
            b.committed = 0n;
            b.entrySlot = -1;
          }
        }
      }
      for (const mint of [...selling]) {
        let pending = false;
        for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') pending = true;
        if (!pending) selling.delete(mint);
      }

      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      const curveReserves = (mint: Pubkey): { vq: bigint; vt: bigint } | undefined => {
        const mk = marks.get(mint);
        if (mk !== undefined) return mk;
        const cv = state.curves.get(mint);
        if (cv === undefined) return undefined;
        return { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
      };
      const hasPendingBuy = (mint: Pubkey): boolean => {
        for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'buy') return true;
        return false;
      };

      // --- Exits for everything held. ---
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        let h = held.get(mint);
        if (h === undefined) {
          h = { kind: 'snipe', opened: now, best: 0n, devSoldAtOpen: snipes.get(mint)?.devSold ?? false };
          held.set(mint, h);
        }
        const res = curveReserves(mint);
        if (res === undefined) continue;
        const value = sellValue(pos.token_amount, res.vq, res.vt) - tx;
        const basis = pos.cost_lamports + tx;
        if (value > h.best) h.best = value;
        let exit = false;
        if (h.kind === 'snipe') {
          if (basis > 0n) {
            if (value * BPS >= basis * (BPS + BigInt(p.snipeTpBps))) exit = true;
            if (value * BPS <= basis * (BPS - BigInt(p.snipeSlBps))) exit = true;
          }
          if (now - h.opened >= p.snipeMaxHold) exit = true;
          const s = snipes.get(mint);
          if (s !== undefined && s.devSold && !h.devSoldAtOpen) exit = true;
        } else {
          const cost = Number(pos.cost_lamports) / LAMPORTS;
          const val = Number(value) / LAMPORTS;
          if (val >= cost * (1 + p.dipTp)) exit = true;
          if (val <= cost * (1 - p.dipSl)) exit = true;
          if (now - h.opened > p.dipMaxHold) exit = true;
        }
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlipBps });
        selling.add(mint);
        const s = snipes.get(mint);
        if (s !== undefined) s.done = true;
      }

      // --- Entries. ---
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();

      // Sniper entries: clean launches, age <= 3 slots.
      for (const mint of young) {
        if (orders.length >= cap) break;
        if (open >= state.hello.caps.max_open_positions) break;
        const s = snipes.get(mint);
        if (s === undefined || s.done || s.buysSent > 0) continue;
        if (hasPendingBuy(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) {
          s.done = true;
          continue;
        }
        if (s.devSold) {
          s.done = true;
          continue;
        }
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(p.snipeMinRealSol) || rq > BigInt(p.snipeMaxRealSol)) continue;
        if (s.devBuy > BigInt(p.snipeMaxDevBuy)) continue;
        if (s.buyers.size > p.snipeMaxBuyers) continue;
        if (s.bought > 0n && s.soldByOthers > s.bought) continue;
        const maxBuy = state.maxBuyLamports(mint);
        const stake = BigInt(p.snipeStakeLamports);
        const amount = stake < maxBuy ? stake : maxBuy;
        if (amount < 10_000_000n) continue;
        if (free < amount + tx * 6n) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        s.buysSent += 1;
        open += 1;
        held.set(mint, { kind: 'snipe', opened: now, best: 0n, devSoldAtOpen: s.devSold });
      }

      // Dip entries: 30-45% below the 2500-slot high on a strong curve, buyers stepping in.
      for (const mint of touchedDip) {
        if (orders.length >= cap) break;
        if (open >= state.hello.caps.max_open_positions) break;
        const b = dips.get(mint)!;
        if (b.exiting || hasPendingBuy(mint) || selling.has(mint)) continue;
        if (state.positions.has(mint)) {
          // Add a tranche while the price stays near the first entry price.
          if (b.committed <= 0n || b.committed >= p.dipMaxPosition || b.entryPrice <= 0) continue;
          const res = curveReserves(mint);
          if (res === undefined || res.vt === 0n) continue;
          const price = Number(res.vq) / Number(res.vt);
          if (price < b.entryPrice * (1 - p.dipAddBand) || price > b.entryPrice * (1 + p.dipAddBand)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          let amount = p.dipTranche;
          if (amount > p.dipMaxPosition - b.committed) amount = p.dipMaxPosition - b.committed;
          const capBuy = (state.maxBuyLamports(mint) * 97n) / 100n;
          if (amount > capBuy) amount = capBuy;
          if (amount < 10_000_000n || free < amount + tx) continue;
          orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
          free -= amount + tx;
          b.committed += amount;
          continue;
        }
        if (b.entrySlot >= 0 || now < b.coolUntil) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const rq = curve.real_quote_reserves;
        if (rq < p.dipMinRealSol) continue;
        // Recent high over the lookback window and the drawdown from it.
        let high = 0;
        let highRq = 0n;
        for (let i = b.ticks.length - 1; i >= 0; i--) {
          const tk = b.ticks[i]!;
          if (tk.slot <= now - p.dipHighWindow) break;
          if (tk.price > high) {
            high = tk.price;
            highRq = tk.realSol;
          }
        }
        if (high <= 0 || highRq < p.dipMinHighRealSol) continue;
        // Flow over the last few trades: last one a buy, >= minBuys buys, net SOL >= 0.
        let lastBuy = false;
        let buys = 0;
        let net = 0n;
        let n = 0;
        for (let i = b.ticks.length - 1; i >= 0 && n < p.dipFlowTrades; i--) {
          const tk = b.ticks[i]!;
          n++;
          if (n === 1) lastBuy = tk.isBuy;
          if (tk.isBuy) buys++;
          net += tk.isBuy ? tk.sol : -tk.sol;
        }
        if (!lastBuy || buys < p.dipMinBuys || net < 0n) continue;
        const res = curveReserves(mint);
        if (res === undefined || res.vt === 0n) continue;
        const price = Number(res.vq) / Number(res.vt);
        if (price <= 0) continue;
        const dd = 1 - price / high;
        if (dd < p.dipMin || dd > p.dipMax) continue;
        let amount = p.dipTranche;
        const capBuy = (state.maxBuyLamports(mint) * 97n) / 100n;
        if (amount > capBuy) amount = capBuy;
        if (amount > p.dipMaxPosition) amount = p.dipMaxPosition;
        if (amount < 10_000_000n || free < amount + tx) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        b.committed = amount;
        b.entryPrice = price;
        b.entrySlot = now;
        open += 1;
      }
      return orders;
    },
  };
}
