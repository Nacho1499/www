/**
 * HTTP(S) requests that cannot be pointed at internal infrastructure.
 *
 * Link targets come from site content, so a pull request could add a link to
 * `http://169.254.169.254/` or to a hostname that resolves to a private address
 * and turn CI into an SSRF probe. Every hop of a request therefore:
 *
 *   1. accepts only http(s) URLs without credentials, on ports 80 and 443;
 *   2. resolves the hostname once and rejects it if any returned address is not
 *      globally routable (see ip-policy.ts, which also unwraps IPv4-mapped,
 *      NAT64 and 6to4 IPv6 addresses);
 *   3. connects to exactly that validated address through a pinned `lookup`, so
 *      a second DNS answer (DNS rebinding) is never used. TLS still verifies the
 *      certificate against the original hostname;
 *   4. follows redirects manually, repeating 1 to 3 for every `Location`.
 */

import { lookup } from 'node:dns/promises';
import http, { type IncomingHttpHeaders } from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { classifyAddress, type AddressVerdict } from './ip-policy.ts';

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface SafeRequestOptions {
  method?: 'HEAD' | 'GET';
  timeoutMs?: number;
  maxRedirects?: number;
  userAgent?: string;
  /** DNS resolver; defaults to the system resolver. Injected in tests. */
  resolve?: Resolver;
  /** Address policy; defaults to classifyAddress. Injected in tests. */
  classify?: (address: string) => AddressVerdict;
  allowedPorts?: readonly number[];
}

export interface SafeResponse {
  /** URL of the final hop. */
  url: string;
  status: number;
  headers: IncomingHttpHeaders;
  /** Every Location that was followed, in order. */
  redirects: string[];
  /** Validated address the final hop connected to. */
  address: string;
}

/** The destination is not allowed. Never retried. */
export class UnsafeDestinationError extends Error {
  constructor(
    readonly url: string,
    readonly reason: string,
  ) {
    super(`${url}: ${reason}`);
    this.name = 'UnsafeDestinationError';
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_USER_AGENT = 'wraith-www-link-checker/1.0 (+https://github.com/wraith-protocol/www)';

export const systemResolver: Resolver = async (hostname) => {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));
};

/**
 * Checks the URL and resolves its host. Throws UnsafeDestinationError unless
 * every address is public, and returns the address the request must use.
 */
export async function resolveSafeTarget(
  url: URL,
  options: SafeRequestOptions = {},
): Promise<ResolvedAddress> {
  const classify = options.classify ?? classifyAddress;
  const allowedPorts = options.allowedPorts ?? [80, 443];

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeDestinationError(url.href, `scheme ${url.protocol} is not allowed`);
  }
  if (url.username || url.password) {
    throw new UnsafeDestinationError(url.href, 'credentials in URLs are not allowed');
  }
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!allowedPorts.includes(port)) {
    throw new UnsafeDestinationError(url.href, `port ${port} is not allowed`);
  }

  // WHATWG URL parsing already normalizes 2130706433, 0x7f.1 and friends to dotted
  // quads and IPv6 literals to bracketed, compressed hex.
  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1');
  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    const verdict = classify(hostname);
    if (verdict.blocked) throw new UnsafeDestinationError(url.href, verdict.reason);
    return { address: hostname, family: literalFamily === 6 ? 6 : 4 };
  }

  let addresses: ResolvedAddress[];
  try {
    addresses = await (options.resolve ?? systemResolver)(hostname);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? (error as Error).message;
    throw new Error(`DNS lookup for ${hostname} failed (${code})`);
  }
  if (addresses.length === 0) {
    throw new Error(`DNS lookup for ${hostname} returned no addresses`);
  }
  for (const { address } of addresses) {
    const verdict = classify(address);
    if (verdict.blocked) {
      throw new UnsafeDestinationError(
        url.href,
        `${hostname} resolves to ${address}, ${verdict.reason}`,
      );
    }
  }
  return addresses[0] as ResolvedAddress;
}

/** A `lookup` that always answers with the address validated above. */
export function pinnedLookup(target: ResolvedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options?.all) {
      callback(null, [{ address: target.address, family: target.family }]);
    } else {
      callback(null, target.address, target.family);
    }
  };
}

function requestOnce(
  url: URL,
  target: ResolvedAddress,
  options: SafeRequestOptions,
): Promise<{ status: number; headers: IncomingHttpHeaders }> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const client = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const request = client.request(
      url,
      {
        method: options.method ?? 'HEAD',
        agent: false,
        lookup: pinnedLookup(target),
        timeout: timeoutMs,
        headers: {
          'user-agent': options.userAgent ?? DEFAULT_USER_AGENT,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      },
      (response) => {
        resolve({ status: response.statusCode ?? 0, headers: response.headers });
        // Only the status line and headers matter; never download bodies.
        response.destroy();
      },
    );
    request.on('timeout', () => request.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    request.on('error', reject);
    request.end();
  });
}

/** Requests `input`, validating and pinning every hop. */
export async function safeRequest(
  input: string,
  options: SafeRequestOptions = {},
): Promise<SafeResponse> {
  const maxRedirects = options.maxRedirects ?? 5;
  let url = new URL(input);
  url.hash = '';
  const redirects: string[] = [];

  for (;;) {
    const target = await resolveSafeTarget(url, options);
    const response = await requestOnce(url, target, options);
    const location = response.headers.location;

    if (REDIRECT_STATUSES.has(response.status) && location) {
      if (redirects.length >= maxRedirects) {
        throw new Error(`more than ${maxRedirects} redirects`);
      }
      url = new URL(location, url);
      url.hash = '';
      redirects.push(url.href);
      continue;
    }

    return {
      url: url.href,
      status: response.status,
      headers: response.headers,
      redirects,
      address: target.address,
    };
  }
}
