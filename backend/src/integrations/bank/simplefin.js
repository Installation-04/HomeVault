import { Buffer } from 'node:buffer';
import { httpError } from '../../utils/http.js';
import { allowPrivateHosts, checkUrl, safeFetch } from '../safeFetch.js';

// SimpleFIN Bridge (https://www.simplefin.org/): a read-only way to pull bank transactions that the
// household sets up themselves. The person creates a one-time *setup token* at their bridge, pastes it
// here, and HomeVault trades it once for an *access URL* (a web address with a user name and password
// inside). That access URL is the only credential we keep; it can read balances and transactions and
// cannot move money, and the person can revoke it at the bridge at any time.
//
// The bridge allows about 24 requests a day, so syncs are infrequent by design.

const MAX_ACCOUNTS = 50;
const MAX_TRANSACTIONS = 20_000;
const WINDOW_DAYS = 89; // the bridge serves at most 90 days per request

// Messages here are fixed text (never the bridge's words or any credential), so they are safe to show as they are
// even for 5xx-style failures.
const fail = (status, message, code) => Object.assign(httpError(status, message, code), { expose: true });

function requireSecure(url, what) {
  // Credentials travel in this request, so plain http is refused unless the owner opted in to LAN use.
  if (url.protocol !== 'https:' && !allowPrivateHosts()) throw fail(400, `The ${what} must start with https://.`, 'bad_url');
}

// "Setup token" (base64 of the claim URL) or an access URL that was already claimed -> what we need next.
export function readSetupInput(raw) {
  const text = String(raw ?? '').trim();
  if (!text) throw fail(400, 'Paste the setup token from your SimpleFIN Bridge.', 'bad_token');
  if (text.length > 4096) throw fail(400, 'That is too long to be a SimpleFIN token.', 'bad_token');
  if (/^https?:\/\//i.test(text)) {
    // An access URL (credentials inside) from a token claimed elsewhere.
    return { access: parseAccessUrl(text) };
  }
  let claim;
  try {
    claim = Buffer.from(text.replace(/\s+/g, ''), 'base64').toString('utf8');
    claim = new URL(claim);
  } catch {
    throw fail(400, 'That does not look like a SimpleFIN setup token. Copy the whole token from the bridge.', 'bad_token');
  }
  if (!/^https?:$/.test(claim.protocol) || !claim.pathname.includes('/claim/')) {
    throw fail(400, 'That does not look like a SimpleFIN setup token. Copy the whole token from the bridge.', 'bad_token');
  }
  requireSecure(claim, 'bridge address');
  // Credentials never belong in a claim address; checkUrl also refuses private networks.
  return { claim_url: checkUrl(claim.href).href };
}

// "https://user:pass@host/simplefin" -> { base, username, password }. The password is never logged or returned.
export function parseAccessUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw fail(400, 'That access address is not valid.', 'bad_token');
  }
  if (!url.username || !url.password) throw fail(400, 'That access address has no credentials in it.', 'bad_token');
  requireSecure(url, 'access address');
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  url.username = '';
  url.password = '';
  const base = checkUrl(url.href.replace(/\/+$/, '')).href.replace(/\/+$/, ''); // refuses private networks
  return { base, username, password };
}

// Trades the one-time claim address for an access URL. Single use: if this fails after the bridge accepted
// it, the person has to create a new token.
export async function claimToken(claimUrl) {
  const res = await safeFetch(claimUrl, { method: 'POST', headers: { 'Content-Length': '0' }, maxBytes: 8 * 1024, maxRedirects: 0, sameOriginOnly: true });
  if (res.status === 403 || res.status === 404 || res.status === 410) {
    throw fail(400, 'The bridge did not accept that token. A setup token works only once; create a new one at your SimpleFIN Bridge.', 'token_rejected');
  }
  if (res.status < 200 || res.status >= 300) throw fail(400, `The bridge answered HTTP ${res.status}.`, 'http_error');
  const access = String(res.text).trim();
  if (!/^https?:\/\/[^\s]+@[^\s]+$/i.test(access)) throw fail(400, 'The bridge answered, but not with an access address.', 'bad_response');
  return parseAccessUrl(access);
}

const authHeader = (access) => `Basic ${Buffer.from(`${access.username}:${access.password}`).toString('base64')}`;

const money = (value) => {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(n) ? (Math.sign(n) * Math.round(Math.abs(n) * 100)) / 100 : null; // half away from zero, like a statement
};

const text = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

const day = (epochSeconds) => new Date(epochSeconds * 1000).toISOString().slice(0, 10);

// Reads the bridge's answer defensively: it is data from the internet, not trusted structure.
export function parseAccounts(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.accounts)) throw fail(502, 'The bridge answered in a way HomeVault does not understand.', 'bad_response');
  const messages = (Array.isArray(json.errors) ? json.errors : []).filter((m) => typeof m === 'string').map((m) => text(m, 200)).filter(Boolean).slice(0, 5);
  let total = 0;
  const accounts = json.accounts.slice(0, MAX_ACCOUNTS).flatMap((a) => {
    const id = text(a?.id, 200);
    if (!id) return [];
    const org = text(a.org?.name, 80) || text(a.org?.domain, 80);
    const currency = /^[A-Za-z]{3}$/.test(String(a.currency ?? '')) ? String(a.currency).toUpperCase() : null;
    const transactions = [];
    for (const t of Array.isArray(a.transactions) ? a.transactions : []) {
      if (total >= MAX_TRANSACTIONS) break;
      const tid = text(t?.id, 200);
      const amount = money(t?.amount);
      const posted = Number(t?.posted);
      // Pending transactions have no posting time yet and a different id once they post, so they wait.
      if (!tid || amount === null || !Number.isFinite(posted) || posted <= 0 || t.pending) continue;
      const description = text(t.description, 500) || text(t.payee, 500) || text(t.memo, 500) || 'Bank transaction';
      transactions.push({ external_id: tid, account_id: id, account: [org, text(a.name, 80)].filter(Boolean).join(' · ') || id, posted_date: day(posted), amount, currency, description });
      total += 1;
    }
    return [{ id, name: text(a.name, 80) || id, org, currency, transactions }];
  });
  return { accounts, messages };
}

// One request. withTransactions=false asks for the list of accounts only (used when connecting).
export async function fetchAccounts(access, { withTransactions }) {
  const url = new URL(`${access.base}/accounts`);
  if (withTransactions) {
    url.searchParams.set('start-date', String(Math.floor(Date.now() / 1000) - WINDOW_DAYS * 86_400));
    url.searchParams.set('end-date', String(Math.floor(Date.now() / 1000) + 86_400));
  } else {
    url.searchParams.set('balances-only', '1');
  }
  const res = await safeFetch(url.href, { headers: { Authorization: authHeader(access), Accept: 'application/json' }, maxRedirects: 2, sameOriginOnly: true });
  if (res.status === 401 || res.status === 403) {
    throw fail(400, 'The bridge refused access. The connection may have been disabled there; create a new setup token and connect again.', 'forbidden');
  }
  if (res.status === 402) throw fail(400, 'The bridge says the subscription behind this connection needs attention.', 'payment_required');
  if (res.status === 429) throw fail(400, 'The bridge says too many requests were made today. HomeVault will try again later.', 'rate_limited');
  if (res.status < 200 || res.status >= 300) throw fail(502, `The bridge answered HTTP ${res.status}.`, 'http_error');
  let json;
  try {
    json = JSON.parse(res.text);
  } catch {
    throw fail(502, 'The bridge did not answer with data.', 'bad_response');
  }
  return parseAccounts(json);
}
