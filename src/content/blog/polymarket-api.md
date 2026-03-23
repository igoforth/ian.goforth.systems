---
title: "Reverse-Engineering Polymarket's API Schemas from 50,000 Live Responses"
description: "The documentation says the field is a string. It's actually a JSON-encoded array inside a string, except when it's null, except in markets created before February 2022 when it's a variable-length array instead of a tuple."
pubDate: "Jan 01 2026"
---

## The Documentation Problem

Polymarket has three APIs. The [Gamma API](https://docs.polymarket.com) serves market metadata. The [CLOB API](https://docs.polymarket.com) serves orderbook and trading data. The [Data API](https://docs.polymarket.com) serves positions and trade history. There are OpenAPI specs for all three.

The specs are wrong. Not maliciously, just incomplete in the way that specs for a fast-moving product tend to be. Fields are listed as `string` when they're actually JSON-encoded arrays inside strings. Fields are listed as required when they're absent in 40% of responses. Fields that the spec says are strings are actually numbers, or booleans, or `null`, depending on when the market was created.

I needed typed API clients for a trading system. The official TypeScript client covers only the CLOB. I started with Orval to generate clients from the OpenAPI specs, but the generated types didn't match what the API actually returned. I ended up writing scripts that fetched tens of thousands of real responses and catalogued every field's actual type, presence rate, and value distribution to build accurate Zod schemas by hand.

The result is [@igoforth/polymarket-api](https://github.com/igoforth/polymarket-api). This post is about the discovery process.

## The Schema Discovery Scripts

I wrote separate scripts for each API surface. They all follow the same pattern: paginate through the entire API, validate each response against a Zod schema, and when validation fails, categorize why.

The Gamma script fetches up to 50,000 markets sorted by volume, validates each one, and stops when the failure rate exceeds 5%:

```ts
while (allMarkets.length < maxMarkets) {
  const response = await listMarkets({
    limit, offset, closed: false, order: "-volumeNum",
  });

  for (const market of response.data) {
    const result = MarketSchema.safeParse(market);
    if (result.success) {
      passCount++;
    } else {
      failCount++;
      for (const issue of result.error.issues) {
        const key = `${issue.path.join(".")}: ${issue.message}`;
        errors.set(key, (errors.get(key) || 0) + 1);
      }
    }
  }

  const failureRate = failCount / (passCount + failCount);
  if (failureRate > maxFailureRate) {
    stoppedEarly = true;
    break;
  }
}
```

After validation, it analyzes every field across all fetched markets. For each field it tracks: presence rate, null rate, type distribution, and unique value counts. Then it groups findings into categories:

```
=== LITERAL BOOLEANS (always same value) ===
  active: z.literal(true) // 100% = true
  archived: z.literal(false) // 100% = false
  approved: z.literal(true) // 100% = true
  pendingDeployment: z.literal(false) // 100% = false

=== POTENTIAL ENUMS (≤20 unique values) ===
  marketType: [2 values] "normal"(49823), "scalar"(177)
  formatType: [6 values] "decimal"(312), "normal"(89), "percent"(45)...

=== LOW PRESENCE FIELDS (<50% present) ===
  denominationToken: 12% present (string)
  sponsorImage: 3% present (string)
  twitterCardLocation: 8% present (string)
```

The CLOB script does the same thing for 100,000 markets, and additionally generates a suggested Zod schema at the end, iterating every top-level field, inferring its Zod type from the observed types, and adding `.nullable()` or `.optional()` based on the presence analysis. I'd run the script, copy the suggested schema, fix the parts it got wrong, then run it again until the pass rate hit 100%.

## What the Analysis Found

### JSON Strings That Aren't Strings

The Gamma API returns `outcomes` and `outcomePrices` as strings. Not string values, but JSON-encoded arrays serialized into a string column:

```json
{
  "outcomes": "[\"Yes\",\"No\"]",
  "outcomePrices": "[\"0.6523\",\"0.3477\"]",
  "clobTokenIds": "[\"71321...\",\"81902...\"]"
}
```

The OpenAPI spec says `string`. Technically correct. Practically useless. These need parsing:

```ts
export const jsonTupleString = <T extends z.ZodType>(itemSchema: T) =>
  z.string()
    .transform((s) => JSON.parse(s))
    .pipe(z.tuple([itemSchema, itemSchema]));

// Usage in MarketSchema
outcomes: jsonTupleString(z.string()),
outcomePrices: jsonTupleString(numericString),
clobTokenIds: jsonTupleStringOptional(z.string()),
```

This is a tuple, not an array, because every market on Polymarket since February 2022 is binary, exactly two outcomes. But markets created before that date can have variable-length outcome arrays. The 5% failure threshold in the discovery script exists because of this: once you paginate deep enough into old markets, the tuple validation breaks. The schema intentionally doesn't support pre-2022 multi-outcome markets.

### SQL Placeholders in Date Fields

Some markets have `umaEndDate` set to the literal string `"NOW()"` or `"NOW*()"`. These are SQL function calls that leaked into the API response:

```ts
umaEndDate: z
  .string()
  .transform((s) =>
    s === "NOW()" || s === "NOW*()" ? undefined : new Date(s),
  )
  .pipe(z.date().optional())
  .optional(),
```

I only found this because the schema validator flagged `Invalid date` on a handful of markets. Without the discovery script, this would have been a runtime crash in production the first time someone queried one of these markets.

### Fields That Are Always the Same Value

The analysis found 8 boolean fields that are `true` in 100% of responses, and 5 that are always `false`. The schema encodes these as `z.literal(true)` and `z.literal(false)`:

```ts
active: z.literal(true),
archived: z.literal(false),
approved: z.literal(true),
pendingDeployment: z.literal(false).optional(),
deploying: z.literal(false).optional(),
```

This isn't academic. If `active` is a `z.literal(true)`, the TypeScript type narrows to `true`, not `boolean`. Downstream code doesn't need to check `if (market.active)` because the type system guarantees it. The Gamma listing endpoint only returns active markets, which is why the value is always true.

### Numeric Strings

`volume` and `liquidity` come back as strings: `"1234567.89"`. But `volumeNum` and `liquidityNum` come back as numbers. The `id` field is a number in the JSON but represents a database row ID that should be treated as opaque. The `fee` field is a numeric string. `bestAsk` and `spread` are actual numbers.

```ts
id: numericString,           // string → number via z.coerce.number()
volume: numericStringOptional, // string → number, optional
liquidityNum: z.number(),    // already a number, 99.8% present
bestAsk: z.number(),         // already a number, 100% present
bestBid: z.number().optional(), // number, but sometimes missing
```

The `bestBid` discovery was surprising: `bestAsk` is present on 100% of markets, but `bestBid` is sometimes missing. The 50,000-market analysis was the only way to find this, since the first few hundred markets all have both.

### The CLOB Has Exact Value Sets

The CLOB API is more disciplined than Gamma, but has its own quirks. Tick sizes and minimum order sizes aren't arbitrary numbers, they're drawn from small, fixed sets:

```ts
export const ClobMinTickSizeSchema = z.union([
  z.literal(0.1),
  z.literal(0.04),
  z.literal(0.01),
  z.literal(0.001),
  z.literal(0.0001),
]);

export const ClobMinOrderSizeSchema = z.union([
  z.literal(0),
  z.literal(5),
  z.literal(15),
]);
```

These came directly from the enum analysis across 100,000 CLOB markets. Using literal unions instead of `z.number()` means the TypeScript type is `0.1 | 0.04 | 0.01 | 0.001 | 0.0001`, not `number`. Pattern matching on tick size in downstream code gets exhaustiveness checking.

`seconds_delay` is similarly constrained to `0 | 1 | 2 | 3 | 4 | 5 | 6`, `maker_base_fee` is always `0`, and `taker_base_fee` is always `0 | 200`. None of this is in the docs.

## WebSocket Schema Discovery

The REST APIs are static; you can paginate through them at your own pace. The WebSocket APIs are live streams where the only way to validate the schema is to subscribe and watch messages in real time.

The live data script subscribes to every channel and validates messages for 60 seconds:

```ts
const subscriptions = [
  { topic: "activity", type: "trades" },
  { topic: "activity", type: "orders_matched" },
  { topic: "comments", type: "comment_created" },
  { topic: "crypto_prices", type: "update" },
  { topic: "crypto_prices_chainlink", type: "update" },
  { topic: "equity_prices", type: "update" },
];
```

Per-topic pass rates let you see which channels have stable schemas and which don't. When a message fails, the script stores the raw payload as a sample so you can see what actually came over the wire.

A separate script targets the `price_change` channel specifically, testing individual field validators against live payloads. When the overall schema fails, it tests each field (`hexString`, `priceString`, `unixTimestampMsString`) independently to pinpoint the mismatch:

```ts
const tests: [string, z.ZodType, unknown][] = [
  ["a", z.string(), item.a],
  ["h", hexString, item.h],
  ["p", priceString, item.p],
  ["s", TradeDirectionSchema, item.s],
  ["si", numericStringNonnegative, item.si],
  ["ba", priceString, item.ba],
  ["bb", priceString, item.bb],
];
```

### What the Docs Don't Say About WebSocket Filters

The docs describe channel subscription but don't document which filter types work on which channels. Does `clob_market` / `last_trade_price` filter on condition IDs or token IDs? What about `market_created`, does it even accept filters?

A separate script tests every combination by subscribing with each filter type and checking if messages arrive:

```
=== RESULTS SUMMARY ===

Channel              Filter          Msgs   Status
------------------------------------------------------------
last_trade_price     token_id        1      ✓ WORKS
last_trade_price     condition_id    0      ? No messages
tick_size_change     token_id        0      ? No messages
tick_size_change     condition_id    0      ? No messages
market_created       none            1      ✓ WORKS
market_created       condition_id    0      ? No messages
market_resolved      none            0      ? No messages
```

`last_trade_price` filters on token IDs, not condition IDs. `market_created` doesn't accept filters at all. The docs don't mention this distinction.

## What This Became

The validated schemas feed into a builder that unifies all three APIs behind one function call. You say which fields you want, it figures out which APIs to call:

```ts
// Backfill pipeline: fetch every market on the platform
const allMarkets = await market({ all: true, volumeMin: 10000 })
  .withBackfill()  // selects 17 fields across Gamma + CLOB
  .fetch();

// Market maker: just the trading parameters
const mkt = await market(conditionId)
  .select("minOrderSize", "negRisk", "tickSize", "clobTokenIds")
  .fetch();

// The return type is Pick<BuilderMarket, ...>, only the fields you asked for
```

The field registry maps each field name to source APIs with fallback priority and extraction functions. If you select `bestBid`, the builder tries Gamma first (where it's a direct field), then falls back to CLOB (where it's derived from `tokens[0].price`). If you select `tickSize`, it only calls CLOB, because that's the only source.

I also built an [MCP server](https://github.com/igoforth/polymarket-mcp) on top that exposes 47 Polymarket tools to AI assistants. It exports a `registerTools` function so you can extend it with your own tools. Both packages are on npm as `@igoforth/polymarket-api` and `@igoforth/polymarket-mcp`.

But the part that took the most time wasn't the builder or the MCP server. It was sitting in a terminal watching `50000 markets (49823 passed, 177 failed)` scroll by and figuring out why those 177 were different.
