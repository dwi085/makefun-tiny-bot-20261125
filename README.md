# Tiny Bot — Mean-Reversion Dip Buyer on Solana

[![make.fun](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/dwi085/makefun-tiny-bot-20261125/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/dwi085/makefun-tiny-bot-20261125/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

A tiny paper-trading bot for the [Tiny Bot, Easy $2](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1) bounty. It speaks `agent-fun/bars-replay/v1` (one `hello`, one `batch` per hourly bar, one `reply` per batch) and trades FARTCOIN, JITOSOL, POPCAT, RAY, SOL, WETH and WIF on Solana DEX bars. Long only, no leverage, no shorts, no look-ahead: every decision uses only bars up to the current bar.

## Strategy

Mean reversion on hourly closes, per symbol:

- Keep an EMA(24) of closes, built from the bars seen so far.
- **Buy** when a symbol's close dips at least **2.5%** below its EMA24 but no more than **10%** below (a dip, not a waterfall). Deepest dips first, at most **4 holdings**, **25% of equity** each.
- **Sell** when the close recovers to within half the dip of the EMA24, or the price falls **4%** below the entry fill (stop-loss), or the dip deepens past 10%.
- During warm-up batches it only builds history; orders there would be rejected.

Why mean reversion, not momentum? On the kit's published dev window (136 hourly bars, 2026-11-04–09) every momentum variant I tested lost money to whipsaws, while this dip buyer beat the equal-weight buy-and-hold baseline under both warm-up assumptions. It is fully deterministic (no clock, no environment, no randomness), so the two grading runs produce identical action logs.

## Dev-window numbers (kit `grade-local`, `--driver process`)

| | Net PnL | Trades | Max drawdown |
|---|---|---|---|
| Tiny Bot | see `grade-local` output | | |
| Buy-and-hold (equal weight) | −$844.38 | — | — |

(Full numbers are printed by `grade-local`; the final window is 3 fresh UTC days after the deadline, so dev numbers are a guide, not a promise.)

## Run it locally

```sh
node cli/makefun.mjs grade-local --kit <kit dir> --bot . --driver process
```

`main.ts` runs on Node 22 as-is (`node main.ts`); it reads JSON lines on stdin and writes one reply per batch on stdout.
