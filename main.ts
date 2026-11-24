// Survivor breakout — pump.fun bonding-curve paper bot, agent-fun/replay/v2.
//
// Buys only coins that have already survived their first minutes and proven
// real demand (real SOL reserves, broad buyers, net inflow, price near its
// high, creator never sold), then rides the breakout with mechanical exits.
// See strategy.ts for the full idea and calibration notes. Deterministic:
// no clock, no randomness, no I/O; the only randomness source the protocol
// allows (hello.seed) is never needed.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
