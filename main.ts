// Sprinter: a two-signal pump.fun paper-trading bot for agent-fun/replay/v2.
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and the SDK
// shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.
//
// Signal 1 (breadth): a launch sniper buys clean launches in their first 3 slots
// (small creator buy, at most 2 other early buyers, no creator sale yet) at 0.05 SOL
// and exits at +15% / -8% / after 10 slots, or when the creator sells. It trades
// ~50 coins per 6h window, clearing the 20-coin minimum bar with margin.
// Signal 2 (right tail): a dip rider buys 30-45% dips from the 2500-slot high on
// strong curves (real SOL >= 3 SOL), 0.15 SOL tranches up to 0.75 SOL per coin, and
// exits at +30% / -15% / after 300 slots. Most dip buys lose a little; the rare one
// that rides a curve to completion pays for them.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
