/**
 * Firestore Cache Service
 * Provides a caching layer using Firestore for storing and retrieving protobuf data
 */
import admin from "firebase-admin";
import crypto from "crypto";
import logger from "../utils/logger.js";
import { promisify } from "util";
import zlib from "zlib";

// Promisify zlib functions
const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);

class FirestoreCacheService {
  constructor() {
    // Don't initialize Firestore immediately - wait until first use
    this._db = null;
    this._collection = null;
    this.enabled = process.env.FIRESTORE_CACHE_ENABLED !== "false";
    this.ttlSeconds = parseInt(process.env.FIRESTORE_CACHE_TTL || "3600", 10); // Default 1 hour
    this.useCompression = true; // Enable compression by default
    this.initialized = false;
    
    logger.info(`FirestoreCacheService created (enabled: ${this.enabled}, TTL: ${this.ttlSeconds}s, compression: ${this.useCompression})`);
  }

  /**
   * Lazily initialize Firestore connection when first needed
   * @returns {boolean} Whether initialization was successful
   */
  initialize() {
    try {
      if (this.initialized) {return true;}

      // Check if Firebase Admin is initialized
      try {
        this._db = admin.firestore();
        this._collection = this._db.collection("microservice-cache");
        this.initialized = true;
        logger.info("FirestoreCacheService successfully initialized Firestore connection");
        return true;
      } catch (error) {
        logger.error(`Failed to initialize Firestore: ${error.message}`);
        // If Firebase isn't initialized, we'll disable caching
        this.enabled = false;
        return false;
      }
    } catch (error) {
      logger.error(`Unexpected error initializing FirestoreCacheService: ${error.message}`);
      this.enabled = false;
      return false;
    }
  }

  /**
   * Get the Firestore collection, initializing if needed
   * @returns {FirebaseFirestore.CollectionReference|null} Firestore collection or null if unavailable
   */
  get collection() {
    if (!this.enabled) {return null;}
    if (!this.initialized) {this.initialize();}
    return this._collection;
  }

  /**
   * Get the Firestore database instance, initializing if needed
   * @returns {FirebaseFirestore.Firestore|null} Firestore instance or null if unavailable
   */
  get db() {
    if (!this.enabled) {return null;}
    if (!this.initialized) {this.initialize();}
    return this._db;
  }

  /**
   * Checks if caching is enabled
   * @returns {boolean} Whether caching is enabled
   */
  isEnabled() {
    return this.enabled && this.initialize();
  }

  /**
   * Compress data for storage
   * @param {object|string} data - Data to compress
   * @returns {Promise<Buffer>} Compressed data as Buffer
   */
  async compressData(data) {
    try {
      if (!data) {return null;}
      
      // Convert object to string if needed
      const dataString = typeof data === "object" ? JSON.stringify(data) : String(data);
      
      // Compress data using gzip
      return await gzipAsync(Buffer.from(dataString, "utf8"));
    } catch (error) {
      logger.error(`Error compressing data: ${error.message}`);
      throw error;
    }
  }

  /**
   * Decompress data from storage
   * @param {Buffer} compressedData - Compressed data
   * @returns {Promise<object|string>} Decompressed data
   */
  async decompressData(compressedData) {
    try {
      if (!compressedData) {return null;}
      
      // Decompress data
      const decompressedBuffer = await gunzipAsync(compressedData);
      const dataString = decompressedBuffer.toString("utf8");
      
      // Try to parse as JSON, fall back to string if not valid JSON
      try {
        return JSON.parse(dataString);
      } catch {
        return dataString;
      }
    } catch (error) {
      logger.error(`Error decompressing data: ${error.message}`);
      throw error;
    }
  }

  /**
   * Generate hash of data
   * @param {object|string} data - Data to hash
   * @returns {string} SHA-256 hash of the data
   */
  calculateHash(data) {
    if (!data) {return "";}
    
    // Convert object to string if needed
    const dataString = typeof data === "object" ? JSON.stringify(data) : String(data);
    
    return crypto.createHash("sha256").update(dataString).digest("hex");
  }

  /**
   * Get cached data for a user
   * @param {string} userId - User ID
   * @param {string} cacheKey - Cache key (e.g., endpoint or request identifier)
   * @returns {Promise<{data: object, hash: string, timestamp: Date}|null>} Cached data or null if not found/expired
   */
  async get(userId, cacheKey) {
    if (!this.isEnabled()) {return null;}
    
    try {
      const docId = `${userId}:${cacheKey}`;
      const docRef = this.collection.doc(docId);
      const doc = await docRef.get();
      
      if (!doc.exists) {
        logger.debug(`Cache miss for ${docId}`);
        return null;
      }

      const data = doc.data();
      const now = Date.now();
      const expiresAt = data.expiresAt?.toMillis() || 0;
      
      // Check if cached data is expired
      if (expiresAt < now) {
        logger.debug(`Cache expired for ${docId}`);
        // Optionally delete expired data
        docRef.delete().catch(err => logger.warn(`Failed to delete expired cache: ${err.message}`));
        return null;
      }

      logger.debug(`Cache hit for ${docId}`);
      
      // Get the compressed data (stored as Firestore Blob)
      const compressedData = data.compressedData;
      
      // Decompress the data if it exists
      let decompressedData = null;
      if (compressedData) {
        // Handle data based on how it was stored (Base64 string)
        const buffer = Buffer.from(compressedData, "base64");
        decompressedData = await this.decompressData(buffer);
      }
      
      return {
        data: decompressedData,
        hash: data.hash,
        timestamp: data.timestamp.toDate()
      };
    } catch (error) {
      logger.error(`Error getting cache for ${userId}:${cacheKey}: ${error.message}`);
      return null;
    }
  }

  /**
   * Store data in cache
   * @param {string} userId - User ID
   * @param {string} cacheKey - Cache key (e.g., endpoint or request identifier)
   * @param {object|string} data - Data to cache
   * @param {number} [customTtl] - Optional custom TTL in seconds
   * @returns {Promise<boolean>} Whether the operation was successful
   */
  async set(userId, cacheKey, data, customTtl) {
    if (!this.isEnabled() || !data) {return false;}
    
    try {
      const docId = `${userId}:${cacheKey}`;
      
      // Calculate hash from original data for comparison
      const hash = this.calculateHash(data);
      
      // Compress the data
      const compressedData = await this.compressData(data);
      
      const now = admin.firestore.Timestamp.now();
      const ttl = customTtl || this.ttlSeconds;
      const expiresAt = new admin.firestore.Timestamp(
        now.seconds + ttl,
        now.nanoseconds
      );

      // Store compressed data as base64 string instead of using Blob
      // This avoids issues with admin.firestore.Blob potentially being undefined
      const base64Data = compressedData.toString("base64");
      
      await this.collection.doc(docId).set({
        userId,
        cacheKey,
        compressedData: base64Data,
        hash,
        timestamp: now,
        expiresAt,
        ttlSeconds: ttl,
        compressionEnabled: true
      });

      logger.debug(`Cache set for ${docId}, expires in ${ttl}s, compressed size: ${compressedData.length} bytes`);
      return true;
    } catch (error) {
      logger.error(`Error setting cache for ${userId}:${cacheKey}: ${error.message}`);
      return false;
    }
  }

  /**
   * Update cache in background after comparing hashes
   * @param {string} userId - User ID
   * @param {string} cacheKey - Cache key
   * @param {object|string} data - New data
   * @param {string} currentHash - Current hash to compare against
   * @returns {Promise<boolean>} Whether an update was performed
   */
  async updateIfChanged(userId, cacheKey, data, currentHash) {
    if (!this.isEnabled() || !data) {return false;}

    try {
      const newHash = this.calculateHash(data);
      
      // If hashes match, no need to update
      if (newHash === currentHash) {
        logger.debug(`Cache data unchanged for ${userId}:${cacheKey}, skipping update`);
        return false;
      }
      
      // Hashes differ, update the cache
      await this.set(userId, cacheKey, data);
      logger.debug(`Updated cache for ${userId}:${cacheKey} due to data change`);
      return true;
    } catch (error) {
      logger.error(`Error updating cache for ${userId}:${cacheKey}: ${error.message}`);
      return false;
    }
  }

  /**
   * Invalidate cache entry
   * @param {string} userId - User ID
   * @param {string} cacheKey - Cache key
   * @returns {Promise<boolean>} Whether the operation was successful
   */
  async invalidate(userId, cacheKey) {
    if (!this.isEnabled()) {return false;}
    
    try {
      const docId = `${userId}:${cacheKey}`;
      await this.collection.doc(docId).delete();
      logger.debug(`Cache invalidated for ${docId}`);
      return true;
    } catch (error) {
      logger.error(`Error invalidating cache for ${userId}:${cacheKey}: ${error.message}`);
      return false;
    }
  }

  /**
   * Clear all cache for a user
   * @param {string} userId - User ID
   * @returns {Promise<number>} Number of deleted entries
   */
  async clearUserCache(userId) {
    if (!this.isEnabled()) {return 0;}
    
    try {
      const batch = this.db.batch();
      const snapshot = await this.collection.where("userId", "==", userId).get();
      
      if (snapshot.empty) {
        return 0;
      }
      
      snapshot.docs.forEach(doc => {
        batch.delete(doc.ref);
      });
      
      await batch.commit();
      logger.info(`Cleared ${snapshot.size} cache entries for user ${userId}`);
      return snapshot.size;
    } catch (error) {
      logger.error(`Error clearing cache for user ${userId}: ${error.message}`);
      return 0;
    }
  }
}

// Create singleton instance
const firestoreCacheService = new FirestoreCacheService();
export default firestoreCacheService; 