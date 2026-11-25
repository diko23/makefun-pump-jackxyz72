# makefun-pump-jackxyz72

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/diko23/makefun-pump-jackxyz72/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/diko23/makefun-pump-jackxyz72/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

Deterministic TypeScript paper-trading bot for the [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) (`agent-fun/replay/v2`) competition on [make.fun](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122).

## Strategy

- **Universe & State**: Reads `hello`, `batch`, and `done` messages over stdin/stdout via the vendored SDK shim (`vendor/makefun-bot.ts`), tracking per-mint bonding curves, unique buyers, buy slot counts, wallet concentration, creator buy/sell token flow, peak reserves, and spot price across slots.
- **Entry Filter (Confirmed Pullback-Rebound)**: Targets coins that have demonstrated organic demand (`peakRealSol >= 20 SOL`, `uniqueBuyers >= 24`, `buySlots >= 14`, single-buyer share `<= 28%` of buy volume, and no `>= 90%` creator token dump), pulled back `10%` to `28%` from peak spot price, and show fresh rebound buying (`>= 3` buys in the last 5 trades with `recentBuyVol >= 1.8x recentSellVol`).
- **Position Sizing & Caps**: Enforces `>= 0.015 SOL` per buy (above the `0.01 SOL` guardrail), capped at `95%` of `state.maxBuyLamports(mint)` (100 bps of real SOL reserves), `0.45 SOL` max stake, and available cash across up to `5` open positions.
- **Fee-Aware Exits**:
  - **Hard Stop-Loss**: `-18%` net of curve and tx fees, tightening to `-2%` (`98%`) once a partial TP1 sell fill is confirmed by `client_id`.
  - **Partial Take-Profit (TP1)**: Sells `50%` at `+17%` net of fees.
  - **Trailing Stop & Full TP (TP2)**: Arms a `10%` trailing stop at `+16%` net peak value and closes remaining tokens at `+75%` net of fees.
  - **Stale Rotation**: Exits after `280` slots if net value is below `+12%` to rotate slots across 20+ coins.
- **Determinism**: Uses batch state and `state.hello.seed` only (no wall clock, environment variables, or `Math.random`).

## Run it

Zero dependencies; runs directly on Node 22+ (`node /bot/main.ts` in the grader):

```bash
node main.ts
```

## License

MIT — see [LICENSE](LICENSE).
