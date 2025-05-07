/**
 * Model Controller Cache Integration
 * Provides caching for model classification data from the microservice
 */
import firestoreCacheService from "../services/FirestoreCacheService.js";
import logger from "../utils/logger.js";

// Track background tasks for debugging
let backgroundTasksInProgress = 0;

/**
 * Perform a cache operation in the background
 * @param {Function} operation - Async function to execute
 * @param {string} operationName - Name of operation for logging
 */
function runInBackground(operation, operationName) {
  // Use setTimeout to ensure operation runs in next event loop tick
  setTimeout(async () => {
    backgroundTasksInProgress++;
    try {
      await operation();
    } catch (error) {
      logger.error(`Background ${operationName} error: ${error.message}`, { 
        stack: error.stack,
        operation: operationName
      });
    } finally {
      backgroundTasksInProgress--;
      logger.debug(`Background tasks in progress: ${backgroundTasksInProgress}`);
    }
  }, 0);
}

/**
 * Wrapper function for the ModelController.getClassifiedModels method
 * Implements the caching logic described in the requirements
 * 
 * @param {Function} originalMethod - The original getClassifiedModels method
 * @param {object} modelController - The ModelController instance
 * @returns {Function} Wrapped method with caching
 */
export function withCache(originalMethod, modelController) {
  return async function wrappedGetClassifiedModels(request, reply) {
    // Get user ID for cache key - use anonymous for unauthenticated users
    const userId = request.user?.uid || "anonymous";
    const cacheKey = "classified-models"; // Single data type/format as specified
    
    // Check if Firestore caching is enabled
    if (!firestoreCacheService.isEnabled()) {
      logger.debug("Firestore cache disabled, calling original method directly");
      return originalMethod.call(modelController, request, reply);
    }

    try {
      // Step 1: Check if data exists in cache
      const cachedData = await firestoreCacheService.get(userId, cacheKey);
      
      if (cachedData && cachedData.data) {
        logger.info(`Using cached model classification data for user ${userId}`);
        
        // Send cached data to client IMMEDIATELY
        
        // AFTER sending response, start background refresh without blocking
        runInBackground(async () => {
          // Call the original method but capture the response instead of sending
          const mockReply = {
            sent: false,
            send: function(payload) {
              this.payload = payload;
              return this;
            }
          };
          
          await originalMethod.call(modelController, request, mockReply);
          
          // If the original method sent a response, compare and update cache
          if (mockReply.payload) {
            await firestoreCacheService.updateIfChanged(
              userId, 
              cacheKey, 
              mockReply.payload, 
              cachedData.hash
            );
          }
        }, "refresh-cache");
        
        return reply.send(cachedData.data);

      }
      
      // No cache found, call original method
      logger.debug(`No cache found for ${userId}:${cacheKey}, calling microservice`);
      
      // Create a proxy for reply.send to intercept the data
      const originalSend = reply.send;
      reply.send = function(payload) {
        // Reset the send method
        reply.send = originalSend;
        
        // Call the original send method FIRST - send response to client immediately
        const result = originalSend.call(this, payload);
        
        // AFTER sending response, cache the data in background
        if (payload) {
          runInBackground(async () => {
            await firestoreCacheService.set(userId, cacheKey, payload);
          }, "set-cache");
        }
        
        return result;
      };
      
      // Call the original method with the modified reply
      return originalMethod.call(modelController, request, reply);
      
    } catch (error) {
      logger.error(`Cache integration error: ${error.message}`, { stack: error.stack });
      // Fallback to original method if there's a caching error
      return originalMethod.call(modelController, request, reply);
    }
  };
}

/**
 * Apply caching to a ModelController instance
 * @param {object} controller - The ModelController instance
 * @returns {object} The same controller instance with caching applied
 */
export function applyCaching(controller) {
  // Store reference to original method
  const originalGetClassifiedModels = controller.getClassifiedModels;
  
  // Replace with cached version
  controller.getClassifiedModels = withCache(originalGetClassifiedModels, controller);
  
  logger.info("Applied Firestore caching to ModelController.getClassifiedModels");
  return controller;
}

export default {
  withCache,
  applyCaching
}; 