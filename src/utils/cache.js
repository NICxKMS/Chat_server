/**
 * @file In-memory Cache Utility
 * @description Provides a simple and efficient caching mechanism.
 * @version 2.0.0
 */

import crypto from "crypto";
import logger from "./logger.js";

const cacheStore = new Map();
const stats = {
  hits: 0,
  misses: 0,
  size: 0,
};

/**
 * Generates a stable and efficient cache key from various inputs.
 * @param {string|object} keyOrData - A string or object to be used for key generation.
 * @returns {string} The generated cache key.
 */
function generateKey(keyOrData) {
  if (typeof keyOrData !== "object" || keyOrData === null) {
    return String(keyOrData);
  }

  try {
    const dataToHash = { ...keyOrData };
    if (Array.isArray(dataToHash.messages)) {
      const relevantMessages = dataToHash.messages.slice(-10);
      dataToHash.messages = relevantMessages.map(
        (m) =>
          `${m.role}:${
            typeof m.content === "string"
              ? m.content
              : JSON.stringify(m.content)
          }`
      );
    }

    const sortedKeys = Object.keys(dataToHash).sort();
    const finalObject = {};
    for (const key of sortedKeys) {
      finalObject[key] = dataToHash[key];
    }

    const finalString = JSON.stringify(finalObject);
    const hash = crypto.createHash("sha256").update(finalString).digest("hex");
    return `sha256-${hash}`;
  } catch (e) {
    logger.error("Error generating cache key:", e);
    return "cache-key-error";
  }
}

/**
 * Retrieves a value from the cache.
 * @param {string} key - The cache key.
 * @returns {any|null} The cached value or null if not found or expired.
 */
function get(key) {
  const cacheItem = cacheStore.get(key);
  if (!cacheItem || cacheItem.expiry < Date.now()) {
    if (cacheItem) cacheStore.delete(key);
    stats.misses++;
    return null;
  }
  stats.hits++;
  return cacheItem.value;
}

/**
 * Stores a value in the cache.
 * @param {string} key - The cache key.
 * @param {any} value - The value to store.
 * @param {number} ttlSeconds - The time-to-live in seconds.
 */
function set(key, value, ttlSeconds = 60) {
  if (key === null || key === undefined) {
    logger.warn("Attempted to set cache with a null or undefined key.");
    return;
  }
  const expiry = Date.now() + ttlSeconds * 1000;
  cacheStore.set(key, { value, expiry });
  stats.size = cacheStore.size;
}

/**
 * Retrieves a value from the cache, or computes and stores it if not present.
 * @param {string} key - The cache key.
 * @param {Function} factory - A function to compute the value if it's not in the cache.
 * @param {number} ttlSeconds - The time-to-live in seconds.
 * @returns {Promise<any>} The cached or computed value.
 */
async function getOrSet(key, factory, ttlSeconds = 60) {
  const cachedValue = get(key);
  if (cachedValue !== null) {
    return cachedValue;
  }
  const computedValue = await factory();
  if (computedValue !== null && computedValue !== undefined) {
    set(key, computedValue, ttlSeconds);
  }
  return computedValue;
}

/**
 * Checks if the cache is enabled via environment variables.
 * @returns {boolean} True if the cache is enabled, otherwise false.
 */
function isEnabled() {
  return process.env.CACHE_ENABLED !== "false";
}

/**
 * Invalidates a specific cache entry.
 * @param {string} key - The cache key to invalidate.
 */
function invalidate(key) {
  cacheStore.delete(key);
  stats.size = cacheStore.size;
}

/**
 * Clears the entire cache.
 */
function clear() {
  cacheStore.clear();
  stats.size = 0;
}

/**
 * Retrieves the current cache statistics.
 * @returns {object} An object containing cache statistics.
 */
function getStats() {
  const total = stats.hits + stats.misses;
  return {
    ...stats,
    hitRate: total > 0 ? stats.hits / total : 0,
  };
}

// Periodic cleanup of expired cache items.
const CACHE_SWEEP_INTERVAL_MS =
  parseInt(process.env.CACHE_SWEEP_INTERVAL_MS, 10) || 300000;

setInterval(() => {
  const now = Date.now();
  for (const [key, item] of cacheStore.entries()) {
    if (item.expiry < now) {
      cacheStore.delete(key);
    }
  }
  stats.size = cacheStore.size;
}, CACHE_SWEEP_INTERVAL_MS).unref();

export { get, set, getOrSet, invalidate, clear, generateKey, getStats, isEnabled };
