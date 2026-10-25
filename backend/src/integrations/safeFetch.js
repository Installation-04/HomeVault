import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

// Fetches a URL on behalf of a user without letting them point the server at its own network.
// A calendar address typed into a form is attacker-controlled input: without these checks it could
// be http://169.254.169.254/ (cloud credentials), http://localhost:4000/, the router, or another
// container. So:
//   - only http(s), no credentials in the URL;
//   - every address the name resolves to must be public; the connection is then made to exactly an
//     address that passed (the check lives in the socket's own DNS lookup, so a name cannot answer
//     "public" for the check and "private" for the connection);
//   - literal IPs are checked up front (Node does not resolve those);
//   - redirects are followed by hand and every hop goes through the same checks;
//   - bounded size and time, no compression (nothing to inflate).
// INTEGRATIONS_ALLOW_PRIVATE_HOSTS=true lifts the address check for people who want to subscribe to
// a calendar on their own LAN (e.g. a Nextcloud next door); everything else stays.

const blocked = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT (also Tailscale)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. cloud metadata endpoints
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24],
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24],
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
]) {
  blocked.addSubnet(address, prefix, 'ipv4');
}
for (const [address, prefix] of [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // NAT64: can embed any IPv4 address
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
]) {
  blocked.addSubnet(address, prefix, 'ipv6');
}

// IPv4-mapped IPv6 addresses (::ffff:10.0.0.1, in either notation) are checked against the IPv4 rules.
export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (!family) return false;
  return !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export const allowPrivateHosts = () => process.env.INTEGRATIONS_ALLOW_PRIVATE_HOSTS === 'true';

const fail = (message, code) => Object.assign(new Error(message), { status: 400, code });

// Validates a URL string and returns a URL object, or throws a user-facing error.
export function checkUrl(raw, { allowPrivate = allowPrivateHosts(), addressPolicy } = {}) {
  let url;
  try {
    // webcal:// is just "an iCalendar feed"; in practice every provider serves it over https.
    url = new URL(String(raw).trim().replace(/^webcals?:\/\//i, 'https://'));
  } catch {
    throw fail('That is not a valid web address.', 'bad_url');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw fail('Only http:// and https:// addresses can be used.', 'bad_url');
  if (url.username || url.password) throw fail('Remove the user name and password from the address.', 'bad_url');
  if (url.href.length > 2048) throw fail('That web address is too long.', 'bad_url');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const allowed = addressPolicy ?? (allowPrivate ? () => true : isPublicAddress);
  if (net.isIP(host) && !allowed(host)) throw fail('That address points inside a private network, which is not allowed.', 'private_address');
  return url;
}

// dns.lookup replacement used by the socket: keeps only addresses the policy accepts.
function guardedLookup(allowed) {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const ok = addresses.filter((a) => allowed(a.address));
      if (ok.length === 0) return callback(fail('That address points inside a private network, which is not allowed.', 'private_address'));
      if (options.all) return callback(null, ok);
      return callback(null, ok[0].address, ok[0].family);
    });
  };
}

function requestOnce(url, { method, headers, body, maxBytes, timeoutMs, allowed }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const req = lib.request(
      url,
      { method, headers: { 'Accept-Encoding': 'identity', 'User-Agent': 'HomeVault', ...headers }, lookup: guardedLookup(allowed), agent: false },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            // Reject first: destroying the response also fires 'aborted', which must not win.
            done(reject, fail(`The response is larger than ${Math.round(maxBytes / 1048576)} MB.`, 'too_large'));
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => done(resolve, { status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', (err) => done(reject, err));
        res.on('aborted', () => done(reject, fail('The connection was interrupted.', 'aborted')));
      }
    );
    const timer = setTimeout(() => {
      req.destroy();
      done(reject, fail('The server took too long to answer.', 'timeout'));
    }, timeoutMs);
    req.on('error', (err) => done(reject, err.status ? err : fail(`Could not connect (${err.code || err.message}).`, 'unreachable')));
    if (body) req.write(body);
    req.end();
  });
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

// Resolves to { status, headers, text, url } for the final response. Non-2xx statuses are returned, not thrown.
// sameOriginOnly: requests that carry credentials must never be replayed to another host by a redirect.
export async function safeFetch(raw, options = {}) {
  const { method = 'GET', headers = {}, body, maxBytes = 8 * 1024 * 1024, timeoutMs = 20_000, maxRedirects = 4, allowPrivate = allowPrivateHosts(), addressPolicy, sameOriginOnly = false } = options;
  const allowed = addressPolicy ?? (allowPrivate ? () => true : isPublicAddress);
  let url = checkUrl(raw, { allowPrivate, addressPolicy });
  for (let hop = 0; ; hop += 1) {
    const res = await requestOnce(url, { method, headers, body, maxBytes, timeoutMs, allowed });
    if (REDIRECTS.has(res.status) && res.headers.location) {
      if (hop >= maxRedirects) throw fail('The address redirects too many times.', 'too_many_redirects');
      const next = checkUrl(new URL(res.headers.location, url).href, { allowPrivate, addressPolicy });
      if (sameOriginOnly && next.origin !== url.origin) throw fail('The server redirected to a different address, which is not followed for requests that carry credentials.', 'cross_origin_redirect');
      url = next;
      continue;
    }
    return { ...res, url: url.href };
  }
}
