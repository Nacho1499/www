// Runs real requests against local servers. 127.0.0.1 is blocked by the default
// policy, so these tests inject a policy that allows exactly that address and
// defers everything else to classifyAddress, plus a fake resolver.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { classifyAddress } from '../../scripts/link-check/ip-policy';
import {
  safeRequest,
  UnsafeDestinationError,
  type ResolvedAddress,
  type SafeRequestOptions,
} from '../../scripts/link-check/safe-request';

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/ok') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    } else if (url.pathname === '/redirect') {
      res.writeHead(302, { location: url.searchParams.get('to') ?? '/ok' });
      res.end();
    } else if (url.pathname === '/loop') {
      res.writeHead(301, { location: '/loop' });
      res.end();
    } else if (url.pathname === '/hang') {
      // never answers
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Resolver that answers from a table and counts lookups per hostname. */
function fakeResolver(table: Record<string, ResolvedAddress[] | (() => ResolvedAddress[])>) {
  const lookups: Record<string, number> = {};
  const resolve = async (hostname: string) => {
    lookups[hostname] = (lookups[hostname] ?? 0) + 1;
    const entry = table[hostname];
    if (!entry) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    return typeof entry === 'function' ? entry() : entry;
  };
  return { resolve, lookups };
}

const v4 = (address: string): ResolvedAddress => ({ address, family: 4 });

function testOptions(resolve: SafeRequestOptions['resolve']): SafeRequestOptions {
  return {
    resolve,
    allowedPorts: [port],
    timeoutMs: 2_000,
    classify: (address) =>
      address === '127.0.0.1' ? { blocked: false } : classifyAddress(address),
  };
}

describe('safeRequest', () => {
  it('connects to the address it validated, even if DNS changes its answer (rebinding)', async () => {
    let answers = 0;
    const { resolve, lookups } = fakeResolver({
      // First answer passes the policy; every later one points at a private address.
      'rebind.test': () => (answers++ === 0 ? [v4('127.0.0.1')] : [v4('10.0.0.1')]),
    });
    const response = await safeRequest(`http://rebind.test:${port}/ok`, testOptions(resolve));
    expect(response.status).toBe(200);
    expect(response.address).toBe('127.0.0.1');
    // One validated lookup per hop; the socket used the pinned answer instead of
    // resolving rebind.test again (the system resolver does not know it at all).
    expect(lookups['rebind.test']).toBe(1);
  });

  it('re-validates every redirect hop', async () => {
    const { resolve } = fakeResolver({
      'site.test': [v4('127.0.0.1')],
      'internal.test': [v4('10.0.0.5')],
    });
    const target = encodeURIComponent(`http://internal.test:${port}/ok`);
    await expect(
      safeRequest(`http://site.test:${port}/redirect?to=${target}`, testOptions(resolve)),
    ).rejects.toThrow(/internal\.test resolves to 10\.0\.0\.5, private/);
  });

  it('rejects a redirect to an IPv4-mapped IPv6 loopback literal', async () => {
    const { resolve } = fakeResolver({ 'site.test': [v4('127.0.0.1')] });
    const target = encodeURIComponent(`http://[::ffff:127.0.0.1]:${port}/ok`);
    const request = safeRequest(
      `http://site.test:${port}/redirect?to=${target}`,
      testOptions(resolve),
    );
    await expect(request).rejects.toBeInstanceOf(UnsafeDestinationError);
    await expect(request).rejects.toThrow(/IPv4-mapped 127\.0\.0\.1: loopback/);
  });

  it('follows safe redirects and reports the chain', async () => {
    const { resolve } = fakeResolver({ 'site.test': [v4('127.0.0.1')] });
    const response = await safeRequest(
      `http://site.test:${port}/redirect?to=%2Fok`,
      testOptions(resolve),
    );
    expect(response.status).toBe(200);
    expect(response.redirects).toEqual([`http://site.test:${port}/ok`]);
  });

  it('stops after too many redirects', async () => {
    const { resolve } = fakeResolver({ 'site.test': [v4('127.0.0.1')] });
    await expect(
      safeRequest(`http://site.test:${port}/loop`, { ...testOptions(resolve), maxRedirects: 3 }),
    ).rejects.toThrow('more than 3 redirects');
  });

  it('times out a server that never answers', async () => {
    const { resolve } = fakeResolver({ 'site.test': [v4('127.0.0.1')] });
    await expect(
      safeRequest(`http://site.test:${port}/hang`, { ...testOptions(resolve), timeoutMs: 200 }),
    ).rejects.toThrow('timed out after 200 ms');
  });

  it('rejects a hostname when any of its addresses is private', async () => {
    const { resolve } = fakeResolver({ 'mixed.test': [v4('1.1.1.1'), v4('192.168.0.10')] });
    await expect(safeRequest('https://mixed.test/', { resolve })).rejects.toThrow(
      /mixed\.test resolves to 192\.168\.0\.10, private/,
    );
  });

  it.each([
    ['ftp://example.com/', /scheme ftp: is not allowed/],
    ['http://user:secret@example.com/', /credentials in URLs are not allowed/],
    ['http://example.com:8080/', /port 8080 is not allowed/],
    ['http://169.254.169.254/latest/meta-data/', /link-local/],
    ['http://[::1]/', /loopback/],
    ['http://[fd00::1]/', /not global unicast/],
    ['http://2130706433/', /loopback/],
    ['http://[::ffff:10.0.0.1]/', /IPv4-mapped 10\.0\.0\.1: private/],
  ])('refuses %s before connecting', async (url, reason) => {
    const { resolve, lookups } = fakeResolver({});
    await expect(safeRequest(url, { resolve })).rejects.toThrow(reason);
    expect(Object.keys(lookups)).toEqual([]);
  });

  it('reports DNS failures as errors, not unsafe destinations', async () => {
    const { resolve } = fakeResolver({});
    const request = safeRequest('https://missing.test/', { resolve });
    await expect(request).rejects.toThrow('DNS lookup for missing.test failed (ENOTFOUND)');
    await expect(request).rejects.not.toBeInstanceOf(UnsafeDestinationError);
  });
});
