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
  return async (request, reply) => {
    authStats.totalRequests++;
    request.user = null;
    const authHeader = request.headers.authorization;
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const idToken = authHeader.split('Bearer ')[1];
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
      logger.debug('No auth token provided, proceeding as anonymous.');
    }
  };
}

/**
 * Creates middleware that requires a valid authenticated user
 * @returns {Function} Fastify middleware function
 */
export function requireAuth() {
  return async (request, reply) => {
    authStats.totalRequests++;
    request.user = null;
    const authHeader = request.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logger.debug('Authentication required but no token provided');
      reply.status(401).send({ 
        error: "Authentication required", 
        message: "You must provide a valid authentication token" 
      });
      return reply;
    }
    
    const idToken = authHeader.split('Bearer ')[1];
    try {
      request.user = await authService.verifyToken(idToken);
      
      if (!request.user) {
        logger.debug('Authentication failed - token verification returned null');
        reply.status(401).send({ 
          error: "Authentication failed", 
          message: "Invalid or expired authentication token" 
        });
        return reply;
      }
      
      logger.debug(`Authenticated required route for user: ${request.user.uid}`);
    } catch (error) {
      authStats.verificationFailures++;
      logger.warn(`Token verification failed in requireAuth: ${error.message}`);
      reply.status(401).send({
        error: "Authentication failed",
        message: "Token verification failed: " + error.message
      });
      return reply;
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
    
    // If authentication failed and reply was already sent, exit
    if (reply.sent) return reply;
    
    // Then check roles
    const hasRequiredRole = authService.hasRole(request.user, roles);
    
    if (!hasRequiredRole) {
      logger.debug(`Authorization failed - user lacks required role(s): ${roles}`);
      reply.status(403).send({ 
        error: "Unauthorized", 
        message: "You don't have permission to access this resource" 
      });
      return reply;
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