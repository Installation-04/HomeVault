// In-memory sliding-window counter for failed attempts, keyed by something
// like an email address. HomeVault runs as a single process, so memory is the
// right store: it resets on restart (which is fine for a brute-force guard)
// and needs no extra table.
//
// This complements the per-IP express-rate-limit: that stops one machine
// hammering many accounts, this stops many machines hammering one account.

export class FailureThrottle {
  constructor({ limit, windowMs, maxKeys = 10_000 }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
    this.hits = new Map(); // key -> number[] of timestamps
  }

  #prune(key, now) {
    const list = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  // { blocked: boolean, retryAfterSeconds: number }
  check(key, now = Date.now()) {
    const list = this.#prune(key, now);
    if (list.length < this.limit) return { blocked: false, retryAfterSeconds: 0 };
    const oldestRelevant = list[list.length - this.limit];
    return { blocked: true, retryAfterSeconds: Math.max(1, Math.ceil((oldestRelevant + this.windowMs - now) / 1000)) };
  }

  fail(key, now = Date.now()) {
    if (!this.hits.has(key) && this.hits.size >= this.maxKeys) {
      // Evict the oldest-inserted key so a flood of random emails can't grow memory without bound.
      this.hits.delete(this.hits.keys().next().value);
    }
    const list = this.#prune(key, now);
    list.push(now);
    this.hits.set(key, list);
  }

  reset(key) {
    this.hits.delete(key);
  }
}
