/**
 * Which URLs Reflect is allowed to open.
 *
 * This is the security boundary of the whole web feature, and it exists because
 * of what sits behind it. Reflect serves an unauthenticated API on loopback, the
 * machine may be on a home network with a router admin page and a NAS, and on a
 * cloud host 169.254.169.254 hands out credentials to anyone who asks. A fetch
 * tool that will open any URL is a proxy into all of it, and the model can be
 * talked into using it by a web page it was asked to read.
 *
 * So the rule is the narrow one: public internet only, over http(s).
 *
 * Both halves matter. The hostname is checked because that is what the model
 * hands over, and the resolved addresses are checked because a name is not an
 * address — `evil.test` resolving to 127.0.0.1 is a two-line DNS record, and it
 * is the same rebinding hole the localOnly middleware was written to close.
 */

import dns from 'node:dns/promises';
import net from 'node:net';
import { record as ledger } from '../reflect/Ledger.js';

/** Names that never leave the machine, whatever DNS says about them. */
const BLOCKED_NAMES = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i, // mDNS — every printer and NAS on the network
  /\.internal$/i,
  /\.home$/i,
  /\.lan$/i,
];

/**
 * Address ranges that are not the public internet.
 *
 * 169.254.0.0/16 is the one people forget: it carries the cloud metadata
 * service at 169.254.169.254, which serves instance credentials with no
 * authentication at all.
 */
function isPrivateV4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0) return true; // "this network"
  if (a === 10) return true;
  if (a === 127) return true; // loopback — Reflect's own API lives here
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isPrivateV6(ip) {
  const s = ip.toLowerCase().split('%')[0];
  if (s === '::1' || s === '::') return true;
  if (s.startsWith('fe80')) return true; // link-local
  if (/^f[cd]/.test(s)) return true; // unique local
  // A v4 address wearing a v6 hat. Both spellings have to be handled, because
  // `new URL()` rewrites the readable one into the other: ::ffff:127.0.0.1
  // comes back out of url.hostname as ::ffff:7f00:1, and a check that only
  // knew the dotted form waved loopback straight through.
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (dotted) return isPrivateV4(dotted[1]);

  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
  if (hex) {
    const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
    return isPrivateV4([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
  }
  return false;
}

export const isPrivateAddress = (ip) => (net.isIPv6(ip) ? isPrivateV6(ip) : isPrivateV4(ip));

/**
 * @returns {{ok: true, url: URL} | {ok: false, reason: string}}
 */
/**
 * The check for a server the person chose themselves.
 *
 * checkUrl above exists because a *model* can name a URL, so it refuses
 * anything that is not the public internet. That is the wrong test for a
 * self-hosted search instance: pointing SearXNG at localhost:8888 or a box on
 * the LAN is the entire point of running SearXNG, and the address is typed by
 * the person, not suggested by a model.
 *
 * So this allows what checkUrl forbids, minus the one thing no instance is
 * ever on: the link-local range, which carries the cloud metadata service at
 * 169.254.169.254 and hands out credentials to anyone who asks. The query a
 * search sends is the person's own words, and sending those to a credential
 * endpoint is the one destination here with no innocent reading.
 *
 * Resolution still happens, because a name that resolves into link-local is
 * the same request with a friendlier spelling.
 */
export async function checkInstance(input, { resolve = dns.lookup } = {}) {
  let url;
  try {
    url = new URL(String(input));
  } catch {
    return { ok: false, reason: 'that is not a web address' };
  }
  if (!/^https?:$/.test(url.protocol)) {
    return { ok: false, reason: `${url.protocol.replace(':', '')} is not a web address` };
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const linkLocal = (ip) =>
    /^169\.254\./.test(ip) || /^fe80:/i.test(ip) || /^::ffff:169\.254\./i.test(ip);

  if (net.isIP(host)) {
    if (linkLocal(host)) return { ok: false, reason: `${host} is the cloud metadata range` };
    return { ok: true, url: url.href };
  }

  let addresses;
  try {
    addresses = await resolve(host, { all: true });
  } catch {
    return { ok: false, reason: `could not find ${host}` };
  }
  for (const { address } of addresses) {
    if (linkLocal(address)) {
      return { ok: false, reason: `${host} resolves into the cloud metadata range` };
    }
  }
  return { ok: true, url: url.href };
}

export async function checkUrl(input, { resolve = dns.lookup } = {}) {
  let url;
  try {
    url = new URL(String(input));
  } catch {
    return { ok: false, reason: 'that is not a URL' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    // file: would read the disk, and Reflect already has a folder-grant system
    // for that with a permission model attached.
    return { ok: false, reason: `${url.protocol.replace(':', '')} links cannot be opened — only http and https` };
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) return { ok: false, reason: 'that URL has no host' };
  if (BLOCKED_NAMES.some((re) => re.test(host))) {
    return { ok: false, reason: `${host} is on this machine or this network, not the web` };
  }

  // A literal address skips DNS entirely, so check it directly.
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) return { ok: false, reason: `${host} is a private address` };
    return { ok: true, url };
  }

  let addresses;
  try {
    // A lookup is itself something leaving: the resolver is told which host was
    // asked for, and it is told even when the guard below then refuses to
    // fetch it. A ledger that only counted successful fetches would be
    // omitting the one request that happens no matter what.
    ledger({ kind: 'dns', host, detail: 'name lookup' });
    addresses = await resolve(host, { all: true });
  } catch {
    return { ok: false, reason: `could not find ${host}` };
  }

  const list = Array.isArray(addresses) ? addresses : [addresses];
  if (!list.length) return { ok: false, reason: `could not find ${host}` };
  // Every address, not the first: a name that resolves to one public and one
  // private address must not be reachable by retry.
  for (const entry of list) {
    const ip = typeof entry === 'string' ? entry : entry.address;
    if (isPrivateAddress(ip)) {
      return { ok: false, reason: `${host} points at ${ip}, which is on this machine or this network` };
    }
  }

  return { ok: true, url };
}
