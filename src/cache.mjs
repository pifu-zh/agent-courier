export class BoundedCache {
  constructor({ maxEntries = 10_000, now = () => Date.now() } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error('maxEntries must be a positive integer');
    }
    this.maxEntries = maxEntries;
    this.now = now;
    this.values = new Map();
  }

  key(key, options) {
    const raw = String(key);
    return options?.namespace ? `${options.namespace}/${raw}` : raw;
  }

  async get(key, options) {
    const cacheKey = this.key(key, options);
    const entry = this.values.get(cacheKey);
    if (!entry) return undefined;
    if (entry.expire && entry.expire <= this.now()) {
      this.values.delete(cacheKey);
      return undefined;
    }
    this.values.delete(cacheKey);
    this.values.set(cacheKey, entry);
    return entry.value;
  }

  async set(key, value, expire, options) {
    const cacheKey = this.key(key, options);
    this.values.delete(cacheKey);
    this.values.set(cacheKey, {
      value,
      expire: typeof expire === 'number' ? expire : 0,
    });
    while (this.values.size > this.maxEntries) {
      const oldest = this.values.keys().next().value;
      if (oldest === undefined) break;
      this.values.delete(oldest);
    }
    return true;
  }

  sweep() {
    const now = this.now();
    for (const [key, entry] of this.values) {
      if (entry.expire && entry.expire <= now) this.values.delete(key);
    }
  }

  get size() {
    return this.values.size;
  }
}
