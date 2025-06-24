/**
 * Authentication Middleware
 * Provides middleware factory functions for authentication/authorization
 */
import authService from "../../services/AuthService.js";
import logger from "../../utils/logger.js";

/**
 * Track token verification failures for rate limiting/monitoring
 */
const authStats = {
  verificationFailures: 0,
  totalRequests: 0
};

/**
 * Creates middleware that extracts user from token but doesn't enforce authentication
 * This is a drop-in replacement for the current global hook
 * @returns {Function} Fastify middleware function
 */
export function authenticateUser() {
  return async (request) => {
    authStats.totalRequests++;
    request.user = null;
    const authHeader = request.headers.authorization;
    
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const idToken = authHeader.split("Bearer ")[1];
      try {
        // Verify token asynchronously
        request.user = await authService.verifyToken(idToken);
        
        if (request.user) {
          logger.debug(`Authenticated user: ${request.user.uid}`);
        }
      } catch (error) {
        authStats.verificationFailures++;
        logger.warn(`Token verification failed in authenticateUser: ${error.message}`);
        // Still continue processing the request with request.user as null
      }
    } else {
      logger.debug("No auth token provided, proceeding as anonymous.");
    }
  };
}

/**
 * Creates middleware that requires a valid authenticated user
 * @returns {Function} Fastify middleware function
 */
export function requireAuth() {
  return async (request) => {
    authStats.totalRequests++;
    request.user = null;
    const authHeader = request.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      logger.debug("Authentication required but no token provided");
      const err = new Error("You must provide a valid authentication token");
      err.name = "AuthenticationError";
      err.statusCode = 401;
      throw err;
    }
    
    const idToken = authHeader.split("Bearer ")[1];
    try {
      request.user = await authService.verifyToken(idToken);
      
      if (!request.user) {
        logger.debug("Authentication failed - token verification returned null");
        const err = new Error("Invalid or expired authentication token");
        err.name = "AuthenticationError";
        err.statusCode = 401;
        throw err;
      }
      
      logger.debug(`Authenticated required route for user: ${request.user.uid}`);
    } catch (error) {
      authStats.verificationFailures++;
      logger.warn(`Token verification failed in requireAuth: ${error.message}`);
      const err = new Error("Token verification failed: " + error.message);
      err.name = "AuthenticationError";
      err.statusCode = 401;
      throw err;
    }
  };
}

/**
 * Creates middleware that requires user to have specific role(s)
 * @param {string|string[]} roles - Required role or array of roles (any match = success)
 * @returns {Function} Fastify middleware function
 */
export function requireRole(roles) {
  return async (request, reply) => {
    // First ensure user is authenticated
    const authMiddleware = requireAuth();
    await authMiddleware(request, reply);
    
    // If authentication failed, it will have thrown, so we arrive here only if authorized.
    
    // Then check roles
    const hasRequiredRole = authService.hasRole(request.user, roles);
    
    if (!hasRequiredRole) {
      logger.debug(`Authorization failed - user lacks required role(s): ${roles}`);
      const err = new Error("You don't have permission to access this resource");
      err.name = "ForbiddenError";
      err.statusCode = 403;
      throw err;
    }
    
    logger.debug(`Authorized user ${request.user.uid} with role(s): ${roles}`);
  };
}

/**
 * Get authentication statistics
 * @returns {Object} Current auth stats
 */
export function getAuthStats() {
  return {
    ...authStats,
    failureRate: authStats.totalRequests > 0 
      ? (authStats.verificationFailures / authStats.totalRequests) 
      : 0
  };
}

// Export default object for convenience
export default {
  authenticateUser,
  requireAuth,
  requireRole,
  getAuthStats
}; 