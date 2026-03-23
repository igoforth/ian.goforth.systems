import "server-only";

import type { NextFetchEvent, NextRequest } from "next/server";
import { NextResponse } from "next/server";

type NextMiddlewareResult = NextResponse | null | undefined | void;
export type NextMiddleware = (
  request: NextRequest,
  event: NextFetchEvent,
) => NextMiddlewareResult | Promise<NextMiddlewareResult>;

type MiddlewareFactory = (middleware: NextMiddleware) => NextMiddleware;

const chainMiddleware = (
  functions: MiddlewareFactory[] = [],
  index = 0,
): NextMiddleware => {
  const current = functions[index];
  if (current) return current(chainMiddleware(functions, index + 1));
  return () => NextResponse.next();
};

export { type MiddlewareFactory, chainMiddleware };
