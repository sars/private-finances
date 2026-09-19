import { ConnectorError, type Requester } from './types.js';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Told about every request once it has settled, for the attempt record.
 *
 * It receives the path as asked; the recorder reduces it to a shape before
 * storing it, because these paths address a consent session and a provider
 * account id. Anything this reports is diagnostic only and must never change
 * what the requester returns — an observer that throws is ignored.
 */
export type RequestObserver = (event: {
  path: string;
  status?: number;
  ms: number;
  /** Bytes the bank answered with; absent when it never answered. */
  size?: number;
  code?: string;
  retryAfterMs?: number;
}) => void;

export function requester(
  origin: 'https://api.monobank.ua' | 'https://api.enablebanking.com',
  intervalMs = 0,
  fetcher: typeof fetch = fetch,
  observe?: RequestObserver,
): Requester {
  let lastStart = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const report: RequestObserver = (event) => {
    if (!observe) return;
    try {
      observe(event);
    } catch {
      // A failed note about a request is not a failed request.
    }
  };
  return (path, headers) => {
    const request = queue.then(async () => {
      if (!path.startsWith('/') || path.startsWith('//'))
        throw new ConnectorError('schema');
      const url = new URL(path, origin);
      if (url.origin !== origin) throw new ConnectorError('schema');
      const wait = intervalMs - (Date.now() - lastStart);
      if (wait > 0) await sleep(wait);
      lastStart = Date.now();
      const began = lastStart;
      try {
        const response = await fetcher(url, {
          method: 'GET',
          headers,
          redirect: 'error',
          signal: AbortSignal.timeout(20000),
        });
        if (!response.ok) {
          const retry = response.headers.get('retry-after');
          await response.body?.cancel();
          const refused = (error: ConnectorError) => {
            report({
              path,
              status: response.status,
              ms: Date.now() - began,
              code: error.code,
              ...(error.retryAfterMs === undefined
                ? {}
                : { retryAfterMs: error.retryAfterMs }),
            });
            return error;
          };
          if (response.status === 401 || response.status === 403)
            throw refused(new ConnectorError('auth'));
          if (response.status === 429) {
            const millis = retry
              ? /^\d+$/.test(retry)
                ? Number(retry) * 1000
                : Date.parse(retry) - Date.now()
              : 60000;
            throw refused(
              new ConnectorError(
                'rate_limit',
                Math.min(
                  Math.max(Number.isFinite(millis) ? millis : 60000, 1000),
                  86400000,
                ),
              ),
            );
          }
          if (response.status >= 500)
            throw refused(new ConnectorError('transient'));
          throw refused(new ConnectorError('schema'));
        }
        const reader = response.body?.getReader();
        if (!reader) throw new ConnectorError('schema');
        let size = 0;
        const chunks: Uint8Array[] = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 4 * 1024 * 1024) {
            await reader.cancel();
            throw new ConnectorError('incomplete');
          }
          chunks.push(value);
        }
        // A request that worked is reported too. Only the refusals were, at
        // first, which made a healthy run look as though it had asked the bank
        // for nothing at all — and "what did it request" is most of what the
        // run screen is for. The size is the response's length in bytes, which
        // says whether a bank answered thinly without saying what it answered.
        report({ path, status: response.status, ms: Date.now() - began, size });
        return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      } catch (error) {
        if (error instanceof ConnectorError) throw error;
        // Everything else is a connection that never produced a response: a
        // timeout, a refused socket, a body that stopped early. It has no
        // status, and it is the failure most worth seeing on the run screen
        // because nothing else records it anywhere.
        const code = error instanceof SyntaxError ? 'schema' : 'transient';
        report({ path, ms: Date.now() - began, code });
        throw new ConnectorError(code);
      }
    });
    queue = request.catch(() => undefined);
    return request;
  };
}
