export function createRateLimiter({ maximum, windowMs, now = Date.now }) {
  const requests = new Map();
  return Object.freeze({
    consume(identity) {
      const timestamp = now();
      const cutoff = timestamp - windowMs;
      const recent = (requests.get(identity) || []).filter((item) => item > cutoff);
      if (recent.length >= maximum) {
        requests.set(identity, recent);
        return Object.freeze({ allowed: false, remaining: 0, retryAfterMs: Math.max(1, recent[0] + windowMs - timestamp) });
      }
      recent.push(timestamp);
      requests.set(identity, recent);
      return Object.freeze({ allowed: true, remaining: maximum - recent.length, retryAfterMs: 0 });
    }
  });
}

export function createConcurrencyLimiter({ maximum }) {
  let active = 0;
  return Object.freeze({
    tryAcquire() {
      if (active >= maximum) return null;
      active += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active = Math.max(0, active - 1);
      };
    },
    activeCount() {
      return active;
    }
  });
}
