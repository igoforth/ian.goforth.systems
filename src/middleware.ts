import { chainMiddleware } from "@/lib/private/middlewares/chain";
import { withCSP } from "@/lib/private/middlewares/csp";
import { withNonce } from "@/lib/private/middlewares/nonce";
import { createStateMiddleware } from "@/lib/private/middlewares/state";

const { withState, getState, slipRequest, addHeaderToResponse } =
  createStateMiddleware();

export default chainMiddleware([withState, withNonce, withCSP]);

export { getState, slipRequest, addHeaderToResponse };

export const config = {
  matcher: [
    {
      source:
        "/((?!api|\\.well-known|_next/static|_next/image|favicon|icon|robots|sitemap|.*\\.png|.*\\.jpg|.*\\.jpeg|.*\\.svg|.*\\.css|.*\\.map).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
