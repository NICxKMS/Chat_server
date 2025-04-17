/**
 * Authentication Service
 * Handles Firebase authentication and user management
 */
import admin from "firebase-admin";
import logger from "../utils/logger.js";

class AuthService {
  constructor() {
    // Initialization code (if needed)
    logger.info("AuthService initialized");
  }

  /**
   * Verify a Firebase ID token
   * @param {string} token - Firebase ID token to verify
   * @returns {Promise<object|null>} User data if token is valid, null otherwise
   */
  async verifyToken(token) {
    try {
      if (!token) return null;
      
      const decodedToken = await admin.auth().verifyIdToken(token);
      
      return {
        uid: decodedToken.uid,
        email: decodedToken.email,
        emailVerified: decodedToken.email_verified,
        displayName: decodedToken.name,
        photoURL: decodedToken.picture,
        roles: decodedToken.roles || [],
        claims: decodedToken.claims || {},
        // Include any other needed properties
      };
    } catch (error) {
      logger.warn(`Token verification failed: ${error.message}`, { code: error.code });
      return null;
    }
  }

  /**
   * Set custom claims for a user
   * @param {string} uid - User ID
   * @param {object} claims - Custom claims to set
   * @returns {Promise<void>}
   */
  async setUserClaims(uid, claims) {
    try {
      return admin.auth().setCustomUserClaims(uid, claims);
    } catch (error) {
      logger.error(`Failed to set custom claims for user ${uid}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get a user record by UID
   * @param {string} uid - User ID
   * @returns {Promise<object>} User record
   */
  async getUserRecord(uid) {
    try {
      return admin.auth().getUser(uid);
    } catch (error) {
      logger.error(`Failed to get user record for ${uid}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Check if the user has the specified role
   * @param {object} user - User object with roles property
   * @param {string|string[]} requiredRoles - Required role(s)
   * @returns {boolean} Whether the user has any of the required roles
   */
  hasRole(user, requiredRoles) {
    if (!user || !user.roles) return false;
    
    const userRoles = user.roles;
    
    if (Array.isArray(requiredRoles)) {
      return requiredRoles.some(role => userRoles.includes(role));
    }
    
    return userRoles.includes(requiredRoles);
  }
}

// Create singleton instance
const authService = new AuthService();
export default authService; 