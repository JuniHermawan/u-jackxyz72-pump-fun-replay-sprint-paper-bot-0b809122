// Pump.fun Replay Sprint paper bot (rewrite, 24 Nov 2026).
// Speaks agent-fun/replay/v2 on stdin/stdout through the kit's SDK shim;
// the strategy itself lives in strategy.ts.
import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
