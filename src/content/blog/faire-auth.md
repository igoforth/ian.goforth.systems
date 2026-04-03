---
title: "Rebuilding Better Auth on Hono"
description: "DTOs, typed middleware, brand stripping, and the other problems you hit when trying to make an auth library's types match what it actually returns."
pubDate: "Dec 05 2025"
---

## Introduction

I was integrating [Better Auth](https://github.com/better-auth/better-auth) into a startup I'm building when I hit two problems that couldn't be fixed with plugins or configuration. First, I couldn't control what each route returned in a way that reflected in the types. The `getSession` endpoint returns a full user object (email, name, image, createdAt, all of it) and there's no typed mechanism to strip fields, rename them, or add computed properties. You can write an `after` hook that mutates the response object, but the types don't know about it. The client still thinks it's getting the original shape. Second, Better Auth is built on [better-call](https://github.com/bekacru/better-call), a custom RPC library. I wanted to use [Hono](https://hono.dev).

I spent four months rebuilding Better Auth on Hono. The result is [Faire Auth](https://github.com/igoforth/faire-auth): same plugin ecosystem, same adapter layer, same social providers, but with typed middleware, route hooks, DTO transforms, and a Hono-native request pipeline. Comparing equivalent packages with `scc` (excluding plugins, including better-call in Better Auth's total), the core shrank 28% from 86,000 to 62,000 lines.

This post covers what changed, why, and how the type system holds it together.

## The DTO Problem

Better Auth endpoints return database entities directly. A `getSession` call returns:

```ts
{
  session: { id, userId, token, expiresAt, ipAddress, userAgent, createdAt, updatedAt },
  user: { id, email, emailVerified, name, image, createdAt, updatedAt }
}
```

Every field the database has, the client gets. If a plugin adds `twoFactorEnabled` to the user table, it shows up in every response that includes a user object. There's no way to say "strip `id` and `ipAddress` from the session, lowercase the email, add a `displayName` computed from `name`" and have the types reflect that.

Better Auth's `after` hooks let you mutate the response at runtime:

```ts
hooks: {
  after: [{
    matcher: (ctx) => ctx.path === "/get-session",
    handler: async (ctx) => {
      const session = ctx.context.returned;
      if (session?.user) {
        delete session.user.id;
        session.user.displayName = session.user.name || "Anonymous";
      }
      return { context: ctx.context };
    }
  }]
}
```

This works at runtime. But the client type is still `{ user: { id: string; name: string; ... } }`. The `id` field is gone from the response but present in the type. The `displayName` field is in the response but absent from the type. You end up casting or wrapping with `as` everywhere.

I needed a system where:
1. You declare a transform function for a response shape (like "user" or "session")
2. The transform applies across all routes that return that shape
3. The return type of the transform replaces the original type everywhere: in the server API, in the client, in `$Infer`

### Zod Brands as Type Markers

Faire Auth's route schemas use Zod's `.brand()` to mark which response objects represent which entities:

```ts
// Simplified from a route definition
const responseSchema = z.object({
  session: sessionSchema.brand("session"),
  user: userSchema.brand("user"),
});
```

The brand is a phantom type. Zod adds `{ [z.$brand]: { user: true } }` to the output type. At runtime, parsing strips it. At the type level, it's a marker that says "this object is a user entity."

When you configure a DTO:

```ts
faireAuth({
  dto: {
    user: (user) => ({
      ...user,
      id: undefined,
      email: user.email.toLowerCase(),
      displayName: user.name || "Anonymous",
    }),
    session: (session) => ({
      ...session,
      ipAddress: undefined,
      expiresIn: Math.floor((session.expiresAt.getTime() - Date.now()) / 1000),
    }),
  },
});
```

Two things happen. At runtime, `buildSchemas()` wraps each branded schema with `.transform(dtoFunction)`. When the route handler returns a response and calls `ctx.render(object, 200)`, the renderer looks up the response schema for that status code, calls `schema.parseAsync(object)`, and the Zod transform runs the DTO function. The response that leaves the server has `id` stripped and `displayName` added.

At the type level, `ProcessRouteConfig` walks the route's response schemas through `StripBrand2D`, a depth-limited recursive type that finds branded objects and replaces their type with the DTO function's return type.

### StripBrand2D

This is a recursive type with three layers and a depth counter:

```ts
// Public wrapper: starts recursion with max depth 6
type StripBrand2D<T extends z.ZodType, Dir, O, MaxDepth = 6> =
  z.ZodType<StripBrand2BaseD<z.output<T>, Dir, O, [], _Counter<MaxDepth>>, z.input<T>>;

// Base recursion: walks object structure
type StripBrand2BaseD<T, Dir, O, Depth, MaxDepth> =
  _Reached<Depth, MaxDepth> extends true ? T :
  Date extends T ? T :
  T extends { [z.$brand]: { [k in infer Brand]: true } }
    ? Brand extends string
      ? StripBrand2CoreD<{stripped}, Brand, Dir, O, [...Depth, 0], MaxDepth>
      : StripBrand2BaseD<{stripped}, Dir, O, [...Depth, 0], MaxDepth>
    : T extends (infer Base)[]
      ? StripBrand2BaseD<Base, Dir, O, [...Depth, 0], MaxDepth>[]
      : T extends object
        ? { [K in keyof T]: StripBrand2BaseD<T[K], Dir, O, [...Depth, 0], MaxDepth> }
        : T;

// Brand resolution: applies DTO or adds extra fields
type StripBrand2CoreD<T, Brand, Dir, O, Depth, MaxDepth> =
  _Reached<Depth, MaxDepth> extends true ? T :
  "output" extends Dir
    ? O extends { dto: { [K in Brand]: infer R } }
      ? R extends (...args: any[]) => Awaitable<infer FnReturn>
        ? StripBrand2BaseD<FnReturn, Dir, O, [...Depth, 0], MaxDepth>
        : StripBrand2BaseD<T, Dir, O, [...Depth, 0], MaxDepth>
      : StripBrand2BaseD<AddExtraFields<T, Brand, Dir, O>, Dir, O, [...Depth, 0], MaxDepth>
    : AddExtraFields<T, Brand, Dir, O>;
```

The depth counter uses tuple length. `_Counter<6>` produces `[0, 0, 0, 0, 0, 0]`. Each recursion step appends `[...Depth, 0]`. `_Reached` compares lengths. This prevents infinite recursion when response objects are nested (a session containing a user containing account references).

The `CoreD` layer does the actual work. For output direction: if `O.dto[Brand]` exists, the DTO function's return type **replaces** the branded type entirely. If no DTO exists, `AddExtraFields` merges in any additional fields from `options.user.additionalFields` and plugin schemas. For input direction, DTOs don't apply. Only extra fields are added.

The result: if you declare `dto: { user: (u) => ({ ...u, displayName: u.name }) }`, every route that returns a branded user object has its response type changed from `{ id: string; name: string; email: string; ... }` to `{ id: string; name: string; email: string; displayName: string; ... }`. The server API, the client, and `$Infer.Session.user` all reflect the DTO's return type.

### Where Better Auth's Response Types Come From

To understand why Better Auth can't do this, look at how it infers response types. A Better Auth endpoint is a `better-call` `Endpoint`:

```ts
type Endpoint<
  Path extends string,
  Method, Body, Query,
  Use extends Middleware[],
  R,                        // ← handler return type
  Meta extends EndpointMetadata,
  Error,
> = { ... };
```

`R` is captured directly from the handler function's return type. When the handler returns `{ session, user }`, `R` is that literal type. There's no processing step between the handler return and the type that reaches the client. The client's `InferRoute` extracts `R` via `Awaited<R>` and that's what you get:

```ts
// better-auth's InferRoute (simplified)
T extends Endpoint<any, any, any, any, any, infer R, infer Meta, infer ErrorSchema>
  ? PathToObject<T["path"],
      (...data) => Promise<BetterFetchResponse<
        T["path"] extends "/get-session"
          ? { user: InferUserFromClient<COpts>; session: InferSessionFromClient<COpts> } | null
          : RefineAuthResponse<NonNullable<Awaited<R>>, COpts>,
        ...
      >>
    >
  : {}
```

`RefineAuthResponse` does some post-hoc replacement: if the response contains `token` or `redirect`, it swaps the `user` and `session` fields with client-inferred versions. But this is a blunt instrument. It only recognizes two response shapes and only replaces two fields. There's no extension point for arbitrary transforms.

Faire Auth's approach is fundamentally different. The handler return type is not `R`. It's `RouteConfigToTypedResponse<C>`, derived from the route's Zod response schema. The schema goes through `ProcessRouteConfig<C, O>`, which applies `StripBrand2D` to every response schema. By the time the type reaches the API or client, it already reflects DTOs, plugin fields, and options-level additional fields.

## Swapping the Router

Better Auth uses `better-call`, a custom RPC library with its own `Endpoint`, `Middleware`, `createRouter`, and `createEndpoint` primitives. Faire Auth uses Hono with `@hono/zod-openapi` for typed routes. This isn't a cosmetic change. It restructures how every endpoint is defined, how middleware composes, and how types flow.

### Endpoint Definition

A Better Auth endpoint:

```ts
export const signUpEmail = <Option extends BetterAuthOptions>() =>
  createAuthEndpoint("/sign-up/email", {
    method: "POST",
    body: z.object({ email: z.string(), password: z.string(), name: z.string() }),
    metadata: {
      $Infer: { body: undefined as InferSignUpBody<Option> },
    },
  }, async (ctx) => {
    // handler
  });
```

The `metadata.$Infer.body` override is how option-dependent types get into the endpoint. `createAuthEndpoint` wraps `better-call`'s `createEndpoint`, injecting an `optionsMiddleware` that provides `AuthContext`. The resulting `Endpoint` has 8 type parameters: `Path`, `Method`, `Body`, `Query`, `Use`, `R`, `Meta`, `Error`.

A Faire Auth endpoint:

```ts
export const signUpEmailRoute = {
  operationId: "signUpEmail",
  path: "/sign-up/email",
  method: "post",
  request: {
    body: { content: { "application/json": { schema: signUpEmailSchema } } },
  },
  responses: {
    200: { content: { "application/json": { schema: signUpResponseSchema } } },
  },
} as const satisfies AuthRouteConfig;

export const signUpEmail = createEndpoint(
  signUpEmailRoute,
  (options) => async (ctx) => { /* handler */ },
);
```

The route config is a const literal satisfying `AuthRouteConfig` (which extends `@asteasolutions/zod-to-openapi`'s `RouteConfig`). The handler is a function that receives `options` and returns a Hono `Handler`. `createEndpoint` returns an `AuthEndpoint<C>`:

```ts
export interface AuthEndpoint<C extends MinRouteConfig> {
  <O extends FaireAuthOptions = {}>(options: O): AuthProperties<ProcessRouteConfig<C, O>>;
}
```

This is the critical junction. `C` is captured when the endpoint is defined (at module level). `O` is captured when `faireAuth()` calls each endpoint with the user's options. `ProcessRouteConfig<C, O>` merges user middleware, applies DTOs to request/response schemas via `StripBrand2D`, and produces a fully resolved config. The type transformations happen here, not at the handler return site.

### Options-Deferred vs Metadata-Override

Better Auth threads option-dependent types through `metadata.$Infer`:

```ts
// better-call resolves types from metadata if present
type ResolveBodyInput<S, Meta> =
  Meta extends { $Infer: { body: infer B } }
    ? ResolveInferValueInput<B>
    : S extends StandardSchemaV1 ? StandardSchemaV1.InferInput<S>
    : undefined;
```

This is a two-track system. If `$Infer.body` exists in metadata, use that type. Otherwise, infer from the schema. The `$Infer` override is set at endpoint creation time by calling `signUpEmail<Option>()` with the options generic.

Faire Auth uses a single track. The route config defines Zod schemas. `ProcessRouteConfig` transforms those schemas based on options. No metadata override needed. The schemas themselves carry the type information, and the transformation is uniform:

```ts
export type ProcessRouteConfig<R, O> = R extends {
  operationId: any; middleware?: any; request?: any; responses?: any;
}
  ? {
    [K in keyof R]:
      K extends "middleware"  ? _ProcessMiddleware<R, O> :
      K extends "request"    ? _ProcessRequest<R["request"], O> :
      K extends "responses"  ? _ProcessResponses<R["responses"], O> :
      NoU<R[K]>;
  }
  : never;
```

`_ProcessRequest` applies `StripBrand2D` with `"input"` direction. `_ProcessResponses` applies it with `"output"` direction. `_ProcessMiddleware` appends any user-provided middleware for this operationId. Every route goes through the same processing pipeline. There's no special case for "this endpoint has option-dependent types."

### What This Enables

Because every route config is processed uniformly, Faire Auth can offer three features that Better Auth can't type:

**Per-route middleware.** You declare middleware keyed by operationId:

```ts
faireAuth({
  middleware: {
    signUpEmail: async (ctx, next) => {
      ctx.set("signupSource", ctx.req.header("X-Signup-Source") || "direct");
      await next();
    },
  },
});
```

`_ProcessMiddleware` appends it to the route's middleware tuple. The type system tracks what each middleware adds to the context. `InferPluginMiddleware<T>` generates typed middleware definitions for each plugin route using `RouteConfigToMiddleware<C>`.

**Per-route hooks.** Post-validation hooks keyed by operationId:

```ts
faireAuth({
  routeHooks: {
    signUpEmail: (result, ctx) => {
      if (result.success && result.target === "json") {
        result.data.referralCode = generateReferralCode();
      }
    },
  },
});
```

`InferPluginHooks<T>` generates `RouteHook<C>` for each route, typed with the specific route's input/output shapes. The hook receives the validated result (success with data, or failure with ZodError) and the Hono context.

**Global DTOs.** As described above. The DTO system doesn't exist in Better Auth at any level.

### The `defineOptions` Helper

To get autocomplete for middleware, hooks, and DTOs keyed by plugin routes, Faire Auth provides `defineOptions`:

```ts
export function defineOptions<
  const T extends FaireAuthPlugin[],
  U extends {
    routeHooks?: InferPluginHooks<T>;
    middleware?: InferPluginMiddleware<T>;
    dto?: InferPluginDTO<T>;
    rateLimit?: InferPluginRateLimit<T>;
  } & ExK<FaireAuthOptions, "plugins">,
>(config: { plugins: T } & U): { plugins: T } & U;
```

`const T` captures the plugin tuple literally. `InferPluginHooks<T>` iterates each plugin's routes, extracts the route config `C` from `AuthEndpoint<C>`, and creates a `RouteHook<C>` for each. The result: when you type `routeHooks: { }` and trigger autocomplete, you see every route name from every plugin you've added, with the correct hook signature for each.

Better Auth's hooks are untyped matchers: `{ matcher: (ctx) => boolean; handler: AuthMiddleware }`. You get no autocomplete for route names, no typed access to the validated input, and no type-safe context.

## The Middleware Stack

Better Auth distributes cross-cutting concerns through `toAuthEndpoints`, a wrapper that runs before/after hooks around each endpoint call. The hooks come from two sources: user-defined `options.hooks.{before,after}` and plugin-defined `plugin.hooks.{before,after}`. Every hook has a matcher function that decides whether it runs for a given request.

```ts
// better-auth's toAuthEndpoints (simplified)
for (const [key, endpoint] of Object.entries(endpoints)) {
  api[key] = async (context?) => {
    const authContext = await ctx;
    const { beforeHooks, afterHooks } = getHooks(authContext);
    const before = await runBeforeHooks(internalContext, beforeHooks, endpoint);
    if (before is response) return before;
    const result = await endpoint(internalContext);
    const after = await runAfterHooks(internalContext, afterHooks, endpoint);
    return result;
  };
}
```

Faire Auth uses Hono's middleware stack. Cross-cutting concerns are explicit middleware functions with a defined execution order:

```ts
new Hono()
  .basePath(options.basePath!)
  .use(
    // Setup
    setDefaultExecutionCtx,           // edge runtime promise tracking
    setRenderer,                       // inject ctx.render() with DTO support
    initContextMiddleware(options, context, endpoints),
    contextStorage(),                  // AsyncLocalStorage for context propagation

    // Request interception
    initHandleDisabledMiddleware(options),    // 404 disabled paths (early exit)
    initInterceptMiddleware(options),         // plugin onRequest/onResponse
    initRateLimitMiddleware(options, context.rateLimit),

    // Validation
    initOriginCheckMiddleware(options, context),
    initHooksMiddleware(options),             // before/after hooks
  )
  .onError(initErrorHandler(options))
  .route("/", app);                          // OpenAPI routes with per-route middleware
```

The order matters and it's explicit. Disabled paths are filtered before rate limiting (no point counting a 404 against the limit). Rate limiting runs before origin checks (cheaper to reject early). Origin checks run before hooks. Each middleware is a standalone function that can be tested, replaced, or extended independently.

### Rate Limiting

Faire Auth ships rate limiting with pluggable storage backends (memory, database, secondary storage like Redis). The rate limiter tracks requests per IP + path with configurable windows:

```ts
faireAuth({
  rateLimit: {
    enabled: true,
    window: 60,   // seconds
    max: 100,
    storage: "secondary-storage",
    customRules: {
      "/sign-in/email": { window: 10, max: 3 },
      "/sign-up/email": { window: 10, max: 3 },
    },
  },
});
```

`InferPluginRateLimit<T>` generates typed custom rules keyed by path, with typed request parameters:

```ts
export type InferPluginRateLimit<T extends readonly FaireAuthPlugin[]> = {
  customRules?: UnionToIntersection<
    T extends (infer P)[]
      ? P extends { routes: infer R }
        ? R extends Record<string, infer E>
          ? E extends AuthEndpoint<infer C>
            ? { [K in C as K["path"]]?: { window: number; max: number } | false
                | ((request: HonoRequest<K["path"], CustomIO<K, "out">>) => ...) }
            : {} : {} : {} : {}
  >;
};
```

Custom rules can be static config, `false` to disable, or a function that receives a typed request and returns config dynamically. Better Auth has no built-in rate limiting.

### Synchronous Initialization

Better Auth's `$context` is `Promise<AuthContext>`. The auth context is created asynchronously, and every endpoint call awaits it:

```ts
// better-auth
export type Auth<Options> = {
  $context: Promise<AuthContext<Options> & InferPluginContext<Options>>;
  // ...
};

// in toAuthEndpoints
api[key] = async (context?) => {
  const authContext = await ctx;  // awaited on every request
  // ...
};
```

Faire Auth's init is synchronous. `init()` returns `[context, options]` as a tuple, and the context is available immediately:

```ts
export const faireAuth = <Options extends FaireAuthOptions>(options: Options) => {
  const [authContext, authOptions] = init(options);
  const { api, app } = router(authContext, authOptions);
  return { handler, app, api, options: authOptions, $context: authContext, $Infer, $ERROR_CODES }
    satisfies Auth<Options>;
};
```

Plugins run synchronously in `runPluginInit`:

```ts
const runPluginInit = (ctx: AuthContext, options: FaireAuthOptions) => {
  let context = ctx;
  for (const plugin of options.plugins ?? []) {
    if (plugin.init) {
      const result = plugin.init(context);
      if (typeof result === "object") {
        if (result.options) options = defu(options, result.options);
        if (result.context) context = { ...context, ...result.context };
      }
    }
  }
};
```

No `await`, no promises. This matters for edge runtimes. Cloudflare Workers and Vercel Edge Functions prefer synchronous initialization at module load time. An async init means either top-level await (which not all bundlers handle) or lazy initialization on first request (which adds latency to cold starts). Synchronous init means the auth instance is ready the moment the module loads.

The `satisfies Auth<Options>` at the end is also deliberate. Better Auth uses `as any`:

```ts
// better-auth
return { handler, api, options, $context, $ERROR_CODES } as any;
```

`satisfies` checks the structure without widening the type. The narrow `Options` generic is preserved. `as any` gives up. The return type comes from the `Auth<Options>` annotation at the call site, not from the implementation. If the implementation drifts from the interface, `as any` won't catch it.

## OpenAPI

Better Auth disables OpenAPI by default:

```ts
return createRouter(api, {
  openapi: { disabled: true },
  // ...
});
```

Faire Auth builds on `OpenAPIHono` and generates a full OpenAPI 3.0/3.1 spec from the route schemas:

```ts
let app = new OpenAPIHono(options)
  .openapi(...pub[0])
  .openapi(...pub[1])
  // ... 29 base routes explicitly chained for type inference
  ;

// plugin routes added dynamically
pub.slice(29).forEach((route) => (app = app.openapi(...(route as [any, any, any]))));
```

Each `.openapi()` call registers the route with Hono's OpenAPI registry, creates `zValidator` middleware for request validation (query, params, headers, cookies, body), and attaches the handler. The schema is the source of truth. It defines both the runtime validation and the type inference.

The 29-route explicit chain is ugly but necessary. TypeScript can't infer types through arbitrary loops. Each `.openapi()` call chains the route's schema into the Hono app type. If you loop, the type is `OpenAPIHono<ContextVars, any, BasePath>`. If you chain, it's `OpenAPIHono<ContextVars, Route1Schema & Route2Schema & ... & Route29Schema, BasePath>`. Plugin routes are added after the type is frozen (line 75 comment: "we can freeze app inference at this point in time") because their schemas are already captured by `AllPluginConfigs<O>`.

The result: Faire Auth can serve its own API documentation. You can point Swagger UI or Redoc at the OpenAPI endpoint and get a complete, accurate API reference generated from the same schemas that validate requests and infer types. Better Auth has no equivalent. You'd have to write the OpenAPI spec by hand and keep it in sync with the endpoints.

## The Client

Both libraries convert a flat map of endpoints into a nested callable object on the client. The path `/sign-up/email` becomes `client.signUp.email(...)`. The mechanisms are different.

### Better Auth: PathToObject + InferRoute

Better Auth's `PathToObject` is a simple recursive string split:

```ts
export type PathToObject<T extends string, Fn> =
  T extends `/${infer Segment}/${infer Rest}`
    ? { [K in CamelCase<Segment>]: PathToObject<`/${Rest}`, Fn> }
    : T extends `/${infer Segment}`
      ? { [K in CamelCase<Segment>]: Fn }
      : never;
```

`InferRoute` does the heavy lifting. It extracts `InputContext` from the endpoint's call signature, handles special cases for `/sign-up/email` and `/update-user` (hardcoded path checks to merge additional fields), and wraps everything in `BetterFetchResponse`. The response type for `/get-session` is also hardcoded:

```ts
T["path"] extends "/get-session"
  ? { user: InferUserFromClient<COpts>; session: InferSessionFromClient<COpts> } | null
  : RefineAuthResponse<NonNullable<Awaited<R>>, COpts>
```

`RefineAuthResponse` only fires for responses containing `{ token }` or `{ redirect }`, a heuristic for "auth-like" responses. Everything else passes through as the raw handler return type `R`.

### Faire Auth: BuildChain with Hono Schema

Faire Auth's client uses Hono's `ExtractSchema` to get the full schema from the app type, then builds the chain from that:

```ts
export type Client<S, BasePath extends string, COpts extends ClientOptions> =
  UnionToIntersection<
    S extends Record<infer K, any>
      ? K extends string
        ? PathToChain<K, BasePath, S, K, COpts["fetchOptions"] extends { throw: true } ? true : false>
        : never
      : never
  >;
```

`PathToChain` uses `Segments` (with a depth limit of 3) and `BuildChain` (with `Inc` counter types) to recursively build the nested object. At each level, `ExcludeServerPaths` filters out `SERVER_ONLY` and `isAction: false` routes. At the leaf level, `ClientRequest` from Hono's client types provides the base, and a custom wrapper adds typed `fetchOptions`, success/error discriminated unions, and `throw` mode support.

No hardcoded path checks. No special cases for `/sign-up/email` or `/get-session`. The types flow from the route schemas through `ProcessRouteConfig` and `StripBrand2D` — if you add a DTO for "user", every route that returns a branded user object gets the DTO's return type in the client automatically.

### The `$InferServerPlugin` Bridge

Both libraries use the same phantom property pattern to bridge server and client types:

```ts
export interface FaireAuthClientPlugin {
  id: string;
  $InferServerPlugin?: FaireAuthPlugin;  // never populated at runtime
  getActions?: ($fetch, $store, options) => Record<string, any>;
  getAtoms?: ($fetch) => Record<string, Atom<any>>;
  // ...
}
```

Client plugins set `$InferServerPlugin` to their server plugin's type. `InferAdditionalFromClient` follows this phantom reference to extract schema fields. `InferResolvedHooks` converts plugin atoms into `useX` hooks (filtering `$`-prefixed signals). `InferActions` extracts custom action return types. This pattern is identical in both libraries.

## The Server API

Better Auth's server API is the endpoint map itself, wrapped by `toAuthEndpoints` to inject context and hooks:

```ts
// better-auth
const endpoints = { ...baseEndpoints, ...pluginEndpoints, ok, error } as const;
const api = toAuthEndpoints(endpoints, ctx);
return { api: api as unknown as Omit<typeof endpoints, keyof PluginEndpoint> & PluginEndpoint };
```

The type uses `Omit` + intersection to let plugin endpoints override base endpoints. `InferAPI` then filters the map:

```ts
export type InferAPI<API> = InferSessionAPI<API> & FilteredAPI<API>;
```

`FilteredAPI` removes endpoints with `isAction: false` or `scope: "http"`. `InferSessionAPI` replaces `getSession` with a custom-typed version that returns `null` on missing session.

Faire Auth's server API goes through `createAPI`, which wraps endpoints in `execHelper` return types:

```ts
export type InferAPI<A extends AnyHono, HideCallbacks extends boolean = true> =
  ExtractSchema<A> extends Record<string, infer R>
    ? {
      [Method in keyof R as
        R[Method] extends { operationId: infer K }
          ? K extends string
            ? true extends HideCallbacks
              ? R[Method] extends { isAction: false } ? never : K
              : K
            : never
          : never
      ]: R[Method] extends { _api: infer Api } ? Api : never;
    } extends infer S ? UnionToIntersection<S> : never
    : never;
```

The `_api` property is attached to each route's schema entry by `AddExtra` during schema building. It stores the `execHelper` return type: a callable function with typed input, optional context/options, and configurable return modes (`asResponse`, `returnHeaders`). The API type is derived from the Hono schema, not from the endpoint map directly.

Each server API endpoint can be called two ways:

```ts
// From a route handler (intra-route): skips middleware, runs handler directly
const user = await api.getSession(ctx);

// From outside a request (server-side): creates a Request, runs through localApp
const user = await api.getSession({ headers: someHeaders });
```

The `localApp` is a scoped Hono instance with its own middleware stack (server API middleware, context, hooks, error handler). It's lazy-initialized on first server-side call. This ensures DTOs, hooks, and validation all run even for server-side API calls.

## Field Collection

Both libraries collect additional fields from options and plugins to build the full User and Session types. The mechanisms differ in one interesting way.

Better Auth uses recursive tuple deconstruction:

```ts
export type InferDBFieldsFromPlugins<ModelName extends string, Plugins extends unknown[] | undefined> =
  Plugins extends []
    ? {}
    : Plugins extends [infer P, ...infer Rest]
      ? P extends { schema: { [key in ModelName]: { fields: infer Fields } } }
        ? UnionToIntersection<InferDBFieldsOutput<Fields> & InferDBFieldsFromPlugins<ModelName, Rest>>
        : InferDBFieldsFromPlugins<ModelName, Rest>
      : {};
```

Faire Auth uses distributive conditionals:

```ts
export type InferFieldsFromPlugins<Options extends { plugins?: any[] }, Key extends string, Format = "output"> =
  Options["plugins"] extends (infer T)[]
    ? T extends { schema: { [key in Key]: { fields: infer Field } } }
      ? Format extends "output" ? InferFieldsOutput<Field> : InferFieldsInput<Field>
      : {}
    : {};
```

The recursive approach preserves tuple order and is more explicit. The distributive approach is shorter and relies on TypeScript's distribution over naked type parameters. Both produce the same result: a union of field objects for each matching plugin, later merged with `UnionToIntersection`. The distributive version handles the merging at higher levels (in `InferUser` / `InferSession`), while the recursive version wraps each step in `UnionToIntersection`.

## Error Handling

Better Auth handles errors per-endpoint in `toAuthEndpoints`. If the handler throws, the error bubbles through the after hooks, and if it's an `APIError`, it's caught and converted to a response. The router's `onError` callback does logging.

Faire Auth centralizes error handling in `initErrorHandler`, a Hono `onError` middleware:

```ts
const initErrorHandler = (options) => (error, ctx) => {
  if (ctx.finalized) return ctx.res;  // response already sent (redirect, etc.)

  // Convert to Response
  if (error instanceof Response) return error;
  if (error instanceof HTTPException) return error.getResponse();

  // APIError with statusText "FOUND" = 302 redirect
  if (error instanceof APIError && error.statusText === "FOUND") return error.getResponse();

  // User error callbacks
  if (options.onAPIError?.throw) throw error;
  if (options.onAPIError?.onError) options.onAPIError.onError(error, ctx);

  // DB errors get logged without exposing details
  if (error.message?.match(/column|table|relation|does not exist/)) {
    context.logger.error(error.message);
    return ctx.json({ success: false }, 500);
  }

  // Validation errors get 422 with Zod tree
  if (error instanceof z.ZodError) {
    return ctx.json({ success: false, details: treeifyError(error) }, 422);
  }

  return ctx.json({ success: false }, 500);
};
```

The `ctx.finalized` check is important. Some routes return early. OAuth callbacks issue 302 redirects by throwing an `APIError` with status "FOUND". Without the finalized check, the error handler would try to write a second response. The `options.onAPIError.exposeMessage` flag controls whether error messages appear in responses (off by default in production).

## Line Counts

Measured with `scc` on equivalent package sets (core, main package, CLI, expo, stripe):

The meaningful comparison is the core, excluding plugins. Faire Auth has 8 plugins ported; Better Auth has 27. The plugin line difference is mostly about scope, not optimization.

**Core (excluding plugins):**

| | Files | Lines | Code |
|---|---|---|---|
| Faire Auth | 343 | 61,777 | 50,875 |
| Better Auth + better-call | 363 | 85,638 | 72,489 |
| **Reduction** | | **-28%** | **-30%** |

The core reduction comes from three sources: removing `better-call` as a dependency (its routing, middleware, and endpoint primitives are replaced by Hono), consolidating error handling and request processing into the middleware stack, and eliminating the duplicate type inference paths (better-auth has both `$Infer.body` metadata overrides and standard schema inference; faire-auth has one path through `ProcessRouteConfig`).

## What I Learned

**Types should reflect transforms.** If your API transforms responses at runtime (stripping fields, renaming keys, adding computed properties) the types should know about it. A DTO system that's invisible to the type checker is a footgun. You'll spend more time fighting `as` casts than you saved by skipping the type plumbing.

**One processing pipeline beats two.** Better Auth has a standard path (infer from schema) and an override path (`$Infer.body` metadata). Faire Auth has one path: `ProcessRouteConfig` transforms every route config uniformly. One path means one set of edge cases, one debugging surface, one mental model.

**Hono's middleware model fits auth.** Authentication is a chain: parse request, check origin, rate limit, validate session, run handler, transform response. Hono's middleware stack maps directly to this. `better-call`'s hook system (before/after matchers) can express the same thing, but the execution model is less explicit. You're matching patterns instead of composing functions.

**Synchronous init matters on the edge.** Cloudflare Workers, Vercel Edge Functions, Deno Deploy. These runtimes want your module to export a handler immediately. Async init means either top-level await or lazy initialization with cold-start latency. Synchronous init means the `faireAuth()` call returns a ready-to-use handler at module scope.

**Framework features shrink plugins.** The 8 plugins I've ported so far are noticeably smaller than their better-auth equivalents. When the framework provides typed hooks, middleware, and DTOs keyed by operationId, plugins don't need to reinvent those extension points. Per-plugin hook wiring, middleware registration, and client boilerplate become configuration that the user owns, not code the plugin ships.

The code is at [github.com/igoforth/faire-auth](https://github.com/igoforth/faire-auth).

<p align="center">
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/igoforth/faire-auth/tree/main/templates/cloudflare-deploy"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare Workers" /></a>&nbsp;&nbsp;
  <a href="https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Figoforth%2Ffaire-auth%2Ftree%2Fmain%2Ftemplates%2Fvercel-deploy&env=FAIRE_AUTH_SECRET,FAIRE_AUTH_URL&envDescription=FAIRE_AUTH_SECRET%3A%20Generate%20with%20%60npx%20%40faire-auth%2Fcli%20secret%60.%20FAIRE_AUTH_URL%3A%20Your%20Vercel%20deployment%20URL%20(e.g.%20https%3A%2F%2Fyour-project.vercel.app).&envLink=https%3A%2F%2Ffaire-auth.com&products=%5B%7B%22type%22%3A%22integration%22%2C%22protocol%22%3A%22storage%22%2C%22productSlug%22%3A%22database%22%2C%22integrationSlug%22%3A%22tursocloud%22%7D%5D"><img src="https://vercel.com/button" alt="Deploy with Vercel" /></a>&nbsp;&nbsp;
  <a href="https://app.netlify.com/start/deploy?repository=https://github.com/igoforth/faire-auth-netlify"><img src="https://www.netlify.com/img/deploy/button.svg" alt="Deploy to Netlify" /></a>
</p>
