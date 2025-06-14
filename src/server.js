/**
 * Main server entry point
 * Sets up Fastify server with configured routes and middleware
 */
import dotenv from "dotenv";
import Fastify from "fastify";
import { promises as fsPromises } from "node:fs"; // Use promises API

import mainApiRoutes from "./routes/index.js"; // Main plugin
import cors from '@fastify/cors';
import compress from '@fastify/compress';
import helmet from '@fastify/helmet';

import fastifyErrorHandler from "./middleware/errorHandler.js"; // Added error handler import
import rateLimiterHook from "./middleware/rateLimiter.js"; // Hook import
import { authenticateUser } from "./middleware/auth/index.js"; // New auth middleware
import config from "./config/config.js";
import admin from "firebase-admin"; // Added Firebase Admin
import logger from "./utils/logger.js"; // Import logger
import { bodyLimit as chatBodyLimit } from "./controllers/ChatController.js"; // Import bodyLimit
import modelController from "./controllers/ModelController.js"; // Import raw model controller
import { applyCaching } from "./controllers/ModelControllerCache.js"; // Import caching wrapper

// Load environment variables from .env file
dotenv.config({ override: false }); // Load .env but don't override existing env vars

// Record process start time for measuring cold start duration
const coldStartStart = Date.now();

// Declare Fastify instance and port for later initialization
let fastify;
let PORT;

// --- Initialize Firebase Admin SDK ---
try {
  // Check if either credential method is available
  if (process.env.FIREBASE_CONFIG) {
    // Use the FIREBASE_CONFIG environment variable directly
    const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
    admin.initializeApp({
      credential: admin.credential.cert(firebaseConfig)
    });
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // Fall back to application default credentials if FIREBASE_CONFIG not available
    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
    });
    logger.info("Firebase Admin SDK initialized successfully with application default credentials.");
  } else {
    throw new Error("No Firebase credentials found. Set FIREBASE_CONFIG or GOOGLE_APPLICATION_CREDENTIALS environment variable.");
  }
} catch (error) {
  logger.error("Firebase Admin SDK initialization error:", error);
  process.exit(1); // Exit if Firebase Admin fails to initialize
}

// Eagerly initialize Firestore cache service
// firestoreCacheService.initialize();

// Start the server (using async/await)
const start = async () => {
  try {
    // Setup Fastify application with optional HTTP/2 support
    const useHttp2 = process.env.HTTP2_ENABLED === "true";
    const fastifyOptions = {
      logger: true,
      bodyLimit: chatBodyLimit
    };
    if (useHttp2) {
      fastifyOptions.http2 = true;
      if (process.env.K_SERVICE) {
        logger.info("Fastify configured with HTTP/2 cleartext (h2c) for Cloud Run");
      } else {
        const keyPath = "./localhost+2-key.pem";
        const certPath = "./localhost+2.pem";
        try {
          await fsPromises.access(keyPath);
          await fsPromises.access(certPath);
        } catch {
          logger.error(`HTTP/2 enabled locally but key/cert files not found at ${keyPath} or ${certPath}.`);
          process.exit(1);
        }
        const [key, cert] = await Promise.all([
          fsPromises.readFile(keyPath),
          fsPromises.readFile(certPath)
        ]);
        fastifyOptions.https = { key, cert };
        logger.info("Fastify configured with HTTP/2+TLS using mkcert files.");
      }
    }
    fastify = Fastify(fastifyOptions);
    PORT = process.env.PORT || 8080;
    // Apply Firestore caching to the ModelController if enabled
    const useCache = process.env.FIRESTORE_CACHE_ENABLED !== "false";
    if (useCache) {
      applyCaching(modelController);
    }

    // Register optimized plugins for CORS, security headers, and compression
    const allowedOriginSet = new Set([
      "http://localhost:3001",
      "https://chat-api-9ru.pages.dev",
      "https://nicxkms.github.io/chat-api",
      "https://nicxkms.github.io",
      "https://chat-8fh.pages.dev",
      "http://localhost:8000",
      "http://localhost:5500"
    ]);
    await Promise.all([
      fastify.register(cors, {
        origin: (origin, cb) => cb(null, !origin || allowedOriginSet.has(origin)),
        methods: ['GET','POST','PUT','DELETE','OPTIONS'],
        allowedHeaders: ['Content-Type','Authorization','Accept','Cache-Control','Connection','X-Requested-With','Range'],
        maxAge: 3600
      }),
      fastify.register(helmet, {
        contentSecurityPolicy: false,
        dnsPrefetchControl: false,
        frameguard: { action: 'sameorigin' },
        noSniff: true,
        referrerPolicy: { policy: 'no-referrer' }
      }),
      fastify.register(compress, { encodings: ['gzip'] })
    ]);

    // Add Rate Limiter Hook
    if (config.rateLimiting?.enabled !== false) {
      fastify.addHook("onRequest", rateLimiterHook);
    }

    // Register Firebase Auth Hook globally - USE NEW MIDDLEWARE
    fastify.addHook("onRequest", authenticateUser());

    // --- Register Route Plugins ---
    // Health check endpoints (can also be moved into a plugin)
    fastify.get("/health", (request, reply) => {
      reply.status(200).send({ status: "OK", version: config.version });
    });

    // Register main API plugin
    await fastify.register(mainApiRoutes, {
      prefix: "/api"
    });

    // --- Register Error Handler ---
    fastify.setErrorHandler(fastifyErrorHandler);

    // --- Start Server ---
    await fastify.listen({ port: PORT, host: "0.0.0.0" });
    // Log total cold start time after server is listening
    const coldStartTime = Date.now() - coldStartStart;
    logger.info(`Cold start completed in ${coldStartTime}ms`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

// Graceful shutdown logic encapsulated in a single function
let isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) return; // Prevent multiple executions
  isShuttingDown = true;

  try {
    fastify.log.info(`${signal} received, shutting down gracefully`);

    // Close Fastify (stops accepting new connections and waits for existing ones)
    await fastify.close();

    // Clean up Firebase Admin SDK connections, if initialised
    try {
      await admin.app().delete();
      fastify.log.info("Firebase app deleted.");
    } catch (err) {
      // If app was not initialised or already deleted, ignore
      fastify.log.debug("Firebase app delete skipped: ", err.message);
    }

    fastify.log.info("Server closed.");
  } catch (err) {
    fastify.log.error("Error during shutdown: ", err);
  } finally {
    process.exit(0);
  }
}

// Listen for termination signals **once** so that duplicate signals (e.g. SIGINT twice) don't cause issues
["SIGINT", "SIGTERM"].forEach(signal => {
  process.once(signal, () => gracefulShutdown(signal));
});

// Catch unhandled promise rejections & uncaught exceptions to log errors but keep server running
process.on("unhandledRejection", (reason, promise) => {
  fastify.log.error("Unhandled Rejection at:", promise, "reason:", reason);
  // Application continues running
});

process.on("uncaughtException", err => {
  fastify.log.error("Uncaught Exception thrown:", err);
  // Application continues running
});

start();