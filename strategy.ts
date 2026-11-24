// Survivor breakout — pump.fun bonding-curve paper bot, agent-fun/replay/v2.
//
// Idea (original; differs from the kit pilots): do NOT buy launches and do
// NOT buy dips. Buy only coins that have already survived their first
// minutes and proven real demand, then ride the breakout:
//
//   - old enough to have a tape (age >= minAge slots since CreateEvent),
//     young enough that the run is not over (age <= maxAge),
//   - real SOL reserves already meaningful and still pre-graduation
//     (minRqSol..maxRqSol): buyers have put real money in,
//   - broad demand: at least minBuyers distinct buyers, net SOL inflow
//     (buys minus sells) at least minNetSol, and no single buyer over
//     maxTopBuyerShare of all buy SOL (a launch bundled by one wallet
//     is a dump in waiting),
//   - price within (1 - maxDd) of its high since creation: the coin is
//     at/near its high, not bouncing off a collapse,
//   - the creator has never sold.
//
// One buy per coin, small and fixed (stakeSol, capped by the harness's
// 1%-of-real-reserve size cap and by cash). Exits are mechanical: a stop
// loss against cost, a trailing stop once the position is up, a take
// profit, a creator-sell exit, a stale exit, and a hard time limit. A
// curve that completes is closed by the replay at its final reserves.
//
// Calibration (dev window, tools/sim.ts offline port + grade-local):
//   - At age 50 slots the entry rule selects ~122 of 1222 coins; of
//     those, 29 go on to >=2x their entry price, 44 to >=1.5x, only 11
//     ever fall below entry — against the sniper pilot's 46 wins / 299
//     losses on the same window. The rule is structural (real SOL +
//     breadth + flow), not a fitted grid cell.
//   - v1 (this file): single 0.1 SOL buy, SL -20%, trail -30% armed at
//     +40%, TP +100%, max hold 2500 slots. Dev: -1.51 SOL.
//   - The calibration that followed (v2-v56, each measured on the dev
//     window with the offline sim port; the full log is in NOTES):
//     tight stops beat wide ones (a -10% stop cuts the -33% average
//     loss to -18%); small stakes beat big ones (0.015 SOL: less price
//     impact per trade); entering later beats entering early (minAge 100
//     instead of 20: the youngest spikes are noise); a short maxHold
//     (1500 slots) beats a long one; and capping real SOL at 20 removes
//     the overheated giants — the 3 biggest losers of v48 all entered at
//     rq ~46, buyers ~76, price exactly at their high.
//     The shipped settings are v56. Dev (offline sim, all 3 parts):
//     +0.0029 SOL, 59 trips, 9 wins, 0 trips worse than -0.01 SOL,
//     max drawdown 0.6%, 59 distinct mints (guardrail: >= 20).
//     The margin is a hair above zero: the dev window is nearly
//     efficient after fees, and the final window is a different 24h —
//     the stress run decides whether this is robust or a coin flip.
//
// Deterministic by construction: no clock, no randomness, no I/O;
// iteration only over insertion-ordered maps fed by the batch stream,
// plus sorted held-mint lists for exits.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Slots since CreateEvent before an entry is allowed. */
  minAge: number;
  /** Slots since CreateEvent after which no first entry is allowed. */
  maxAge: number;
  /** Real SOL reserve window at decision time. */
  minRqSol: number;
  maxRqSol: number;
  /** Distinct buyers (all time) required. */
  minBuyers: number;
  /** Net SOL inflow (buys minus sells, all time) required. */
  minNetSol: number;
  /** Largest single buyer's share of all buy SOL, at most. */
  maxTopBuyerShare: number;
  /** Price must be at least this share of its high since creation. */
  minNearHigh: number;
  /** ...and at most this share: buying exactly at the high (1.00) is
      buying the top of a blow-off; the winners enter ~10% off it. */
  maxNearHigh: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** SOL to put into one position (one buy; the 1% reserve cap applies). */
  stakeSol: number;
  /** Smallest buy worth sending. */
  minBuySol: number;
  /** Slippage on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Exits. */
  stopLoss: number;
  trail: number;
  /** The trailing stop arms once value reached cost * (1 + trailArm). */
  trailArm: number;
  /** Take profit: sell all once value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** First take-profit: sell tp1Part of the tokens once value reaches
      cost * (1 + tp1); the rest rides on. 0 = off. */
  tp1: number;
  tp1Part: number;
  /** Entry also needs CURRENT demand: net SOL inflow over the last
      flowWindow slots at least minRecentFlowSol, from at least
      minRecentBuyers distinct buyers. */
  flowWindow: number;
  minRecentFlowSol: number;
  minRecentBuyers: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Exit when no trade has hit the coin for this many slots. */
  staleSlots: number;
  /** Most main positions open at once. */
  maxMain: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 100,
  maxAge: 400,
  minRqSol: 5,
  maxRqSol: 20,
  minBuyers: 15,
  minNetSol: 3,
  maxTopBuyerShare: 0.4,
  minNearHigh: 0.85,
  maxNearHigh: 1.0,
  skipDevSold: true,
  stakeSol: 0.015,
  minBuySol: 0.01,
  buySlipBps: 500,
  stopLoss: 0.1,
  trail: 0.3,
  trailArm: 0.3,
  takeProfit: 0.75,
  tp1: 0,
  tp1Part: 0,
  flowWindow: 150,
  minRecentFlowSol: 0,
  minRecentBuyers: 0,
  maxHold: 1500,
  exitOnDevSell: true,
  staleSlots: 800,
  maxMain: 5,
  maxExposureSol: 1.0,
};

export const PARAMS: Record<string, Params> = {
  v1: { ...DEFAULT_PARAMS },
  v2: { ...DEFAULT_PARAMS, takeProfit: 1.5 },
  v3: { ...DEFAULT_PARAMS, takeProfit: 1.5, trailArm: 0.25, trail: 0.25 },
  v4: { ...DEFAULT_PARAMS, takeProfit: 1.5, minBuyers: 12, minNetSol: 2, maxAge: 600 },
  v5: { ...DEFAULT_PARAMS, takeProfit: 1.5, trailArm: 0.25, trail: 0.25, minBuyers: 12, minNetSol: 2, maxAge: 600 },
  // v6: wide-stop hold — let runners run to completion; losers are cut at
  // -50% instead of -20% (memecoin noise is wider than 20%).
  v6: { ...DEFAULT_PARAMS, stopLoss: 0.5, trail: 0.4, trailArm: 1.0, takeProfit: 3.0, maxHold: 5000, stakeSol: 0.05 },
  // v7: tight trailing stop armed early — exit on the first 12% fade.
  v7: { ...DEFAULT_PARAMS, stopLoss: 0.2, trail: 0.12, trailArm: 0.15, takeProfit: 1.0 },
  // v8: v1 exits, but buys refuse to chase spikes (500bps slippage).
  v8: { ...DEFAULT_PARAMS, buySlipBps: 500 },
  // v9: v6 exits on a smaller stake (0.03 SOL): losers cost less.
  v9: { ...DEFAULT_PARAMS, stopLoss: 0.5, trail: 0.4, trailArm: 1.0, takeProfit: 3.0, maxHold: 5000, stakeSol: 0.03 },
  // v10: tighter stop (-12%) with v1's other exits.
  v10: { ...DEFAULT_PARAMS, stopLoss: 0.12, takeProfit: 1.5 },
  // v11: hold-to-the-moon — no fixed TP, very wide trail, long hold.
  v11: { ...DEFAULT_PARAMS, stopLoss: 0.5, trail: 0.5, trailArm: 1.0, takeProfit: 10.0, maxHold: 10000, stakeSol: 0.03 },
  // v12: v11 but enter later (minAge 100) — more proven demand.
  v12: { ...DEFAULT_PARAMS, stopLoss: 0.5, trail: 0.5, trailArm: 1.0, takeProfit: 10.0, maxHold: 10000, stakeSol: 0.03, minAge: 100 },
  // v13: v9 exits + tight buy slippage (don't chase spikes).
  v13: { ...DEFAULT_PARAMS, stopLoss: 0.5, trail: 0.4, trailArm: 1.0, takeProfit: 3.0, maxHold: 5000, stakeSol: 0.03, buySlipBps: 500 },
  // v14: v13 + tighter trail (0.20) armed earlier (0.30).
  v14: { ...DEFAULT_PARAMS, stopLoss: 0.5, trail: 0.2, trailArm: 0.3, takeProfit: 3.0, maxHold: 5000, stakeSol: 0.03, buySlipBps: 500 },
  // v15: v13 + trail 0.25 armed at +50%.
  v15: { ...DEFAULT_PARAMS, stopLoss: 0.5, trail: 0.25, trailArm: 0.5, takeProfit: 3.0, maxHold: 5000, stakeSol: 0.03, buySlipBps: 500 },
  // v16: v13 + partial TP (bank half at +100%, rest rides).
  v16: { ...DEFAULT_PARAMS, stopLoss: 0.5, trail: 0.4, trailArm: 1.0, takeProfit: 3.0, maxHold: 5000, stakeSol: 0.03, buySlipBps: 500, tp1: 1.0, tp1Part: 0.5 },
  // v17: v13 + partial TP at +50% + tighter trail.
  v17: { ...DEFAULT_PARAMS, stopLoss: 0.5, trail: 0.25, trailArm: 0.3, takeProfit: 3.0, maxHold: 5000, stakeSol: 0.03, buySlipBps: 500, tp1: 0.5, tp1Part: 0.5 },
  // v18: v16 + tighter stop (-25%): losers bleed less.
  v18: { ...DEFAULT_PARAMS, stopLoss: 0.25, trail: 0.4, trailArm: 1.0, takeProfit: 3.0, maxHold: 5000, stakeSol: 0.03, buySlipBps: 500, tp1: 1.0, tp1Part: 0.5 },
  // v19: v16 + current-demand filter (net +1 SOL / 5 buyers over 150 slots).
  v19: { ...DEFAULT_PARAMS, stopLoss: 0.5, trail: 0.4, trailArm: 1.0, takeProfit: 3.0, maxHold: 5000, stakeSol: 0.03, buySlipBps: 500, tp1: 1.0, tp1Part: 0.5, minRecentFlowSol: 1.0, minRecentBuyers: 5 },
  // v20: v19 + tighter stop (-25%).
  v20: { ...DEFAULT_PARAMS, stopLoss: 0.25, trail: 0.4, trailArm: 1.0, takeProfit: 3.0, maxHold: 5000, stakeSol: 0.03, buySlipBps: 500, tp1: 1.0, tp1Part: 0.5, minRecentFlowSol: 1.0, minRecentBuyers: 5 },
  // v21: tight stop (-10%) + TP +75% (offline grid's best cell: +2.7%/trade).
  v21: { ...DEFAULT_PARAMS, stopLoss: 0.10, trail: 0.4, trailArm: 1.0, takeProfit: 0.75, maxHold: 5000, stakeSol: 0.03, buySlipBps: 500 },
  // v22: tight stop (-10%) + TP +100% + partial TP at +100%.
  v22: { ...DEFAULT_PARAMS, stopLoss: 0.10, trail: 0.4, trailArm: 1.0, takeProfit: 1.0, maxHold: 5000, stakeSol: 0.03, buySlipBps: 500, tp1: 1.0, tp1Part: 0.5 },
  // v23: stop -15% + TP +75%.
  v23: { ...DEFAULT_PARAMS, stopLoss: 0.15, trail: 0.4, trailArm: 1.0, takeProfit: 0.75, maxHold: 5000, stakeSol: 0.03, buySlipBps: 500 },
  // v24: stop -10% + tight trail (0.25 armed at +30%) + TP +75%.
  v24: { ...DEFAULT_PARAMS, stopLoss: 0.10, trail: 0.25, trailArm: 0.3, takeProfit: 0.75, maxHold: 5000, stakeSol: 0.03, buySlipBps: 500 },
  // v25: v21 + bigger stake (0.10 SOL): fixed tx fees shrink as a share.
  v25: { ...DEFAULT_PARAMS, stopLoss: 0.10, trail: 0.4, trailArm: 1.0, takeProfit: 0.75, maxHold: 5000, stakeSol: 0.10, buySlipBps: 500 },
  // v26: v21 + bigger stake + tighter buy slippage (250bps).
  v26: { ...DEFAULT_PARAMS, stopLoss: 0.10, trail: 0.4, trailArm: 1.0, takeProfit: 0.75, maxHold: 5000, stakeSol: 0.10, buySlipBps: 250 },
  // v27: v24 + bigger stake (0.10 SOL).
  v27: { ...DEFAULT_PARAMS, stopLoss: 0.10, trail: 0.25, trailArm: 0.3, takeProfit: 0.75, maxHold: 5000, stakeSol: 0.10, buySlipBps: 500 },
  // v28: v24 + strength-ordered entries (strongest signals take slots first).
  v28: { ...DEFAULT_PARAMS, stopLoss: 0.10, trail: 0.25, trailArm: 0.3, takeProfit: 0.75, maxHold: 5000, stakeSol: 0.03, buySlipBps: 500 },
  // v29: v28 + minAge 50 (skip the youngest, noisiest entries).
  v29: { ...DEFAULT_PARAMS, stopLoss: 0.10, trail: 0.25, trailArm: 0.3, takeProfit: 0.75, maxHold: 5000, stakeSol: 0.03, buySlipBps: 500, minAge: 50 },
  // v30: v28 + current-demand filter.
  v30: { ...DEFAULT_PARAMS, stopLoss: 0.10, trail: 0.25, trailArm: 0.3, takeProfit: 0.75, maxHold: 5000, stakeSol: 0.03, buySlipBps: 500, minRecentFlowSol: 1.0, minRecentBuyers: 5 },
  // v31: v29 + minAge 100.
  v31: { ...DEFAULT_PARAMS, stopLoss: 0.10, trail: 0.25, trailArm: 0.3, takeProfit: 0.75, maxHold: 5000, stakeSol: 0.03, buySlipBps: 500, minAge: 100 },
  // v32: v29 + minAge 150.
  v32: { ...DEFAULT_PARAMS, stopLoss: 0.10, trail: 0.25, trailArm: 0.3, takeProfit: 0.75, maxHold: 5000, stakeSol: 0.03, buySlipBps: 500, minAge: 150 },
  // v33: v29 + maxAge 200 (enter only at 50-200 slots).
  v33: { ...DEFAULT_PARAMS, stopLoss: 0.10, trail: 0.25, trailArm: 0.3, takeProfit: 0.75, maxHold: 5000, stakeSol: 0.03, buySlipBps: 500, minAge: 50, maxAge: 200 },
  // v34: minAge 100 + maxAge 300.
  v34: { ...DEFAULT_PARAMS, stopLoss: 0.10, trail: 0.25, trailArm: 0.3, takeProfit: 0.75, maxHold: 5000, stakeSol: 0.03, buySlipBps: 500, minAge: 100, maxAge: 300 },
  // v35: v31 + TP +100% (let winners run further).
  v35: { ...DEFAULT_PARAMS, stopLoss: 0.10, trail: 0.25, trailArm: 0.3, takeProfit: 1.0, maxHold: 5000, stakeSol: 0.03, buySlipBps: 500, minAge: 100 },
  // v36: v31 + looser trail (0.30).
  v36: { ...DEFAULT_PARAMS, stopLoss: 0.10, trail: 0.30, trailArm: 0.3, takeProfit: 0.75, maxHold: 5000, stakeSol: 0.03, buySlipBps: 500, minAge: 100 },
  // v37: v31 + stricter entry (buyers 20, net 5 SOL).
  v37: { ...DEFAULT_PARAMS, stopLoss: 0.10, trail: 0.25, trailArm: 0.3, takeProfit: 0.75, maxHold: 5000, stakeSol: 0.03, buySlipBps: 500, minAge: 100, minBuyers: 20, minNetSol: 5 },
  // v38: v31 + TP +100% + stricter entry.
  v38: { ...DEFAULT_PARAMS, stopLoss: 0.10, trail: 0.25, trailArm: 0.3, takeProfit: 1.0, maxHold: 5000, stakeSol: 0.03, buySlipBps: 500, minAge: 100, minBuyers: 20, minNetSol: 5 },
  // v39: v31 + loose trail (0.50 armed at +50%) + TP +150%.
  v39: { ...DEFAULT_PARAMS, stopLoss: 0.10, trail: 0.50, trailArm: 0.5, takeProfit: 1.5, maxHold: 5000, stakeSol: 0.03, buySlipBps: 500, minAge: 100 },
  // v40: v11 exits at minAge 100 (trail 0.50 armed +100%, TP +300%).
  v40: { ...DEFAULT_PARAMS, stopLoss: 0.50, trail: 0.50, trailArm: 1.0, takeProfit: 3.0, maxHold: 10000, stakeSol: 0.03, buySlipBps: 500, minAge: 100 },
  // v41: v36 + fast stale exit (300 slots) + maxHold 2000.
  v41: { ...DEFAULT_PARAMS, stopLoss: 0.10, trail: 0.30, trailArm: 0.3, takeProfit: 0.75, maxHold: 2000, stakeSol: 0.03, buySlipBps: 500, minAge: 100, staleSlots: 300 },
  // v42: v36 + maxHold 1500.
  v42: { ...DEFAULT_PARAMS, stopLoss: 0.10, trail: 0.30, trailArm: 0.3, takeProfit: 0.75, maxHold: 1500, stakeSol: 0.03, buySlipBps: 500, minAge: 100 },
  // v43: v36 with the stop effectively off (-50%): only trail/TP/time exit.
  v43: { ...DEFAULT_PARAMS, stopLoss: 0.50, trail: 0.30, trailArm: 0.3, takeProfit: 0.75, maxHold: 5000, stakeSol: 0.03, buySlipBps: 500, minAge: 100 },
  // v44: v42 + partial TP (bank half at +75%).
  v44: { ...DEFAULT_PARAMS, stopLoss: 0.10, trail: 0.30, trailArm: 0.3, takeProfit: 0.75, maxHold: 1500, stakeSol: 0.03, buySlipBps: 500, minAge: 100, tp1: 0.75, tp1Part: 0.5 },
  // v45: v42 + smaller stake (0.02 SOL).
  v45: { ...DEFAULT_PARAMS, stopLoss: 0.10, trail: 0.30, trailArm: 0.3, takeProfit: 0.75, maxHold: 1500, stakeSol: 0.02, buySlipBps: 500, minAge: 100 },
  // v46: v42 + tighter buy slippage (250bps).
  v46: { ...DEFAULT_PARAMS, stopLoss: 0.10, trail: 0.30, trailArm: 0.3, takeProfit: 0.75, maxHold: 1500, stakeSol: 0.03, buySlipBps: 250, minAge: 100 },
  // v47: v42 + minAge 120, maxAge 300.
  v47: { ...DEFAULT_PARAMS, stopLoss: 0.10, trail: 0.30, trailArm: 0.3, takeProfit: 0.75, maxHold: 1500, stakeSol: 0.03, buySlipBps: 500, minAge: 120, maxAge: 300 },
  // v48: v45 + stake 0.015 SOL.
  v48: { ...DEFAULT_PARAMS, stopLoss: 0.10, trail: 0.30, trailArm: 0.3, takeProfit: 0.75, maxHold: 1500, stakeSol: 0.015, buySlipBps: 500, minAge: 100 },
  // v49: v45 + stake 0.01 SOL (the guardrail floor for a round trip).
  v49: { ...DEFAULT_PARAMS, stopLoss: 0.10, trail: 0.30, trailArm: 0.3, takeProfit: 0.75, maxHold: 1500, stakeSol: 0.01, buySlipBps: 500, minAge: 100 },
  // v50: v45 + minAge 80 (a few more entries at the small stake).
  v50: { ...DEFAULT_PARAMS, stopLoss: 0.10, trail: 0.30, trailArm: 0.3, takeProfit: 0.75, maxHold: 1500, stakeSol: 0.02, buySlipBps: 500, minAge: 80 },
  // v51: v48 + cap real SOL at 25 (the hottest giants dump hardest).
  v51: { ...DEFAULT_PARAMS, stopLoss: 0.10, trail: 0.30, trailArm: 0.3, takeProfit: 0.75, maxHold: 1500, stakeSol: 0.015, buySlipBps: 500, minAge: 100, maxRqSol: 25 },
  // v52: v51 + don't buy exactly at the high (max 0.97 of high).
  v52: { ...DEFAULT_PARAMS, stopLoss: 0.10, trail: 0.30, trailArm: 0.3, takeProfit: 0.75, maxHold: 1500, stakeSol: 0.015, buySlipBps: 500, minAge: 100, maxRqSol: 25, maxNearHigh: 0.97 },
  // v53: v48 + maxNearHigh 0.97 alone.
  v53: { ...DEFAULT_PARAMS, stopLoss: 0.10, trail: 0.30, trailArm: 0.3, takeProfit: 0.75, maxHold: 1500, stakeSol: 0.015, buySlipBps: 500, minAge: 100, maxNearHigh: 0.97 },
  // v54: v51 + stake 0.02 SOL.
  v54: { ...DEFAULT_PARAMS, stopLoss: 0.10, trail: 0.30, trailArm: 0.3, takeProfit: 0.75, maxHold: 1500, stakeSol: 0.02, buySlipBps: 500, minAge: 100, maxRqSol: 25 },
  // v55: v51 + TP +100%.
  v55: { ...DEFAULT_PARAMS, stopLoss: 0.10, trail: 0.30, trailArm: 0.3, takeProfit: 1.0, maxHold: 1500, stakeSol: 0.015, buySlipBps: 500, minAge: 100, maxRqSol: 25 },
  // v56: v51 + maxRqSol 20.
  v56: { ...DEFAULT_PARAMS, stopLoss: 0.10, trail: 0.30, trailArm: 0.3, takeProfit: 0.75, maxHold: 1500, stakeSol: 0.015, buySlipBps: 500, minAge: 100, maxRqSol: 20 },
  // v57: v51 + maxRqSol 30.
  v57: { ...DEFAULT_PARAMS, stopLoss: 0.10, trail: 0.30, trailArm: 0.3, takeProfit: 0.75, maxHold: 1500, stakeSol: 0.015, buySlipBps: 500, minAge: 100, maxRqSol: 30 },
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface TradeTick {
  slot: number;
  buy: boolean;
  sol: number;
  user: Pubkey;
}

interface Tape {
  created: number | null;
  creator: Pubkey | null;
  devSold: boolean;
  trades: number;
  buySol: number;
  sellSol: number;
  buyers: Map<Pubkey, number>;
  topBuy: number;
  high: number;
  lastPrice: number;
  lastRqSol: number;
  lastTradeSlot: number;
  entered: boolean;
  recent: TradeTick[];
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  devSoldAtOpen: boolean;
  tookTp: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        created: null, creator: null, devSold: false, trades: 0,
        buySol: 0, sellSol: 0, buyers: new Map(), topBuy: 0,
        high: 0, lastPrice: 0, lastRqSol: 0, lastTradeSlot: -1,
        entered: false, recent: [],
      };
      tapes.set(mint, t);
    }
    return t;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          t.trades++;
          t.lastPrice = price;
          t.lastRqSol = Number(e.real_quote_reserves) / LAMPORTS;
          t.lastTradeSlot = e.slot;
          if (price > t.high) t.high = price;
          t.recent.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user });
          if (e.is_buy) {
            t.buySol += sol;
            const prev = t.buyers.get(e.user) ?? 0;
            t.buyers.set(e.user, prev + sol);
            if (prev + sol > t.topBuy) t.topBuy = prev + sol;
          } else {
            t.sellSol += sol;
            if (t.creator !== null && e.user === t.creator) t.devSold = true;
          }
          traded.add(e.mint);
        }
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first, held mints in sorted order (deterministic).
      for (const mint of [...held.keys()].sort()) {
        if (orders.length >= cap) break;
        const h = held.get(mint)!;
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) held.delete(mint);
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        // Partial take-profit first: bank half at tp1, let the rest ride.
        // The sim reduces cost pro-rata on a partial sell, so later exits
        // compare against the remainder's cost; reset the peak so the
        // trailing stop arms off the post-TP value, not the pre-TP peak.
        if (!h.tookTp && p.tp1Part > 0 && value >= cost * (1 + p.tp1)) {
          let sellPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          }
          if (!sellPending && orders.length < cap) {
            const sellTokens = BigInt(pos.token_amount) * BigInt(Math.round(p.tp1Part * 10000)) / 10000n;
            if (sellTokens > 0n && sellTokens < BigInt(pos.token_amount)) {
              orders.push({ side: 'sell', mint, token_amount: sellTokens, max_slippage_bps: 10_000 });
              h.tookTp = true;
              // Re-arm the trailing stop from the post-TP values.
              h.peakValue = 0;
              continue;
            }
          }
        }
        let exit = h.exiting;
        const t = tapeOf(mint);
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit && p.exitOnDevSell && t.devSold && !h.devSoldAtOpen) exit = true;
        if (!exit && now - t.lastTradeSlot > p.staleSlots) exit = true;
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Entries: only coins that traded this batch (their tape just changed).
      // Candidates are ranked by signal strength (net inflow, then buyers)
      // and the strongest take the scarce position slots first: during hot
      // bursts many coins trigger at once and first-come-first-served
      // spends slots on whichever the batch order lists first.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = Math.min(
        state.hello.caps.max_open_positions - state.committedPositionCount(),
        p.maxMain - held.size,
      );
      let exposure = 0;
      for (const [mint, h] of held) {
        exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      const candidates: { mint: Pubkey; net: number; buyers: number }[] = [];
      for (const mint of traded) {
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || held.has(mint)) continue;
        const t = tapes.get(mint)!;
        if (t.entered || t.created === null) continue;
        const age = now - t.created;
        if (age < p.minAge || age > p.maxAge) continue;
        if (t.devSold && p.skipDevSold) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rqSol < p.minRqSol || rqSol > p.maxRqSol) continue;
        if (t.buyers.size < p.minBuyers) continue;
        const net = t.buySol - t.sellSol;
        if (net < p.minNetSol) continue;
        if (t.buySol > 0 && t.topBuy > p.maxTopBuyerShare * t.buySol) continue;
        if (t.high <= 0 || t.lastPrice < t.high * p.minNearHigh) continue;
        if (t.lastPrice > t.high * p.maxNearHigh) continue;
        if (p.minRecentFlowSol > 0 || p.minRecentBuyers > 0) {
          let cut = 0;
          while (cut < t.recent.length && t.recent[cut]!.slot <= now - p.flowWindow) cut++;
          if (cut > 0) t.recent.splice(0, cut);
          let flow = 0;
          const recentBuyers = new Set<Pubkey>();
          for (const tk of t.recent) {
            flow += tk.buy ? tk.sol : -tk.sol;
            if (tk.buy) recentBuyers.add(tk.user);
          }
          if (flow < p.minRecentFlowSol) continue;
          if (recentBuyers.size < p.minRecentBuyers) continue;
        }
        candidates.push({ mint, net, buyers: t.buyers.size });
      }
      candidates.sort((a, b) => (b.net - a.net) || (b.buyers - a.buyers) || (a.mint < b.mint ? -1 : 1));
      for (const { mint } of candidates) {
        if (orders.length >= cap) break;
        if (slotsLeft <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const t = tapes.get(mint)!;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, {
          opened: now, peakValue: 0, invested: amount,
          exiting: false, filled: false, devSoldAtOpen: t.devSold,
          tookTp: false,
        });
        t.entered = true;
        slotsLeft--;
      }
      return orders;
    },
  };
}
