/**
 * @fileoverview Provider type declarations for JavaScript
 * JavaScript version of provider.d.ts with JSDoc annotations
 */

/**
 * Extended BaseProvider that exposes protected members
 * 
 * @typedef {Object} ExtendedBaseProvider
 * @property {Object} config - Provider configuration
 * @property {number} [config.timeout] - Timeout in milliseconds
 * @property {string} [config.defaultModel] - Default model identifier
 */

/**
 * Utility types for cache module
 * 
 * @namespace CacheUtils
 * @property {function(any):string} generateKey - Generate a cache key from data
 */

/**
 * Types for Anthropic SDK
 * 
 * @namespace AnthropicSDK
 * @typedef {Object} CustomContentBlock
 * @property {string} type - Content type
 * @property {string} text - Content text
 */

// Export empty object as this is just for JSDoc type definitions
module.exports = {}; 