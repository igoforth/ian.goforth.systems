# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Personal website and infosec blog for Ian Goforth, built with Next.js 16 (App Router) and deployed to Cloudflare Workers via @opennextjs/cloudflare.

## Commands

```bash
pnpm install          # install dependencies
pnpm run dev          # local dev server (turbopack)
pnpm run build        # production build (webpack, for trusted types config)
pnpm run preview      # build + preview in Workers runtime locally
pnpm run deploy       # build + deploy to Cloudflare Workers
```

## Architecture

- **Next.js 16 App Router** with React Server Components, React Compiler, typed routes, view transitions
- **`src/settings.mjs`** — site constants (title, description, siteUrl) importable from both next.config.mjs and TypeScript via `@/lib/config`
- **`src/lib/posts.ts`** — reads markdown from `src/content/blog/`, parses frontmatter with gray-matter, sorts by date. Uses `server-only` to prevent client bundling.
- **`src/content/`** — markdown files for blog posts (`src/content/blog/*.md`) and the about page (`src/content/about.md`)
- **`src/app/`** — Next.js App Router pages
  - `layout.tsx` — root layout with Header, Footer, global CSS, metadata + viewport exports
  - `page.tsx` — home page
  - `blog/page.tsx` — blog index (lists posts sorted by date)
  - `blog/[slug]/page.tsx` — dynamic blog post route with `generateStaticParams` and `generateMetadata`, renders MDX via `next-mdx-remote/rsc`
  - `about/page.tsx` — about page, also MDX-rendered
  - `rss.xml/route.ts` — RSS feed via `feed` package
  - `sitemap.ts` — typed `MetadataRoute.Sitemap` with `revalidate = 86400`
  - `robots.ts` — typed `MetadataRoute.Robots`
- **`src/components/`** — Header (client component with `usePathname` for active links, typed route hrefs), Footer
- **`src/styles/`** — `global.css` (Bear Blog base), `prism.css` (VS Code Dark+ syntax theme)
- **Markdown rendering** uses `next-mdx-remote` with `remark-gfm` (task lists, footnotes, tables) and `rehype-prism-plus` (syntax highlighting)

## Security (middleware chain pattern from yan2026)

- **`src/middleware.ts`** — chains middleware factories: state → nonce → CSP
- **`src/lib/private/middlewares/chain.ts`** — recursive middleware chain factory (each `MiddlewareFactory` wraps the next)
- **`src/lib/private/middlewares/state.ts`** — per-request state via `WeakMap<NextRequest, RequestState>`, buffers response headers, measures request duration (`X-Duration` header)
- **`src/lib/private/middlewares/nonce.ts`** — generates `crypto.randomUUID()` base64-encoded nonce, sets `x-nonce` request header
- **`src/lib/private/middlewares/csp.ts`** — builds CSP header via `CSPBuilder`, sets COOP/CORP/COEP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy
- **`src/lib/private/csp.ts`** — `CSPBuilder` class with fluent API, `createDefault()` factory producing strict CSP (`default-src 'none'`, `script-src 'strict-dynamic'` with nonce, `upgrade-insecure-requests`)
- **Webpack** sets `output.trustedTypes = { policyName: "nextjs#bundler" }` for Trusted Types compliance
- Middleware matcher excludes static assets and prefetch requests

## Conventions (from yan2026)

- `src/` directory with `@/*` path alias pointing to `./src/*`
- `settings.mjs` pattern for constants shared between next.config and TS source
- `server-only` import on server-side-only modules
- Strict tsconfig: `verbatimModuleSyntax`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`
- `next.config.mjs` (not `.ts`) with OpenNext dev init guarded by `NODE_ENV === "development"`
- Typed routes enabled — use `as const` for Link href values
- React Compiler via `babel-plugin-react-compiler`
- Build uses `--webpack` flag (required for trusted types webpack config)

## Blog Post Frontmatter

```yaml
title: "Post Title"
description: "Short description"
pubDate: "Mon DD YYYY"
heroImage: "/image.jpg"  # optional
```

## Deployment

- `wrangler.jsonc` configures Cloudflare Workers with `nodejs_compat` flag
- `open-next.config.ts` defines the OpenNext Cloudflare adapter config
- Static assets in `public/` are served directly (images, `.well-known/cf-2fa-verify.txt`)
