# Sprinter — Pump.fun Paper Sprint bot

[![make.fun bounty](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/jajanb923-netizen/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/jajanb923-netizen/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Entry for the [Pump.fun Paper Sprint bounty on make.fun](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b): one `main.ts` strategy program (Node 22, TypeScript, no dependencies) that paper-trades pump.fun bonding curves on the house replay. Paper trading only — no real funds, no fees paid, no on-chain transactions.

## The strategy

Two complementary signals share the 5 position slots and the 10 SOL of paper cash:

1. **Launch sniper (breadth).** Buys a coin in its first 3 slots when the launch
   looks clean: creator buy ≤ 2.5 SOL, at most 2 other early buyers, no creator sale
   yet, real SOL between 1 and 30. Stake 0.05 SOL. Exits at +15% / −8% / after 10
   slots, or the moment the creator sells. It trades ~50 coins per 6-hour window, so
   the 20-coin minimum bar (round trip ≥ 0.01 SOL on ≥ 20 coins) is cleared with
   margin, and each loss is tiny.
2. **Dip rider (right tail).** Buys a 30–45% dip from the 2500-slot high on a strong
   curve (real SOL ≥ 3 at entry and at the high), only while buyers are still stepping
   in (last trade a buy, ≥ 3 of the last 6 trades buys, net SOL flow ≥ 0). 0.15 SOL
   tranches up to 0.75 SOL per coin, take profit +30%, stop −15%, at most 300 slots
   held. Most dip buys lose a little; the rare one that rides a curve to completion
   pays for them.

Everything is a pure function of the batches the harness sends: no clock, no
randomness, no I/O, so the two graded executions produce byte-identical action logs.

## How it was chosen

Three house pilot strategies were backtested on the kit's full 24-hour dev window
with the local replay engine, plus two from-scratch designs (a "climber" that buys
curves at 30–50 SOL of real reserves, and this hybrid). Full-window results:

| strategy | net PnL | coins | max drawdown |
| --- | --- | --- | --- |
| momentum pilot (default) | −9.39 SOL | 48 | 0.95 |
| reversion pilot (TP 30% / SL 15% / 300 slots) | −2.39 SOL | 198 | 0.32 |
| sniper pilot (default) | −0.49 SOL | 354 | 0.05 |
| climber (buy at ≥ 50 SOL real, hold) | −0.85 SOL | 5 | 0.10 |
| **Sprinter (this entry)** | **−0.29 SOL** | **305** | **0.14** |

Official `grade-local --driver process` dev score (two executions, action logs
reproduced byte for byte): **−0.2918 SOL**, 1176 fills over 305 coins, 455 round
trips, win rate 16.3%, max drawdown 0.143, guardrails met. The local replay-engine
port measured the same entry at +0.02 SOL mean across four failed-tx draws, with
3 of 4 six-hour slices positive — the two engines disagree by ~0.3 SOL on this
window, so the honest reading is "near breakeven, slightly negative on the official
grader, with a right tail from the dip rider's completion catches".

The dev window's own data explains why: most coins decay (median end price 0.85×
the price 60 s after creation), only 2.9% of coins ever complete, and most
completions happen in the coin's creation slot — before any bot can buy. Buying
momentum tops loses; buying every launch loses slowly to fees; only the dip-rider's
occasional completion catch (best single trip +0.56 SOL on the local engine) keeps
the total near breakeven instead of deeply negative.

## Files

- `main.ts` — entrypoint: runs the strategy through the SDK shim.
- `strategy.ts` — the two-signal strategy (`createStrategy`, `DEFAULT_PARAMS`).
- `vendor/makefun-bot.ts` — the kit's `sdk/ts/makefun-bot.ts`, vendored byte for byte.
- `LICENSE` — MIT.
- `.makefun/owner.json` — claim file naming the entrant wallet.

## Local check

Grade on the kit's dev data the way the server does (needs the unpacked kit):

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process --worktree
```

The bot runs twice; the two action logs must match byte for byte. Dev score is
recorded in the run log.
