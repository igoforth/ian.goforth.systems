import "server-only";

import type { NextFetchEvent, NextRequest } from "next/server";
import type { MiddlewareFactory, NextMiddleware } from "./chain";
import { addHeaderToResponse, slipRequest } from "@/middleware";
import { CSPBuilder } from "../csp";

const builder = CSPBuilder.createDefault({
  isDev: process.env.NODE_ENV === "development",
});

const withCSP: MiddlewareFactory =
  (next: NextMiddleware) =>
  async (request: NextRequest, evt: NextFetchEvent) => {
    if (slipRequest(request)) return next(request, evt);

    const nonce = request.headers.get("x-nonce");
    const cspHeader = builder.build(nonce ? { nonce } : {});

    addHeaderToResponse(request, "Content-Security-Policy", cspHeader);
    addHeaderToResponse(
      request,
      "Cross-Origin-Opener-Policy",
      "same-origin",
    );
    addHeaderToResponse(
      request,
      "Cross-Origin-Resource-Policy",
      "same-origin",
    );
    addHeaderToResponse(
      request,
      "Cross-Origin-Embedder-Policy",
      "credentialless",
    );
    addHeaderToResponse(request, "X-Content-Type-Options", "nosniff");
    addHeaderToResponse(request, "X-Frame-Options", "DENY");
    addHeaderToResponse(
      request,
      "Referrer-Policy",
      "strict-origin-when-cross-origin",
    );
    addHeaderToResponse(
      request,
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=()",
    );

    return next(request, evt);
  };

export { withCSP };
