class SlidingWindowRateLimiter {
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.store = new Map();
  }

  consume(key) {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const entries = this.store.get(key) || [];
    const freshEntries = entries.filter((timestamp) => timestamp > windowStart);

    if (freshEntries.length >= this.max) {
      this.store.set(key, freshEntries);
      return {
        allowed: false,
        retryAfterMs: Math.max(0, this.windowMs - (now - freshEntries[0])),
        remaining: 0,
      };
    }

    freshEntries.push(now);
    this.store.set(key, freshEntries);

    return {
      allowed: true,
      retryAfterMs: 0,
      remaining: Math.max(0, this.max - freshEntries.length),
    };
  }

  prune() {
    const cutoff = Date.now() - this.windowMs;

    for (const [key, entries] of this.store.entries()) {
      const freshEntries = entries.filter((timestamp) => timestamp > cutoff);

      if (freshEntries.length === 0) {
        this.store.delete(key);
        continue;
      }

      this.store.set(key, freshEntries);
    }
  }
}

module.exports = { SlidingWindowRateLimiter };
