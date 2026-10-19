/**
 * Decides whether the link checker may connect to an IP address.
 *
 * Only globally routable unicast addresses pass. Loopback, private, link-local,
 * shared (CGNAT), documentation, benchmarking, multicast and reserved ranges are
 * blocked, and IPv6 forms that carry an IPv4 address (IPv4-mapped, NAT64, 6to4)
 * are judged by the IPv4 address they embed, so `::ffff:127.0.0.1` and
 * `::ffff:7f00:1` are loopback like `127.0.0.1`. Anything that does not parse as
 * an IP address is blocked.
 */

import { isIPv4 } from 'node:net';

export type AddressVerdict = { blocked: false } | { blocked: true; reason: string };

type Range = { base: bigint; prefix: number; reason: string };

const IPV4_BLOCKED: Array<[string, number, string]> = [
  ['0.0.0.0', 8, '"this network" (0.0.0.0/8)'],
  ['10.0.0.0', 8, 'private (10.0.0.0/8)'],
  ['100.64.0.0', 10, 'shared address space (100.64.0.0/10)'],
  ['127.0.0.0', 8, 'loopback (127.0.0.0/8)'],
  ['169.254.0.0', 16, 'link-local (169.254.0.0/16)'],
  ['172.16.0.0', 12, 'private (172.16.0.0/12)'],
  ['192.0.0.0', 24, 'IETF protocol assignments (192.0.0.0/24)'],
  ['192.0.2.0', 24, 'documentation (192.0.2.0/24)'],
  ['192.88.99.0', 24, '6to4 relay anycast (192.88.99.0/24)'],
  ['192.168.0.0', 16, 'private (192.168.0.0/16)'],
  ['198.18.0.0', 15, 'benchmarking (198.18.0.0/15)'],
  ['198.51.100.0', 24, 'documentation (198.51.100.0/24)'],
  ['203.0.113.0', 24, 'documentation (203.0.113.0/24)'],
  ['224.0.0.0', 4, 'multicast (224.0.0.0/4)'],
  ['240.0.0.0', 4, 'reserved (240.0.0.0/4)'],
];

const IPV6_BLOCKED: Array<[string, number, string]> = [
  ['2001:db8::', 32, 'documentation (2001:db8::/32)'],
  ['2001:10::', 28, 'ORCHID (2001:10::/28)'],
  ['2001:20::', 28, 'ORCHIDv2 (2001:20::/28)'],
  ['3fff::', 20, 'documentation (3fff::/20)'],
];

const GLOBAL_UNICAST_V6: Range = { base: 0x2n << 124n, prefix: 3, reason: 'not global unicast' };
const IPV4_MAPPED: Range = { base: 0xffffn << 32n, prefix: 96, reason: 'IPv4-mapped' };
const IPV4_COMPATIBLE: Range = { base: 0n, prefix: 96, reason: 'IPv4-compatible (deprecated)' };
const NAT64: Range = { base: 0x64ff9bn << 96n, prefix: 96, reason: 'NAT64' };
const SIX_TO_FOUR: Range = { base: 0x2002n << 112n, prefix: 16, reason: '6to4' };
const TEREDO: Range = { base: 0x20010000n << 96n, prefix: 32, reason: 'Teredo (2001::/32)' };

const v4Ranges: Range[] = IPV4_BLOCKED.map(([base, prefix, reason]) => ({
  base: parseIPv4(base) as bigint,
  prefix,
  reason,
}));
const v6Ranges: Range[] = IPV6_BLOCKED.map(([base, prefix, reason]) => ({
  base: parseIPv6(base) as bigint,
  prefix,
  reason,
}));

function inRange(value: bigint, range: Range, bits: number): boolean {
  const shift = BigInt(bits - range.prefix);
  return value >> shift === range.base >> shift;
}

/** Parses a dotted-quad IPv4 address into a 32-bit integer, or null. */
export function parseIPv4(address: string): bigint | null {
  if (!isIPv4(address)) return null;
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part))) return null;
  return parts.reduce((value, part) => (value << 8n) | BigInt(Number(part)), 0n);
}

/** Parses an IPv6 address (optionally bracketed, with an IPv4 tail) into a 128-bit integer. */
export function parseIPv6(input: string): bigint | null {
  let address = input.startsWith('[') && input.endsWith(']') ? input.slice(1, -1) : input;
  if (address.includes('%')) return null; // zone identifiers are link-local by definition

  // A trailing dotted IPv4 address (::ffff:127.0.0.1) fills the last two groups
  let tail: bigint[] = [];
  if (address.includes('.')) {
    const lastColon = address.lastIndexOf(':');
    const v4 = parseIPv4(address.slice(lastColon + 1));
    if (v4 === null) return null;
    tail = [v4 >> 16n, v4 & 0xffffn];
    const head = address.slice(0, lastColon + 1);
    address = head.endsWith('::') ? head : head.slice(0, -1);
  }

  const halves = address.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): bigint[] | null => {
    if (part === '') return [];
    const groups = part.split(':');
    if (groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
    return groups.map((group) => BigInt(parseInt(group, 16)));
  };

  const head = parse(halves[0] ?? '');
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : [];
  if (head === null || rest === null) return null;

  const explicit = head.length + rest.length + tail.length;
  let groups: bigint[];
  if (halves.length === 2) {
    if (explicit > 7) return null;
    groups = [...head, ...Array<bigint>(8 - explicit).fill(0n), ...rest, ...tail];
  } else {
    groups = [...head, ...tail];
  }
  if (groups.length !== 8) return null;
  return groups.reduce((value, group) => (value << 16n) | group, 0n);
}

function formatIPv4(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join('.');
}

function classifyIPv4(value: bigint): AddressVerdict {
  const range = v4Ranges.find((candidate) => inRange(value, candidate, 32));
  return range ? { blocked: true, reason: range.reason } : { blocked: false };
}

function classifyEmbedded(value: bigint, label: string): AddressVerdict {
  const verdict = classifyIPv4(value);
  return verdict.blocked
    ? { blocked: true, reason: `${label} ${formatIPv4(value)}: ${verdict.reason}` }
    : verdict;
}

function classifyIPv6(value: bigint): AddressVerdict {
  if (value === 0n) return { blocked: true, reason: 'unspecified (::)' };
  if (value === 1n) return { blocked: true, reason: 'loopback (::1)' };
  if (inRange(value, IPV4_MAPPED, 128)) {
    return classifyEmbedded(value & 0xffffffffn, 'IPv4-mapped');
  }
  if (inRange(value, IPV4_COMPATIBLE, 128)) {
    return { blocked: true, reason: IPV4_COMPATIBLE.reason };
  }
  if (inRange(value, NAT64, 128)) {
    return classifyEmbedded(value & 0xffffffffn, 'NAT64');
  }
  if (inRange(value, TEREDO, 128)) {
    return { blocked: true, reason: TEREDO.reason };
  }
  if (inRange(value, SIX_TO_FOUR, 128)) {
    return classifyEmbedded((value >> 80n) & 0xffffffffn, '6to4');
  }
  if (!inRange(value, GLOBAL_UNICAST_V6, 128)) {
    return { blocked: true, reason: 'not global unicast (outside 2000::/3)' };
  }
  const range = v6Ranges.find((candidate) => inRange(value, candidate, 128));
  return range ? { blocked: true, reason: range.reason } : { blocked: false };
}

/** Classifies an IPv4 or IPv6 address string. Unparseable input is blocked. */
export function classifyAddress(address: string): AddressVerdict {
  const v4 = parseIPv4(address);
  if (v4 !== null) return classifyIPv4(v4);
  const v6 = parseIPv6(address);
  if (v6 !== null) return classifyIPv6(v6);
  return { blocked: true, reason: `not an IP address: ${address}` };
}
