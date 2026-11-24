// Survivor-breakout paper bot (rewrite, 24 Nov 2026).
//
// Idea, in one paragraph: most pump.fun coins die young, and the ones that
// complete do it in their first slot, before our 2-slot latency can reach
// them - so do not chase completes or early momentum. Buy only coins that
// have already proven real demand by surviving a while: old enough, a
// healthy amount of real SOL in the curve (not too little, not overheated),
// many distinct buyers, net SOL flowing in, no single buyer dominating,
// price still near its high, and a creator who has never sold. One small
// buy per coin, then purely mechanical exits: a tight stop, a take profit,
// a trailing stop off the peak, a creator-sell exit, a stale exit and a
// maximum hold. Everything is deterministic: no clock, no randomness, no
// I/O; iteration follows first-seen order and sells are sorted by mint.
//
// Money is bigint lamports; prices are plain numbers (virtual quote per
// virtual token) used only for ratio comparisons against thresholds.
import type { Batch, Bot, BotState, OrderInput } from './vendor/makefun-bot.ts';

export interface SurvivorParams {
  /** Minimum coin age in slots before it may be bought. */
  minAgeSlots: number;
  /** Real SOL in the curve at buy time must lie in [minRealSol, maxRealSol]. */
  minRealSol: number;
  maxRealSol: number;
  /** Minimum distinct buyers seen on the coin. */
  minBuyers: number;
  /** Minimum net SOL inflow (buys minus sells) seen on the coin. */
  minNetSol: number;
  /** No single buyer may account for more than this share of buy volume. */
  maxSingleBuyerShare: number;
  /** Buy only while the mark is at least this fraction of the coin's high. */
  minPriceVsHigh: number;
  /** SOL spent per buy (before curve fees). */
  stakeSol: number;
  /** Sell when the mark falls this far below the entry price. */
  stopLossPct: number;
  /** Sell when the mark rises this far above the entry price. */
  takeProfitPct: number;
  /** Sell when the mark falls this far below the best price since entry. */
  trailingDropPct: number;
  /** Sell after holding this many slots, whatever the price. */
  maxHoldSlots: number;
  /** Sell when the coin has not traded for this many slots. */
  staleSlots: number;
  /** Slippage tolerance on every order, in basis points. */
  maxSlippageBps: number;
  /** Buy slippage (default: maxSlippageBps). Tight buys filter bad fills. */
  buySlippageBps?: number;
  /** Sell slippage (default: maxSlippageBps). Wide sells exit on time. */
  sellSlippageBps?: number;
  /**
   * Trailing stop only arms once the peak is this far above entry
   * (0 = armed from entry). Lets a fresh position breathe before the
   * trail can cut it.
   */
  trailArmPct?: number;
  /**
   * How the entry price is measured: 'cost' = filled cost per token
   * (fees included), 'decision' = the mark when the buy was decided.
   */
  entryPriceMode: 'cost' | 'decision';
  /**
   * Which reserves define "price" for the ENTRY filter (the 85%-of-high
   * check and the recorded high): 'virtual' = virtual quote per virtual
   * token (the execution price), 'real' = real quote per real token.
   * The two move differently because the virtual offsets dampen moves,
   * so the choice changes how strict the filter is.
   */
  priceMode: 'virtual' | 'real';
  /**
   * Which reserves define "price" for EXITS (stop / take profit /
   * trailing stop) and the entry-price measurement. Defaults to
   * 'virtual', the execution price: real prices are far jumpier, so a
   * trailing stop measured on them cuts winners early.
   */
  exitPriceMode?: 'virtual' | 'real';
  /** Age counts from 'create' (CreateEvent slot) or 'trade' (first trade). */
  ageFrom: 'create' | 'trade';
}

export const DEFAULT_PARAMS: SurvivorParams = {
  // v56 base (age 100, real SOL 5-20, buyers 15, net 3, share 0.40,
  // 85% of high, stake 0.015, stop -10%, TP +75%, trail 0.30, hold 1500,
  // stale 300) re-tuned by a small offline sweep on the dev window:
  // the 85%-of-high check and the exits are sharpest on REAL reserves
  // (virtual offsets dampen moves and let weak coins in), the crowd
  // filter wants 30 distinct buyers with no one over 30%, sells need a
  // wide slippage so exits execute on time (buys stay tight at 500),
  // and a bigger stake amortises the fixed per-trade tx fees.
  minAgeSlots: 100,
  minRealSol: 5,
  maxRealSol: 20,
  minBuyers: 30,
  minNetSol: 3,
  maxSingleBuyerShare: 0.3,
  minPriceVsHigh: 0.85,
  stakeSol: 0.04,
  stopLossPct: 0.1,
  takeProfitPct: 0.75,
  trailingDropPct: 0.35,
  maxHoldSlots: 1500,
  staleSlots: 600,
  maxSlippageBps: 500,
  sellSlippageBps: 10000,
  entryPriceMode: 'cost',
  priceMode: 'real',
  ageFrom: 'create',
};

// Small named alternates for offline tuning; `default` is what ships.
export const PARAMS: Record<string, SurvivorParams> = {
  default: DEFAULT_PARAMS,
  age150: { ...DEFAULT_PARAMS, minAgeSlots: 150 },
  tightStop: { ...DEFAULT_PARAMS, stopLossPct: 0.08 },
  wideTrail: { ...DEFAULT_PARAMS, trailingDropPct: 0.4 },
  stake001: { ...DEFAULT_PARAMS, stakeSol: 0.01 },
  tp100: { ...DEFAULT_PARAMS, takeProfitPct: 1.0 },
  stale600: { ...DEFAULT_PARAMS, staleSlots: 600 },
  cap30: { ...DEFAULT_PARAMS, maxRealSol: 30 },
  age150: { ...DEFAULT_PARAMS, minAgeSlots: 150 },
  age200: { ...DEFAULT_PARAMS, minAgeSlots: 200 },
  buyers20: { ...DEFAULT_PARAMS, minBuyers: 20 },
  buyers25: { ...DEFAULT_PARAMS, minBuyers: 25 },
  net5: { ...DEFAULT_PARAMS, minNetSol: 5 },
  net8: { ...DEFAULT_PARAMS, minNetSol: 8 },
  cap15: { ...DEFAULT_PARAMS, maxRealSol: 15 },
  cap12: { ...DEFAULT_PARAMS, maxRealSol: 12 },
  vsHigh90: { ...DEFAULT_PARAMS, minPriceVsHigh: 0.9 },
  vsHigh95: { ...DEFAULT_PARAMS, minPriceVsHigh: 0.95 },
  share30: { ...DEFAULT_PARAMS, maxSingleBuyerShare: 0.3 },
  combo1: { ...DEFAULT_PARAMS, minAgeSlots: 150, minBuyers: 20, minNetSol: 5 },
  combo2: { ...DEFAULT_PARAMS, minAgeSlots: 150, maxRealSol: 15, minPriceVsHigh: 0.9 },
  combo3: { ...DEFAULT_PARAMS, minBuyers: 20, minNetSol: 5, maxRealSol: 15 },
  combo4: { ...DEFAULT_PARAMS, minAgeSlots: 150, minBuyers: 20, minNetSol: 5, maxRealSol: 15 },
  combo5: { ...DEFAULT_PARAMS, minAgeSlots: 200, minBuyers: 20, minNetSol: 5 },
  trail020: { ...DEFAULT_PARAMS, trailingDropPct: 0.2 },
  stop008: { ...DEFAULT_PARAMS, stopLossPct: 0.08 },
  slip1000: { ...DEFAULT_PARAMS, maxSlippageBps: 1000 },
  slip2000: { ...DEFAULT_PARAMS, maxSlippageBps: 2000 },
  slipMax: { ...DEFAULT_PARAMS, maxSlippageBps: 10000 },
  decPrice: { ...DEFAULT_PARAMS, entryPriceMode: 'decision' },
  decPriceSlip: { ...DEFAULT_PARAMS, entryPriceMode: 'decision', maxSlippageBps: 2000 },
  decPriceCombo: { ...DEFAULT_PARAMS, entryPriceMode: 'decision', minBuyers: 20, minNetSol: 5, maxRealSol: 15 },
  priceReal: { ...DEFAULT_PARAMS, priceMode: 'real' },
  priceRealDec: { ...DEFAULT_PARAMS, priceMode: 'real', entryPriceMode: 'decision' },
  ageTrade: { ...DEFAULT_PARAMS, ageFrom: 'trade' },
  priceRealAgeTrade: { ...DEFAULT_PARAMS, priceMode: 'real', ageFrom: 'trade' },
  priceRealCombo: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 20, minNetSol: 5 },
  prBuyers20: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 20 },
  prBuyers25: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25 },
  prNet5: { ...DEFAULT_PARAMS, priceMode: 'real', minNetSol: 5 },
  prNet8: { ...DEFAULT_PARAMS, priceMode: 'real', minNetSol: 8 },
  prAge150: { ...DEFAULT_PARAMS, priceMode: 'real', minAgeSlots: 150 },
  prAge200: { ...DEFAULT_PARAMS, priceMode: 'real', minAgeSlots: 200 },
  prCap15: { ...DEFAULT_PARAMS, priceMode: 'real', maxRealSol: 15 },
  prVs90: { ...DEFAULT_PARAMS, priceMode: 'real', minPriceVsHigh: 0.9 },
  prStop008: { ...DEFAULT_PARAMS, priceMode: 'real', stopLossPct: 0.08 },
  prStop015: { ...DEFAULT_PARAMS, priceMode: 'real', stopLossPct: 0.15 },
  prTp100: { ...DEFAULT_PARAMS, priceMode: 'real', takeProfitPct: 1.0 },
  prTp050: { ...DEFAULT_PARAMS, priceMode: 'real', takeProfitPct: 0.5 },
  prTrail020: { ...DEFAULT_PARAMS, priceMode: 'real', trailingDropPct: 0.2 },
  prTrail040: { ...DEFAULT_PARAMS, priceMode: 'real', trailingDropPct: 0.4 },
  prStake001: { ...DEFAULT_PARAMS, priceMode: 'real', stakeSol: 0.01 },
  prStake002: { ...DEFAULT_PARAMS, priceMode: 'real', stakeSol: 0.02 },
  prStake003: { ...DEFAULT_PARAMS, priceMode: 'real', stakeSol: 0.03 },
  prComboA: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 20, minNetSol: 5, minAgeSlots: 150 },
  prComboB: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, minNetSol: 5, minAgeSlots: 150, maxRealSol: 15 },
  prComboC: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 20, minAgeSlots: 150 },
  prHold1000: { ...DEFAULT_PARAMS, priceMode: 'real', maxHoldSlots: 1000 },
  prHold2500: { ...DEFAULT_PARAMS, priceMode: 'real', maxHoldSlots: 2500 },
  prStale600: { ...DEFAULT_PARAMS, priceMode: 'real', staleSlots: 600 },
  prNoStale: { ...DEFAULT_PARAMS, priceMode: 'real', staleSlots: 100000 },
  prShare30: { ...DEFAULT_PARAMS, priceMode: 'real', maxSingleBuyerShare: 0.3 },
  sellSlip2000: { ...DEFAULT_PARAMS, sellSlippageBps: 2000 },
  sellSlipMax: { ...DEFAULT_PARAMS, sellSlippageBps: 10000 },
  prSellSlip: { ...DEFAULT_PARAMS, priceMode: 'real', sellSlippageBps: 2000 },
  prSellSlipMax: { ...DEFAULT_PARAMS, priceMode: 'real', sellSlippageBps: 10000 },
  prBuyers25Sell: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 2000 },
  prBuyers25SellMax: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000 },
  buySlip200: { ...DEFAULT_PARAMS, buySlippageBps: 200 },
  buySlip1000: { ...DEFAULT_PARAMS, buySlippageBps: 1000 },
  mixRealFilter: { ...DEFAULT_PARAMS, priceMode: 'real', exitPriceMode: 'virtual' },
  mixRealFilterDec: { ...DEFAULT_PARAMS, priceMode: 'real', exitPriceMode: 'virtual', entryPriceMode: 'decision' },
  mixB25: { ...DEFAULT_PARAMS, priceMode: 'real', exitPriceMode: 'virtual', minBuyers: 25 },
  mixB25Sell: { ...DEFAULT_PARAMS, priceMode: 'real', exitPriceMode: 'virtual', minBuyers: 25, sellSlippageBps: 2000 },
  mixB25SellMax: { ...DEFAULT_PARAMS, priceMode: 'real', exitPriceMode: 'virtual', minBuyers: 25, sellSlippageBps: 10000 },
  mixB20: { ...DEFAULT_PARAMS, priceMode: 'real', exitPriceMode: 'virtual', minBuyers: 20 },
  mixB20SellMax: { ...DEFAULT_PARAMS, priceMode: 'real', exitPriceMode: 'virtual', minBuyers: 20, sellSlippageBps: 10000 },
  mixSellMax: { ...DEFAULT_PARAMS, priceMode: 'real', exitPriceMode: 'virtual', sellSlippageBps: 10000 },
  mixComboB: { ...DEFAULT_PARAMS, priceMode: 'real', exitPriceMode: 'virtual', minBuyers: 25, minNetSol: 5, minAgeSlots: 150, maxRealSol: 15 },
  prNoTrail: { ...DEFAULT_PARAMS, priceMode: 'real', trailingDropPct: 1.0 },
  prNoTrailB25: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, trailingDropPct: 1.0 },
  prNoTrailB25Sell: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, trailingDropPct: 1.0, sellSlippageBps: 10000 },
  prTrail050: { ...DEFAULT_PARAMS, priceMode: 'real', trailingDropPct: 0.5 },
  prTrail060: { ...DEFAULT_PARAMS, priceMode: 'real', trailingDropPct: 0.6 },
  prTrail015: { ...DEFAULT_PARAMS, priceMode: 'real', trailingDropPct: 0.15 },
  prTrailArm20: { ...DEFAULT_PARAMS, priceMode: 'real', trailArmPct: 0.2 },
  prTrailArm10: { ...DEFAULT_PARAMS, priceMode: 'real', trailArmPct: 0.1 },
  prTrailArm50: { ...DEFAULT_PARAMS, priceMode: 'real', trailArmPct: 0.5 },
  prTrailArm20B25: { ...DEFAULT_PARAMS, priceMode: 'real', trailArmPct: 0.2, minBuyers: 25, sellSlippageBps: 10000 },
  noTrailV: { ...DEFAULT_PARAMS, trailingDropPct: 1.0 },
  prNoTrailSell: { ...DEFAULT_PARAMS, priceMode: 'real', trailingDropPct: 1.0, sellSlippageBps: 10000 },
  prStop020: { ...DEFAULT_PARAMS, priceMode: 'real', stopLossPct: 0.2 },
  prStop025: { ...DEFAULT_PARAMS, priceMode: 'real', stopLossPct: 0.25 },
  prStop005: { ...DEFAULT_PARAMS, priceMode: 'real', stopLossPct: 0.05 },
  prTp150: { ...DEFAULT_PARAMS, priceMode: 'real', takeProfitPct: 1.5 },
  prTp200: { ...DEFAULT_PARAMS, priceMode: 'real', takeProfitPct: 2.0 },
  prStaleF: { ...DEFAULT_PARAMS, priceMode: 'real', staleSlots: 600 },
  prNoStaleF: { ...DEFAULT_PARAMS, priceMode: 'real', staleSlots: 100000 },
  prHoldF1000: { ...DEFAULT_PARAMS, priceMode: 'real', maxHoldSlots: 1000 },
  prHoldF2500: { ...DEFAULT_PARAMS, priceMode: 'real', maxHoldSlots: 2500 },
  prTrail025: { ...DEFAULT_PARAMS, priceMode: 'real', trailingDropPct: 0.25 },
  prTrail035: { ...DEFAULT_PARAMS, priceMode: 'real', trailingDropPct: 0.35 },
  prTrail020b: { ...DEFAULT_PARAMS, priceMode: 'real', trailingDropPct: 0.2 },
  prB25T025: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, trailingDropPct: 0.25, sellSlippageBps: 10000 },
  prB25T035: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, trailingDropPct: 0.35, sellSlippageBps: 10000 },
  prB25S020: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, stopLossPct: 0.2, sellSlippageBps: 10000 },
  prB25T025S020: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, trailingDropPct: 0.25, stopLossPct: 0.2, sellSlippageBps: 10000 },
  // --- real-exit sweeps on top of prBuyers25SellMax (best so far: -0.0168) ---
  qT020: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, trailingDropPct: 0.2 },
  qT025: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, trailingDropPct: 0.25 },
  qT035: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, trailingDropPct: 0.35 },
  qT040: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, trailingDropPct: 0.4 },
  qT100: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, trailingDropPct: 1.0 },
  qS005: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, stopLossPct: 0.05 },
  qS008: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, stopLossPct: 0.08 },
  qS015: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, stopLossPct: 0.15 },
  qS020: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, stopLossPct: 0.2 },
  qP050: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, takeProfitPct: 0.5 },
  qP100: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, takeProfitPct: 1.0 },
  qP150: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, takeProfitPct: 1.5 },
  qStale600: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, staleSlots: 600 },
  qNoStale: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, staleSlots: 100000 },
  qHold1000: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, maxHoldSlots: 1000 },
  qHold2500: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, maxHoldSlots: 2500 },
  qArm10: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, trailArmPct: 0.1 },
  qArm20: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, trailArmPct: 0.2 },
  qAge150: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, minAgeSlots: 150 },
  qNet5: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, minNetSol: 5 },
  qCap15: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, maxRealSol: 15 },
  qVs90: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, minPriceVsHigh: 0.9 },
  qShare30: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, maxSingleBuyerShare: 0.3 },
  qStake001: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, stakeSol: 0.01 },
  qStake002: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, stakeSol: 0.02 },
  r1: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.3 },
  r2: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.3, takeProfitPct: 1.5 },
  r3: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.3, takeProfitPct: 1.5, maxHoldSlots: 1000 },
  r4: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.3, stakeSol: 0.01 },
  r5: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.3, takeProfitPct: 1.5, maxHoldSlots: 1000, stakeSol: 0.01 },
  r6: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, trailingDropPct: 0.4, maxSingleBuyerShare: 0.3 },
  r7: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 30, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.3 },
  r8: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.25 },
  r9: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 20, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.3 },
  r10: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.3, stopLossPct: 0.15 },
  r11: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.3, minNetSol: 5 },
  r12: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 25, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.3, takeProfitPct: 2.0 },
  s1: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 30, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.3, takeProfitPct: 0.5 },
  s2: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 30, sellSlippageBps: 10000, trailingDropPct: 0.3, maxSingleBuyerShare: 0.3 },
  s3: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 30, sellSlippageBps: 10000, trailingDropPct: 0.4, maxSingleBuyerShare: 0.3 },
  s4: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 35, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.3 },
  s5: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 28, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.3 },
  s6: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 30, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.25 },
  s7: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 30, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.35 },
  s8: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 30, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.3, stopLossPct: 0.08 },
  s9: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 30, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.3, stopLossPct: 0.15 },
  s10: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 30, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.3, stakeSol: 0.01 },
  s11: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 30, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.3, stakeSol: 0.02 },
  s12: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 30, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.3, minNetSol: 5 },
  s13: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 30, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.3, minAgeSlots: 150 },
  s14: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 30, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.3, maxRealSol: 15 },
  s15: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 30, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.3, maxHoldSlots: 1000 },
  s16: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 30, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.3, staleSlots: 600 },
  t1: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 30, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.3, stakeSol: 0.02, staleSlots: 600 },
  t2: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 30, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.3, stakeSol: 0.02, staleSlots: 600, maxHoldSlots: 1000 },
  t3: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 30, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.3, stakeSol: 0.03 },
  t4: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 30, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.3, stakeSol: 0.025 },
  t5: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 30, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.35, stakeSol: 0.02 },
  t6: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 30, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.3, stakeSol: 0.02, stopLossPct: 0.08 },
  t7: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 30, sellSlippageBps: 10000, trailingDropPct: 0.4, maxSingleBuyerShare: 0.3, stakeSol: 0.02, staleSlots: 600 },
  t8: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 30, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.3, stakeSol: 0.02, staleSlots: 600, stopLossPct: 0.08 },
  u1: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 30, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.3, stakeSol: 0.04 },
  u2: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 30, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.3, stakeSol: 0.05 },
  u3: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 30, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.3, stakeSol: 0.03, staleSlots: 600 },
  u4: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 30, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.3, stakeSol: 0.04, staleSlots: 600 },
  u5: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 30, sellSlippageBps: 10000, trailingDropPct: 0.4, maxSingleBuyerShare: 0.3, stakeSol: 0.03 },
  u6: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 30, sellSlippageBps: 10000, trailingDropPct: 0.4, maxSingleBuyerShare: 0.3, stakeSol: 0.03, staleSlots: 600 },
  u7: { ...DEFAULT_PARAMS, priceMode: 'real', minBuyers: 30, sellSlippageBps: 10000, trailingDropPct: 0.35, maxSingleBuyerShare: 0.3, stakeSol: 0.03, minNetSol: 5 },
};

const LAMPORTS_PER_SOL = 1_000_000_000n;

interface CoinFlow {
  creator: string;
  createdSlot: number;
  buyers: Map<string, bigint>;
  buyVolumeLamports: bigint;
  netLamports: bigint;
  highPrice: number;
  creatorSold: boolean;
  lastTradeSlot: number;
}

interface Held {
  entryPrice: number;
  peakPrice: number;
  entrySlot: number;
}

function markPrice(vq: bigint, vt: bigint): number {
  if (vt <= 0n) return 0;
  return Number(vq) / Number(vt);
}

// Price of a curve under the strategy's price mode. Virtual reserves give
// the execution price; real reserves give a sharper, undamped price.
function priceOf(
  mode: 'virtual' | 'real',
  vq: bigint,
  vt: bigint,
  rq: bigint,
  rt: bigint,
): number {
  if (mode === 'real') {
    if (rt <= 0n) return 0;
    return Number(rq) / Number(rt);
  }
  return markPrice(vq, vt);
}

function currentRealPrice(state: BotState, mint: string): number {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  return priceOf('real', curve.virtual_quote_reserves, curve.virtual_token_reserves, curve.real_quote_reserves, curve.real_token_reserves);
}

function currentExitPrice(state: BotState, mint: string): number {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  return priceOf('virtual', curve.virtual_quote_reserves, curve.virtual_token_reserves, curve.real_quote_reserves, curve.real_token_reserves);
}

export function createStrategy(params: SurvivorParams = DEFAULT_PARAMS): Bot {
  const flows = new Map<string, CoinFlow>();
  const held = new Map<string, Held>();
  const bought = new Set<string>();
  const pendingBuys = new Set<string>();
  const pendingSells = new Set<string>();
  // Decision-time entry price per mint with a buy in flight (only used
  // when entryPriceMode is 'decision').
  const pendingEntry = new Map<string, { price: number; slot: number }>();
  // Coins that pass every flow check but are still too young: re-check
  // their age each batch (their flow numbers only change on a trade).
  const waiting = new Set<string>();

  function flowFor(mint: string, creator: string, slot: number): CoinFlow {
    let f = flows.get(mint);
    if (f === undefined) {
      f = {
        creator,
        createdSlot: slot,
        buyers: new Map(),
        buyVolumeLamports: 0n,
        netLamports: 0n,
        highPrice: 0,
        creatorSold: false,
        lastTradeSlot: slot,
      };
      flows.set(mint, f);
    }
    return f;
  }

  function foldEvents(batch: Batch): string[] {
    // Returns the mints that traded in this batch, first-seen order.
    const traded: string[] = [];
    const seen = new Set<string>();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const f = flowFor(e.mint, e.creator, e.slot);
        if (params.ageFrom === 'trade') f.createdSlot = -1;
      } else if (e.event === 'TradeEvent') {
        const f = flowFor(e.mint, e.creator, e.slot);
        if (params.ageFrom === 'trade' && f.createdSlot === -1) f.createdSlot = e.slot;
        const sol = BigInt(e.sol_amount);
        if (e.is_buy) {
          f.buyers.set(e.user, (f.buyers.get(e.user) ?? 0n) + sol);
          f.buyVolumeLamports += sol;
          f.netLamports += sol;
        } else {
          f.netLamports -= sol;
          if (e.user === f.creator) f.creatorSold = true;
        }
        const p = priceOf(
          params.priceMode,
          BigInt(e.virtual_quote_reserves),
          BigInt(e.virtual_token_reserves),
          BigInt(e.real_quote_reserves),
          BigInt(e.real_token_reserves),
        );
        if (p > f.highPrice) f.highPrice = p;
        f.lastTradeSlot = e.slot;
        if (!seen.has(e.mint)) {
          seen.add(e.mint);
          traded.push(e.mint);
        }
      } else {
        // CompleteEvent: nothing to aggregate; the harness closes positions.
      }
    }
    return traded;
  }

  function syncHeld(state: BotState, batch: Batch): void {
    for (const fill of batch.fills) {
      if (fill.side === 'buy' && fill.status === 'filled') {
        pendingBuys.delete(fill.mint);
        bought.add(fill.mint);
        const pos = state.positions.get(fill.mint);
        if (pos !== undefined && !held.has(fill.mint)) {
          const decided = pendingEntry.get(fill.mint);
          // Entry and exit prices must be in the same units: in real-price
          // exit mode the entry is the decision-time real price, never the
          // (virtual-unit) cost basis.
          const entry =
            (params.exitPriceMode ?? params.priceMode) === 'real'
              ? (decided?.price ?? currentRealPrice(state, fill.mint))
              : params.entryPriceMode === 'decision' && decided !== undefined
                ? decided.price
                : Number(pos.cost_lamports) / Number(pos.token_amount);
          const slot = decided !== undefined ? decided.slot : fill.slot;
          held.set(fill.mint, { entryPrice: entry, peakPrice: entry, entrySlot: slot });
        }
        pendingEntry.delete(fill.mint);
      } else if (fill.side === 'buy' && fill.status !== 'filled') {
        pendingBuys.delete(fill.mint);
        pendingEntry.delete(fill.mint);
      } else if (fill.side === 'sell') {
        pendingSells.delete(fill.mint);
        if (fill.status === 'filled') held.delete(fill.mint);
      }
    }
    // Reconcile with the account: a position with no entry record (its fill
    // arrived in a batch we did not see, or a harness close) gets one from
    // its cost basis; a held coin with no position is gone.
    for (const [mint, pos] of state.positions) {
      if (!held.has(mint)) {
        const entry =
          (params.exitPriceMode ?? params.priceMode) === 'real'
            ? currentRealPrice(state, mint)
            : Number(pos.cost_lamports) / Number(pos.token_amount);
        held.set(mint, { entryPrice: entry, peakPrice: entry, entrySlot: batch.slot });
      }
    }
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint)) held.delete(mint);
    }
  }

  function flowChecks(mint: string, state: BotState): 'ok' | 'young' | 'no' {
    const f = flows.get(mint);
    const curve = state.curves.get(mint);
    if (f === undefined || curve === undefined || curve.complete) return 'no';
    if (bought.has(mint) || held.has(mint) || pendingBuys.has(mint)) return 'no';
    const rqSol = Number(curve.real_quote_reserves) / 1e9;
    if (rqSol < params.minRealSol || rqSol > params.maxRealSol) return 'no';
    if (f.buyers.size < params.minBuyers) return 'no';
    if (Number(f.netLamports) / 1e9 < params.minNetSol) return 'no';
    if (f.buyVolumeLamports > 0n) {
      let top = 0n;
      for (const v of f.buyers.values()) if (v > top) top = v;
      if (Number(top) / Number(f.buyVolumeLamports) > params.maxSingleBuyerShare) return 'no';
    }
    if (f.creatorSold) return 'no';
    const price = priceOf(
      params.priceMode,
      curve.virtual_quote_reserves,
      curve.virtual_token_reserves,
      curve.real_quote_reserves,
      curve.real_token_reserves,
    );
    if (f.highPrice <= 0 || price < params.minPriceVsHigh * f.highPrice) return 'no';
    if (state.slot - f.createdSlot < params.minAgeSlots) return 'young';
    return 'ok';
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const traded = foldEvents(batch);
      syncHeld(state, batch);
      const orders: OrderInput[] = [];
      const txFee = state.txFeeLamports();

      // --- exits, sells first, sorted by mint for determinism ---
      for (const mint of [...held.keys()].sort()) {
        if (pendingSells.has(mint)) continue;
        const h = held.get(mint)!;
        const curve = state.curves.get(mint);
        const pos = state.positions.get(mint);
        if (curve === undefined || pos === undefined || curve.complete) continue;
        const price = priceOf(
          params.exitPriceMode ?? params.priceMode,
          curve.virtual_quote_reserves,
          curve.virtual_token_reserves,
          curve.real_quote_reserves,
          curve.real_token_reserves,
        );
        if (price <= 0) continue;
        if (price > h.peakPrice) h.peakPrice = price;
        const f = flows.get(mint);
        const ret = price / h.entryPrice - 1;
        const stale = f !== undefined && state.slot - f.lastTradeSlot >= params.staleSlots;
        const creatorSold = f !== undefined && f.creatorSold;
        const tooLong = state.slot - h.entrySlot >= params.maxHoldSlots;
        const armed = h.peakPrice >= h.entryPrice * (1 + (params.trailArmPct ?? 0));
        const trailed = armed && price <= h.peakPrice * (1 - params.trailingDropPct);
        if (
          ret <= -params.stopLossPct ||
          ret >= params.takeProfitPct ||
          trailed ||
          creatorSold ||
          stale ||
          tooLong
        ) {
          orders.push({
            side: 'sell',
            mint,
            token_amount: pos.token_amount,
            max_slippage_bps: params.sellSlippageBps ?? params.maxSlippageBps,
          });
          pendingSells.add(mint);
        }
      }

      // --- entries: coins that traded now, plus young ones waiting on age ---
      const candidates = new Set<string>(traded);
      for (const mint of waiting) candidates.add(mint);
      const stake = BigInt(Math.round(params.stakeSol * 1e9));
      for (const mint of candidates) {
        if (orders.length >= 16) break;
        const verdict = flowChecks(mint, state);
        if (verdict === 'young') {
          waiting.add(mint);
          continue;
        }
        waiting.delete(mint);
        if (verdict !== 'ok') continue;
        if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= 5) break;
        const cap = state.maxBuyLamports(mint);
        const spend = stake < cap ? stake : cap;
        if (spend <= txFee) continue;
        if (state.freeCashLamports() - BigInt(orders.filter((o) => o.side === 'buy').length) * (stake + txFee) < spend + txFee) continue;
        orders.push({ side: 'buy', mint, quote_lamports: spend, max_slippage_bps: params.buySlippageBps ?? params.maxSlippageBps });
        bought.add(mint);
        pendingBuys.add(mint);
        const curve = state.curves.get(mint);
        if (curve !== undefined) {
          pendingEntry.set(mint, {
            price: priceOf(
              params.exitPriceMode ?? params.priceMode,
              curve.virtual_quote_reserves,
              curve.virtual_token_reserves,
              curve.real_quote_reserves,
              curve.real_token_reserves,
            ),
            slot: batch.slot,
          });
        }
      }
      return orders;
    },
  };
}
