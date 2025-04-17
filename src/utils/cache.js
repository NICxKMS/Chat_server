/**
 * In-memory Cache Utility
 * Provides a simple caching mechanism for expensive operations
 */
import crypto from "crypto"; // Import the crypto module

// In-memory cache store
const cacheStore = new Map();

// Cache statistics
const stats = {
  hits: 0,
  misses: 0,
  size: 0
};

/**
 * Generate a cache key based on the provided parameters.
 * Uses SHA-256 hashing for object inputs to create shorter, consistent keys.
 * Sorts object keys before stringifying to ensure stability.
 * 
 * @param {string|object} keyOrData - Base key string or object to use as key data.
 * @param {...any} args - Additional primitive arguments to include in the key (objects not recommended here).
 * @returns {string} Generated cache key (SHA-256 hash for objects, or composite string for primitives).
 */
function generateKey(keyOrData, ...args) {
  let baseString;

  // If keyOrData is an object, create a stable, sorted JSON string.
  if (typeof keyOrData === "object" && keyOrData !== null) {
    try {
      // Stringify with sorted keys for consistency
      baseString = JSON.stringify(keyOrData, Object.keys(keyOrData).sort());
    } catch (e) {
      console.error("Error stringifying object for cache key:", e);
      baseString = "cache-key-stringify-error"; // Fallback string
    }
    // Create SHA-256 hash of the stable string
    const hash = crypto.createHash("sha256");
    hash.update(baseString);
    // Prepend a prefix to indicate it's a hash-based key
    return `sha256-${hash.digest("hex")}`;
  } else {
    // If keyOrData is already a string or primitive, use it directly
    baseString = String(keyOrData); 
  }

  // Handle additional primitive arguments (append to string keys only)
  if (args.length > 0) {
    const argString = args
      .map(arg => {
        if (arg === null) {return "null";}
        if (arg === undefined) {return "undefined";}
        // Avoid complex objects in args for string keys
        if (typeof arg === "object") {return JSON.stringify(arg);} 
        return String(arg);
      })
      .join("-");
    return `${baseString}-${argString}`;
  } else {
    // Return the base string key if no extra args
    return baseString;
  }
}

/**
 * Get a value from the cache
 * 
 * @param {string} key - Cache key
 * @param {string} category - Optional category for metrics
 * @returns {Promise<any|null>} Cached value or null if not found
 */
async function get(key, category = "general") {
  const cacheItem = cacheStore.get(key);
  
  if (!cacheItem) {
    stats.misses++;
    return null;
  }
  
  // Check if expired
  if (cacheItem.expiry < Date.now()) {
    cacheStore.delete(key);
    stats.misses++;
    return null;
  }
  
  stats.hits++;
  return cacheItem.value;
}

/**
 * Set a value in the cache
 * 
 * @param {string} key - Cache key
 * @param {any} value - Value to cache
 * @param {number} ttlSeconds - Time to live in seconds
 * @param {string} category - Optional category for metrics
 * @returns {Promise<void>}
 */
async function set(key, value, ttlSeconds = 60, category = "general") {
  // Guard against null or undefined keys
  if (key === null || key === undefined) {
    throw new Error("Cache key cannot be null or undefined");
  }
  
  const expiry = Date.now() + (ttlSeconds * 1000);
  
  cacheStore.set(key, {
    value,
    expiry,
    category
  });
  
  stats.size = cacheStore.size;
}

/**
 * Invalidate a specific cache entry
 * 
 * @param {string} key - Cache key to invalidate
 * @returns {boolean} Whether the key was found and invalidated
 */
function invalidate(key) {
  if (!key) {
    return false;
  }
  
  const result = cacheStore.delete(key);
  stats.size = cacheStore.size;
  return result;
}

/**
 * Clear all cache entries or entries of a specific category
 * 
 * @param {string|null} category - Optional category to clear
 * @returns {number} Number of entries cleared
 */
function clear(category = null) {
  let count = 0;
  
  if (category) {
    // Clear only entries of the specified category
    for (const [key, item] of cacheStore.entries()) {
      if (item.category === category) {
        cacheStore.delete(key);
        count++;
      }
    }
  } else {
    // Clear all entries
    count = cacheStore.size;
    cacheStore.clear();
  }
  
  stats.size = cacheStore.size;
  return count;
}

/**
 * Get cache statistics
 * 
 * @returns {object} Cache statistics
 */
function getStats() {
  const totalRequests = stats.hits + stats.misses;
  return {
    ...stats,
    categories: getCategoryStats(),
    hitRate: totalRequests > 0 ? (stats.hits / totalRequests) : 0
  };
}

/**
 * Get statistics by category
 * 
 * @returns {object} Category statistics
 */
function getCategoryStats() {
  const categories = {};
  
  for (const item of cacheStore.values()) {
    const category = item.category || "general";
    
    if (!categories[category]) {
      categories[category] = 0;
    }
    
    categories[category]++;
  }
  
  return categories;
}

/**
 * Check if cache is enabled
 * 
 * @returns {boolean} Whether cache is enabled
 */
function isEnabled() {
  return process.env.CACHE_ENABLED !== "false";
}

// Export the cache methods
export {
  get,
  set,
  invalidate,
  clear,
  generateKey,
  getStats,
  isEnabled
}; 