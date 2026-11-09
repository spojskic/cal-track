/**
 * Playwright network routing for a smoke run. Nothing leaves the machine and no socket is opened:
 *  - https://app.test            -> files of the web export (SPA fallback), served from disk
 *  - https://mock.supabase.test  -> the in-process mock backend
 *  - everything else             -> aborted and logged
 */
import type { BrowserContext, Route } from 'playwright-core';

import { APP_ORIGIN, BACKEND_ORIGIN } from './constants';
import type { AppFiles } from './app-files';
import type { MockBackend } from './mock-backend';

export interface BlockedRequest {
  url: string;
  method: string;
  resourceType: string;
}

export interface RequestLog {
  /** Requests to other origins that were aborted. */
  blocked: BlockedRequest[];
  /** Paths on the app origin that do not exist in the build (404). */
  app404: string[];
}

export interface RoutingDeps {
  files: AppFiles;
  /** The backend of the scenario that is currently running. */
  getBackend: () => MockBackend;
  log: RequestLog;
}

export function createRouteHandler(deps: RoutingDeps): (route: Route) => Promise<void> {
  return async (route) => {
    const request = route.request();
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      await route.abort('failed');
      return;
    }
    const headers = request.headers();

    if (url.origin === APP_ORIGIN) {
      const served = deps.files.serve(url.pathname, headers.accept ?? '');
      if (!served) {
        deps.log.app404.push(`${request.method()} ${url.pathname}`);
        await route.fulfill({ status: 404, contentType: 'text/plain; charset=utf-8', body: 'Not found' });
        return;
      }
      await route.fulfill({
        status: served.status,
        headers: { 'content-type': served.contentType, 'cache-control': 'no-store' },
        body: served.body,
      });
      return;
    }

    if (url.origin === BACKEND_ORIGIN) {
      const res = deps.getBackend().handle({
        method: request.method(),
        url: request.url(),
        headers: { origin: APP_ORIGIN, ...headers },
        body: request.postData(),
      });
      await route.fulfill({ status: res.status, headers: res.headers, body: res.body });
      return;
    }

    deps.log.blocked.push({ url: request.url(), method: request.method(), resourceType: request.resourceType() });
    await route.abort('blockedbyclient');
  };
}

/** Installs the handler for every request of every page of the context. */
export async function installRouting(context: BrowserContext, deps: RoutingDeps): Promise<void> {
  await context.route(() => true, createRouteHandler(deps));
}
