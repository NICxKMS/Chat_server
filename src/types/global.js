/**
 * @fileoverview Global type declarations for JavaScript modules
 * JavaScript version of global.d.ts with JSDoc annotations
 */

/**
 * Provider Factory module types
 * 
 * @namespace ProviderFactory
 * @property {function(string|null=):BaseProvider} getProvider - Get provider by name
 * @property {function():BaseProvider} getDefaultProvider - Get default provider
 * @property {function():BaseProvider[]} getAllProviders - Get all available providers
 * @property {function():string[]} getProviderNames - Get names of all available providers
 * @property {function():Promise<Object.<string, Object>>} getAllModels - Get all available models
 * @property {function():Promise<Object[]>} getProvidersInfo - Get info for all providers
 */

/**
 * Middleware module types
 * 
 * @namespace Middleware
 * @property {function} errorHandler - Express error handler middleware
 * @property {function} rateLimiter - Express rate limiting middleware
 */

/**
 * Model categorizer utility types
 * 
 * @namespace ModelCategorizer
 * @property {function(Object.<string, Object>, boolean=):Object} categorizeModels - Categorize models into structured hierarchy
 */

/**
 * Circuit breaker utility types
 * 
 * @namespace CircuitBreaker
 * @property {function(string, function, Object=):Object} createBreaker - Create a new circuit breaker
 * @property {function():Object.<string, Object>} getCircuitBreakerStates - Get states of all circuit breakers
 */

/**
 * Cache utility types
 * 
 * @namespace Cache
 * @property {function():boolean} isEnabled - Check if cache is enabled
 * @property {function(string):Promise<*>} get - Get value from cache
 * @property {function(string, *, number=):Promise<void>} set - Set value in cache
 * @property {function(Object):string} generateKey - Generate cache key from data
 * @property {function():Object} getStats - Get cache statistics
 */

/**
 * Metrics utility types
 * 
 * @namespace Metrics
 * @property {function():void} incrementRequestCount - Increment request counter
 * @property {Object} providerRequestCounter - Provider request counter
 * @property {function(Object.<string, string>):void} providerRequestCounter.inc - Increment provider request counter
 */

// Export empty object as this is just for JSDoc type definitions
module.exports = {}; 