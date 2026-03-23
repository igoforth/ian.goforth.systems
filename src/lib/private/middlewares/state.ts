import "server-only";

import type { NextRequest } from "next/server";
import type { MiddlewareFactory } from "./chain";

export interface RequestState {
  slipRequest?: boolean | undefined;
  slipResponse?: boolean | undefined;
  metrics?: { startTime: number } | undefined;
  responseHeaders?: Headers | undefined;
}

export const createStateMiddleware = () => {
  const state = new WeakMap<NextRequest, RequestState>();

  const withState: MiddlewareFactory = (next) => async (request, evt) => {
    const responseHeaders = new Headers();
    state.set(request, {
      slipRequest: false,
      slipResponse: false,
      metrics: { startTime: performance.now() },
      responseHeaders,
    });

    try {
      const response = await next(request, evt);

      if (!(response instanceof Response)) return response;

      const requestState = state.get(request);
      if (!requestState) return response;

      if (requestState.metrics) {
        const duration = performance.now() - requestState.metrics.startTime;
        addHeaderToResponse(request, "X-Duration", `${duration.toFixed(1)}ms`);
      }

      if (requestState.responseHeaders)
        for (const [key, value] of requestState.responseHeaders.entries())
          response.headers.set(key, value);

      return response;
    } finally {
      state.delete(request);
    }
  };

  const getState = (request: NextRequest): RequestState | undefined =>
    state.get(request);

  const slipRequest = (request: NextRequest): boolean =>
    request != null && state.get(request)?.slipRequest === true;

  const addHeaderToResponse = (
    request: NextRequest,
    name: string,
    value: string,
  ): void => {
    const current = state.get(request);
    if (current?.responseHeaders) current.responseHeaders.set(name, value);
  };

  return { withState, getState, slipRequest, addHeaderToResponse };
};
