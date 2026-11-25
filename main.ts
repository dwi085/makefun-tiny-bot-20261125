// Tiny Bot — mean-reversion dip buyer for Solana hourly bars.
//
// Speaks agent-fun/bars-replay/v1: the harness sends one `hello`, then one `batch`
// per bar, and expects exactly one `reply` per batch echoing its seq with our orders.
// Every order decided on a batch fills at the next bar's open, so this bot only ever
// uses bars up to the current bar — no look-ahead, no future data, no network.
//
// Strategy (long only, no leverage, no shorts):
//   * Keep an EMA(24) of closes per symbol, built from the bars seen so far.
//   * BUY when a symbol's close dips at least 2.5% below its EMA24 but no more
//     than 10% below (a dip, not a waterfall). Deepest dips first, at most
//     4 holdings, 25% of equity each.
//   * SELL when the close recovers to within half the dip of the EMA24, or the
//     price falls 4% below the entry fill (stop-loss), or the dip deepens past 10%.
//   * During warm-up batches we only build history; orders there would be rejected.
// Determinism: no clock, no environment reads, no randomness — the two grading
// runs produce identical action logs. Diagnostics go to stderr only; stdout
// carries replies and nothing else.

import { createInterface } from "node:readline";

const PROTOCOL = "agent-fun/bars-replay/v1";

// --- strategy knobs (picked on the published dev window; see README) ---
const EMA_SPAN = 24;
const DIP_BUY = 0.025; // buy when close is >= 2.5% below EMA24
const DIP_MAX = 0.1; // never buy a dip deeper than 10%
const DIP_EXIT = DIP_BUY / 2; // sell when the dip narrows to half its entry size
const STOP_LOSS = 0.04; // sell when price falls 4% below the entry fill
const MAX_HOLDINGS = 4;
const MAX_SLIPPAGE_BPS = 500;

// --- wire types (subset of protocol.schema.json) ---
interface HelloSymbol {
  symbol: string;
  mint: string;
  price_scale: number;
  qty_scale: number;
}
interface Hello {
  type: "hello";
  protocol: string;
  seed: string;
  symbols: HelloSymbol[];
  capital: { quote: string; quote_scale: number; quote_units: string };
  bar_interval: string;
  first_close_ms: number;
  caps: {
    max_open_positions: number;
    max_orders_per_bar: number;
    max_weight_bps: number;
    shorts: boolean;
    leverage: boolean;
  };
  fees: { fee_bps: number; slippage_bps: number; min_notional_quote_units: string };
  latency_bars: number;
  warmup_bars?: number;
}
interface BarMsg {
  symbol: string;
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string | null;
  o_depth: string[];
  c_depth: string[];
}
interface FillMsg {
  client_id: string;
  symbol: string;
  side: "buy" | "sell";
  status: "filled" | "rejected";
  reason: string | null;
  decided_bar: number;
  fill_bar: number;
  price: string;
  qty: string;
  notional_quote_units: string;
  fee_quote_units: string;
}
interface PositionMsg {
  symbol: string;
  qty: string;
  cost_quote_units: string;
}
interface AccountMsg {
  cash_quote_units: string;
  positions: PositionMsg[];
  equity_quote_units: string;
}
interface BatchMsg {
  type: "batch";
  seq: number;
  t: number;
  bars: BarMsg[];
  fills: FillMsg[];
  account: AccountMsg;
}
interface DoneMsg {
  type: "done";
  seq: number;
  reason: string;
  account: AccountMsg;
}

// --- bot state (all of it derived from hello + the batches seen so far) ---
let hello: Hello | null = null;
let warmupBars = 0;
let cash = 0n;
let equity = 0n;
const positions = new Map<string, bigint>(); // held qty (raw units) by symbol
const priceScale = new Map<string, number>();
const ema24 = new Map<string, number>(); // EMA(24) of closes, in USDC
const closeUsd = new Map<string, number>(); // latest close, in USDC
const entryPx = new Map<string, number>(); // entry fill price in USDC, per held symbol
let orderNo = 0;
let filledBuys = 0;
let filledSells = 0;

function priceUsd(raw: string, symbol: string): number {
  const scale = priceScale.get(symbol) ?? 0;
  return Number(raw) / 10 ** scale;
}

function nextClientId(): string {
  orderNo += 1;
  return `o${orderNo}`;
}

/** Fold one batch of bars into the EMA history (bars up to this bar only). */
function applyBars(bars: BarMsg[]): void {
  const k = 2 / (EMA_SPAN + 1);
  for (const b of bars) {
    // Ignore bars for symbols outside the hello universe (defensive: a bar
    // without a known symbol must never pollute another symbol's history).
    if (!priceScale.has(b.symbol)) continue;
    const p = priceUsd(b.c, b.symbol);
    closeUsd.set(b.symbol, p);
    const prev = ema24.get(b.symbol);
    ema24.set(b.symbol, prev === undefined ? p : p * k + prev * (1 - k));
  }
}

/** Record entry prices from this batch's fills (buys set them, sells clear them). */
function applyFills(fills: FillMsg[]): void {
  for (const f of fills) {
    if (f.status !== "filled") continue;
    if (f.side === "buy") {
      entryPx.set(f.symbol, priceUsd(f.price, f.symbol));
      filledBuys += 1;
    } else {
      entryPx.delete(f.symbol);
      filledSells += 1;
    }
  }
}

function applyAccount(account: AccountMsg): void {
  cash = BigInt(account.cash_quote_units);
  equity = BigInt(account.equity_quote_units);
  positions.clear();
  for (const p of account.positions) positions.set(p.symbol, BigInt(p.qty));
}

/** Decide this batch's orders. Returns the wire order list (possibly empty). */
function decideOrders(batch: BatchMsg): unknown[] {
  if (hello === null || batch.seq < warmupBars) return [];
  const maxWeightBps = BigInt(hello.caps.max_weight_bps);
  const minNotional = BigInt(hello.fees.min_notional_quote_units);
  const orders: unknown[] = [];
  const selling = new Set<string>();

  // --- exits: recovery, stop-loss, or dip too deep ---
  for (const [symbol, qty] of positions) {
    if (qty === 0n) continue;
    const close = closeUsd.get(symbol);
    const ema = ema24.get(symbol);
    const entry = entryPx.get(symbol);
    if (close === undefined || ema === undefined || ema <= 0) continue;
    const dip = close / ema - 1;
    const stopped = entry !== undefined && close < entry * (1 - STOP_LOSS);
    if (dip > -DIP_EXIT || stopped || dip < -DIP_MAX) {
      selling.add(symbol);
      orders.push({
        side: "sell",
        client_id: nextClientId(),
        symbol,
        qty: qty.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
    }
  }

  // --- entries: deepest dips first, only into free holding slots ---
  const heldAfterExits =
    [...positions.values()].filter((q) => q > 0n).length - selling.size;
  const freeSlots = MAX_HOLDINGS - heldAfterExits;
  if (freeSlots > 0) {
    const candidates: { symbol: string; dip: number }[] = [];
    for (const [symbol, close] of closeUsd) {
      if (positions.get(symbol) !== undefined && positions.get(symbol) !== 0n) continue;
      if (selling.has(symbol)) continue;
      const ema = ema24.get(symbol);
      if (ema === undefined || ema <= 0) continue;
      const dip = close / ema - 1;
      if (dip <= -DIP_BUY && dip >= -DIP_MAX) candidates.push({ symbol, dip });
    }
    candidates.sort((a, b) => a.dip - b.dip);
    let cashLeft = cash; // sells in this same reply never fund a buy
    for (const c of candidates.slice(0, freeSlots)) {
      const target = (equity * maxWeightBps) / 10000n;
      const notional = target < cashLeft ? target : cashLeft;
      if (notional < minNotional) continue;
      cashLeft -= notional;
      orders.push({
        side: "buy",
        client_id: nextClientId(),
        symbol: c.symbol,
        notional_quote_units: notional.toString(),
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      if (orders.length >= hello.caps.max_orders_per_bar) break;
    }
  }

  return orders.slice(0, hello.caps.max_orders_per_bar);
}

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim() === "") continue;
    const msg = JSON.parse(line) as Hello | BatchMsg | DoneMsg;
    if (msg.type === "hello") {
      if (msg.protocol !== PROTOCOL) {
        throw new Error(`harness speaks ${msg.protocol}; this bot speaks ${PROTOCOL}`);
      }
      hello = msg;
      warmupBars = msg.warmup_bars ?? 0;
      cash = BigInt(msg.capital.quote_units);
      equity = cash;
      for (const s of msg.symbols) priceScale.set(s.symbol, s.price_scale);
      console.error(
        `hello: ${msg.symbols.length} symbols, capital ${msg.capital.quote_units} ` +
          `quote units, warmup ${warmupBars} bars, max weight ${msg.caps.max_weight_bps} bps`,
      );
    } else if (msg.type === "batch") {
      applyBars(msg.bars);
      applyFills(msg.fills);
      applyAccount(msg.account);
      const orders = decideOrders(msg);
      process.stdout.write(
        JSON.stringify({ type: "reply", seq: msg.seq, orders }) + "\n",
      );
    } else if (msg.type === "done") {
      applyAccount(msg.account);
      console.error(
        `done (${msg.reason}): final equity ${msg.account.equity_quote_units} ` +
          `quote units, filled buys ${filledBuys}, filled sells ${filledSells}`,
      );
      break;
    } else {
      throw new Error(`unknown message type ${(msg as { type: string }).type}`);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
