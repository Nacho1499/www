import { describe, expect, it } from 'vitest';
import { classifyAddress, parseIPv6 } from '../../scripts/link-check/ip-policy';

const blocked = (address: string) => classifyAddress(address).blocked;

describe('classifyAddress', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '192.0.0.8',
    '192.0.2.1',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
  ])('blocks the IPv4 address %s', (address) => {
    expect(blocked(address)).toBe(true);
  });

  it.each([
    '1.1.1.1',
    '8.8.8.8',
    '172.15.255.255',
    '172.32.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '192.169.0.1',
  ])('allows the public IPv4 address %s', (address) => {
    expect(classifyAddress(address)).toEqual({ blocked: false });
  });

  it.each([
    '::',
    '::1',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '2001:db8::1',
    '3fff::1',
    '64:ff9b:1::1',
    '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '100::1',
  ])('blocks the IPv6 address %s', (address) => {
    expect(blocked(address)).toBe(true);
  });

  it.each([
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['[::ffff:127.0.0.1]', 'loopback'],
    ['::ffff:10.0.0.1', 'private'],
    ['::ffff:169.254.169.254', 'link-local'],
    ['64:ff9b::7f00:1', 'loopback'],
    ['64:ff9b::10.0.0.1', 'private'],
    ['2002:7f00:1::1', 'loopback'],
    ['2002:c0a8:101::1', 'private'],
  ])('judges %s by the IPv4 address it embeds', (address, reason) => {
    const verdict = classifyAddress(address);
    expect(verdict.blocked).toBe(true);
    expect(verdict.blocked && verdict.reason).toContain(reason);
  });

  it('blocks IPv4-compatible IPv6 addresses', () => {
    expect(blocked('::127.0.0.1')).toBe(true);
    expect(blocked('::1.1.1.1')).toBe(true);
  });

  it.each(['2606:4700:4700::1111', '::ffff:1.1.1.1', '64:ff9b::1.1.1.1', '2002:101:101::1'])(
    'allows the public IPv6 address %s',
    (address) => {
      expect(classifyAddress(address)).toEqual({ blocked: false });
    },
  );

  it.each([
    'localhost',
    '',
    '1.2.3',
    '01.2.3.4',
    '1.2.3.256',
    '::ffff:1.2.3',
    'g::1',
    '1:2:3:4:5:6:7:8:9',
    '1::2::3',
    'fe80::1%eth0',
  ])('blocks %j, which is not a usable IP address', (address) => {
    expect(blocked(address)).toBe(true);
  });

  it('sees through the IPv4 spellings the URL parser normalizes', () => {
    for (const url of [
      'http://2130706433/',
      'http://0x7f.1/',
      'http://0177.0.0.1/',
      'http://127.1/',
    ]) {
      expect(blocked(new URL(url).hostname)).toBe(true);
    }
    expect(new URL('http://[::ffff:127.0.0.1]/').hostname).toBe('[::ffff:7f00:1]');
    expect(blocked(new URL('http://[::ffff:127.0.0.1]/').hostname)).toBe(true);
  });
});

describe('parseIPv6', () => {
  it('expands compressed and dotted forms', () => {
    expect(parseIPv6('::1')).toBe(1n);
    expect(parseIPv6('::ffff:127.0.0.1')).toBe(parseIPv6('::ffff:7f00:1'));
    expect(parseIPv6('2001:db8::1')).toBe(0x20010db8000000000000000000000001n);
  });
});
