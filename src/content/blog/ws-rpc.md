---
title: "Bidirectional RPC Over WebSocket for Cloudflare Durable Objects"
description: "Design decisions, type system iterations, and the hibernation-safe continuation pattern behind ws-rpc."
pubDate: "Dec 23 2025"
---

## Introduction

I needed bidirectional RPC over WebSocket for a project on Cloudflare Durable Objects. The boilerplate around message formats, serialization, validation, and error handling on both sides was getting tedious, and I didn't find an existing library that handled DO hibernation properly. Durable Objects can get evicted from memory while WebSocket connections stay open. Any outgoing RPC call backed by a Promise just disappears when that happens.

I built [ws-rpc](https://github.com/igoforth/ws-rpc) over a few days in late December 2025. The initial release was one big commit, 11,716 lines, and the following two days were spent fixing the things that were wrong with it. This post covers the design, the problems I ran into after shipping, and the hibernation workaround.

## Schema-First Design

You define your RPC contract once with Zod. Two helpers, `method()` and `event()`, create typed definitions:

```ts
import { method, event } from "@igoforth/ws-rpc/schema";
import { z } from "zod";

const ServerSchema = {
  methods: {
    getWallets: method({
      output: z.object({ wallets: z.array(z.string()) }),
    }),
    executeOrder: method({
      input: z.object({ market: z.string(), side: z.enum(["buy", "sell"]) }),
      output: z.object({ orderId: z.string(), filled: z.boolean() }),
    }),
  },
  events: {
    priceUpdate: event({
      data: z.object({ market: z.string(), price: z.number() }),
    }),
  },
} as const;
```

From that, the library derives `Provider<T>` (what you implement on the server) and `Driver<T>` (what you use to call the remote peer). Both inferred from the Zod schemas. No codegen, no separate interface files.

## Bidirectional by Default

Most RPC libraries treat client and server asymmetrically. In ws-rpc, both sides are "peers." Each has a provider (methods it implements) and a driver (proxy for calling the other side):

```ts
const peer = new RpcPeer({
  ws,
  localSchema: ServerSchema,
  remoteSchema: ClientSchema,
  provider: {
    async getWallets() {
      return { wallets: ["0xabc...", "0xdef..."] };
    },
    async executeOrder({ market, side }) {
      return { orderId: "order-123", filled: true };
    },
  },
  onEvent(event, data) {
    // incoming events from remote peer
  },
});

// call methods on the remote peer
const result = await peer.driver.remoteMethod({ someInput: "value" });
```

The driver validates input before sending and output on receipt. Events are separate, fire-and-forget: `peer.emit("priceUpdate", { market: "BTC-USD", price: 43250 })` sends a one-way message, no response.

## The Wire Protocol

Four message types: `rpc:request`, `rpc:response`, `rpc:error`, `rpc:event`. Loosely inspired by JSON-RPC 2.0, simplified. The encoding is pluggable behind an `RpcProtocol` interface: JSON by default, MessagePack and CBOR available as peer dependencies.

I benchmarked them with full RPC roundtrips (encode, send over WebSocket, decode, process, encode response, send back, decode) on an AMD Ryzen 7 5800X:

**Wire sizes (request):**

| Payload | JSON | MessagePack | CBOR |
|---------|------|-------------|------|
| Small | 93 B | 71 B | 112 B |
| Medium | 3,465 B | 2,113 B | 1,359 B |
| Large | 24,453 B | 19,552 B | 14,140 B |

**Throughput (ops/sec):**

| Payload | JSON | MessagePack | CBOR |
|---------|------|-------------|------|
| Small | 19,523 | 15,141 | 12,793 |
| Medium | 6,639 | 3,841 | 6,704 |
| Large | 2,094 | 694 | 1,597 |

The results surprised me. I expected binary codecs to win across the board, but JSON is fastest for small and large payloads. The encode/decode overhead of MessagePack and CBOR eats into the wire size savings. CBOR barely edges out JSON on medium payloads (6,704 vs 6,639 ops/sec) despite being 60% smaller on the wire. MessagePack is consistently the slowest, which I didn't expect.

The takeaway: unless your messages are medium-sized and bandwidth-constrained, JSON is probably fine. You swap codecs with one option, so it's easy to test with your own traffic.

## The Hibernation Problem

Cloudflare Durable Objects hibernate: the runtime evicts them from memory, but WebSocket connections stay open. When a message arrives, the DO wakes up and `onWebSocketMessage` fires. All in-memory state from before hibernation is gone.

For incoming requests this is fine. But outgoing calls are the problem. Your DO calls a method on a connected client, then hibernates before the response comes back. The Promise is gone. The response arrives, nothing picks it up, the call is silently lost.

The standard advice is "don't make outgoing calls that might span a hibernation boundary." That rules out a lot of useful patterns.

## Continuation-Passing for Durable Objects

`DurableRpcPeer` replaces Promises with continuation-passing. Instead of `await peer.driver.someMethod(params)`, you write:

```ts
peer.callWithCallback("executeOrder", { market, side }, "onOrderExecuted");
```

Three arguments: remote method name, parameters, and the name of a callback method on your actor. The pending call (method, params, callback name, timestamp) gets persisted to DO SQL storage *before* the request goes over the wire.

When the response arrives, `DurableRpcPeer` checks storage for a matching call. If it finds one, it deletes the record and invokes the named callback on the actor:

```ts
class MyDO extends Actor<Env> {
  onOrderExecuted(result: OrderResult, context: CallContext) {
    console.log("Order filled:", result.filled);
    console.log("Round-trip latency:", context.latencyMs, "ms");
  }
}
```

The callback is stored as a string, not a function reference. After hibernation, the DO is reconstructed fresh. The storage lookup finds the pending call, resolves the callback by name on the new actor instance, and delivers the result.

Persisting before sending was deliberate. If the DO crashes between persist and send, the call times out cleanly instead of being lost. `cleanupExpired()` returns stale calls so you can retry or log them. The storage interface is pluggable: `SqlPendingCallStorage` for production, `MemoryPendingCallStorage` for tests.

After the initial release I also found that `DurableObjectStorage` isn't always available depending on the environment. I added a fallback to in-memory storage with a warning, so the adapter doesn't just throw. Pending calls won't survive hibernation in that case, but at least basic RPC works.

## The `withRpc` Mixin

For Durable Objects on `@cloudflare/actors`, `withRpc()` wires it all together:

```ts
class MyActorBase extends Actor<Env> {
  async getWallets() {
    return { wallets: this.wallets };
  }
}

class MyDO extends withRpc(MyActorBase, {
  localSchema: ServerSchema,
  remoteSchema: ClientSchema,
}) {
  async notifyClients() {
    const results = await this.driver.clientMethod({ info: "update" });
  }
}
```

The mixin overrides the Actor's WebSocket lifecycle methods to manage peers automatically. For hibernation recovery, when a message arrives on a pre-hibernation WebSocket, the peer object doesn't exist in memory. The mixin lazily recreates it, fires `onRpcPeerRecreated`, and routes the message through.

The initial release had the usage pattern wrong. The first example showed methods defined directly on the `withRpc` class, but TypeScript needs them on the base Actor class so the `Provider` type constraint can check them at compile time. I had to fix the example and the docs almost immediately after shipping.

TypeScript enforces this through a constraint on `Base`: `TBase extends Constructor<ActorLike> & { prototype: Provider<TLocalSchema["methods"]> }`. Forget to implement a schema method on the base class and you get a compile error.

## The Type System Struggle

The initial release had type inference that mostly worked but broke in specific cases. What followed was four commits over two days trying to get event narrowing right.

The original `EventHandler` and `EventEmitter` types used generic functions with a type parameter `K extends StringKeys<T["events"]>`. The idea was that TypeScript would narrow `K` when you switched on the event name. It didn't. TypeScript doesn't narrow generic type parameters in switch statements.

The first attempt at fixing this was to pre-resolve `InferEvents` so the mapped type was already computed. That helped with autocomplete but didn't fix narrowing.

The fix that actually worked was `EventTuple`, a discriminated union of tuples:

```ts
type EventTuple<T extends RpcSchema["events"]> =
  T extends Record<string, EventDef>
    ? { [K in keyof T]: [event: K, data: InferEventData<T[K]>] }[keyof T]
    : [event: string, data: unknown];
```

For a schema with `priceUpdate` and `tradeExecuted`, this produces:

```ts
type Result =
  | [event: "priceUpdate", data: { market: string; price: number }]
  | [event: "tradeExecuted", data: { orderId: string; amount: number }];
```

Switch on the event name and TypeScript narrows `data` to the right type. This required changing `EventHandler` and `EventEmitter` from generic function types to interfaces using tuple spreads, and updating `emit()` across every adapter to use the new pattern.

In the same stretch I also had to rewrite `Provider` and `Driver`. The originals took `RpcSchema` and indexed into `T["methods"]` internally, which lost type information. Changing them to take `RpcSchema["methods"]` directly (so call sites pass `TLocalSchema["methods"]` instead of `TLocalSchema`) fixed the inference. The `method()` helper also needed overloads added after release because the initial single signature couldn't distinguish between "input is required" and "input is omitted."

The initial `InferInput`, `InferOutput`, and `InferEventData` types used `infer` with conditional extraction (`T extends MethodDef<infer TInput, z.ZodType>`). I replaced them with direct property access (`z.input<T["input"]>`), which is simpler and preserves the types better through Zod's own inference.

Each of these fixes touched most of the adapter files because the type parameters rippled through everything. The final cleanup commit on Dec 23 removed 84 lines from the adapter layer and added 55, mostly by consolidating the patterns that had accumulated during the type fixes.

## Client-Side Auto-Reconnect

`RpcClient` wraps a peer with connection lifecycle management and auto-reconnect with exponential backoff:

```ts
const client = new RpcClient({
  url: "wss://my-do.example.com/ws",
  localSchema: ClientSchema,
  remoteSchema: ServerSchema,
  provider: { /* client-side method implementations */ },
  reconnect: {
    maxAttempts: 10,
    baseDelay: 1000,
    maxDelay: 30000,
  },
  onConnect() { console.log("Connected"); },
  onReconnect(attempt, delay) { console.log(`Reconnecting in ${delay}ms`); },
});

await client.connect();
const wallets = await client.driver.getWallets();
```

The WebSocket constructor is injectable, so it works with browser WebSocket, Node.js `ws`, or Bun. ws-rpc doesn't care which runtime it's in.

## What I'd Change

The `callWithCallback` string-based callback pattern works, and TypeScript constrains it to actual method names on the actor, but the result type isn't checked against the method's output schema at compile time. I have some ideas involving mapped types but nothing I like enough to ship.

The library validates on both send and receive. That's correct but doubles the Zod parsing cost per call. For trusted internal services you might want to skip validation on one side. I haven't added it because "optional validation" is easy to get wrong.

The library is [on GitHub](https://github.com/igoforth/ws-rpc) and on npm as `@igoforth/ws-rpc`.
