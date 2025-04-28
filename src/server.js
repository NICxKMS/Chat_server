/**
 * Main server entry point
 * Sets up Fastify server with configured routes and middleware
 */
import dotenv from "dotenv";
import Fastify from "fastify";

import fastifyCors from "@fastify/cors"; // Added
import fastifyHelmet from "@fastify/helmet"; // Added
import fastifyCompress from "@fastify/compress"; // Added
import mainApiRoutes from "./routes/index.js"; // Main plugin

import fastifyErrorHandler from "./middleware/errorHandler.js"; // Added error handler import
import rateLimiterHook from "./middleware/rateLimiter.js"; // Hook import
import { authenticateUser } from "./middleware/auth/index.js"; // New auth middleware
import config from "./config/config.js";
import admin from "firebase-admin"; // Added Firebase Admin
import logger from "./utils/logger.js"; // Import logger
import { isEnabled as isCacheEnabled } from "./utils/cache.js"; // Import specific function
import { bodyLimit as chatBodyLimit } from "./controllers/ChatController.js"; // Import bodyLimit

// Load environment variables from .env file
dotenv.config({ override: false }); // Load .env but don't override existing env vars

// Create Fastify application
// const app = express(); // Removed
const fastify = Fastify({
  logger: true,
  bodyLimit: chatBodyLimit // Set the global body limit here
}); // Added (with logger)
const PORT = process.env.PORT || 8080;

// --- Initialize Firebase Admin SDK ---
try {
  // Check if either credential method is available
  if (process.env.FIREBASE_CONFIG) {
    // Use the FIREBASE_CONFIG environment variable directly
    const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
    admin.initializeApp({
      credential: admin.credential.cert(firebaseConfig)
    });
    logger.info("Firebase Admin SDK initialized successfully with FIREBASE_CONFIG.");
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
// ------------------------------------

// --- Legacy Firebase Authentication Hook ---
// Keeping this for reference - now replaced with authenticateUser middleware
async function firebaseAuthHook(request, reply) {
  logger.debug("=========== FIREBASE AUTH HOOK START ===========");
  // Initialize request.user to null for every request
  request.user = null;
  const authHeader = request.headers.authorization;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    const idToken = authHeader.split("Bearer ")[1];
    try {
      logger.debug("Verifying Firebase token...");
      // Verify the ID token using Firebase Admin SDK
      const decodedToken = await admin.auth().verifyIdToken(idToken);
      // Attach decoded user information if token is valid
      request.user = {
        uid: decodedToken.uid,
        email: decodedToken.email,
        // Add other properties from decodedToken as needed
      };
      logger.debug(`Authenticated user via hook: ${request.user.uid}`);
    } catch (error) {
      // Token provided but invalid/expired. Log warning but allow request to proceed
      logger.warn(`Firebase token verification failed (allowing anonymous access): ${error.message}`, { code: error.code });
    }
  } else {
    // No token provided, proceed as anonymous
    logger.debug("No auth token provided, proceeding as anonymous.");
  }

  logger.debug("=========== FIREBASE AUTH HOOK END ===========");
  // Always return (allow request to proceed)
  return;
}
// ------------------------------------

// Start the server (using async/await)
const start = async () => {
  try {
    // Register essential plugins
    await fastify.register(fastifyCors, {
      // origin: 'http://localhost:3001', // Temporarily commented out
      // origin: process.env.NODE_ENV === 'production' ? false : ['http://localhost:3001', 'http://localhost:3000','http://192.168.1.100:3001', 'http://localhost:3002','*'], // OLD CORS logic
      origin: (origin, cb) => {
        const allowedOrigins = [
          "http://localhost:3000",
          "https://chat-api-9ru.pages.dev",
          "https://nicxkms.github.io/chat-api/",
          "https://nicxkms.github.io"
        ];
        // const allowedPattern = /\\.chat-api-9ru\\.pages\\.dev$/; // Regex for allowed Cloudflare Pages domain - Replaced with suffix check
        const allowedDomainPrefix = "nicxkms.github.io";
        const allowedDomainSuffix = ".chat-api-9ru.pages.dev"; // Allow any subdomain of this

        if (process.env.NODE_ENV !== "production") {
          // Allow common dev origins and wildcard in non-production
          const devOrigins = ["http://localhost:3001", "http://localhost:3000","http://192.168.1.100:3001", "http://localhost:3002"];
          if (!origin || devOrigins.includes(origin) || origin.includes("localhost")) { // Allow requests with no origin (like curl) and common dev hosts
            cb(null, true);
            return;
          }
          // For non-production, you might still want to allow the production pattern or be more permissive
          // Example: allow anything if not production
          cb(null, true); // Allow everything in non-prod for simplicity here
          return;
        } else {
          // Production CORS logic
          if (!origin) { // Allow requests with no origin (like curl, server-to-server)
            cb(null, true);
            return;
          }

          try {
            const originUrl = new URL(origin);
            // Check if the origin is in the explicit list OR if its hostname ends with the allowed suffix
            if (allowedOrigins.includes(origin) || originUrl.hostname.endsWith(allowedDomainSuffix) || originUrl.hostname.startsWith(allowedDomainPrefix)) {
              cb(null, true); // Allow the origin
            } else {
              logger.warn(`CORS denied for origin: ${origin}`);
              cb(new Error("Not allowed by CORS"), false); // Deny the origin
            }
          } catch (e) {
            // Handle invalid origin format if necessary
            logger.warn(`Invalid origin format received: ${origin}, denying CORS. Error: ${e.message}`);
            cb(new Error("Invalid Origin Header"), false);
          }
        }
      },
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "Accept",
        "Cache-Control",
        "Connection",
        "X-Requested-With",
        "Range"
      ],
      exposedHeaders: ["Content-Length", "Content-Range", "Content-Encoding"],
      credentials: true,
      maxAge: 86400 // 24 hours
    });
    await fastify.register(fastifyHelmet, {
      // TODO: Review Helmet options for production.
      // Disabling CSP/COEP might be insecure.
      // Consider default policies or configuring them properly.
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false
    });
    await fastify.register(fastifyCompress);

    // Add Rate Limiter Hook
    if (config.rateLimiting?.enabled !== false) {
      fastify.addHook("onRequest", rateLimiterHook);
    }

    // Add universal request logging hook to verify execution
    fastify.addHook("onRequest", async (request, reply) => {
      logger.debug("=========== UNIVERSAL REQUEST HOOK START ===========");
      logger.debug(`Request path: ${request.url}`);
      logger.debug("=========== UNIVERSAL REQUEST HOOK END ===========");
    });

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
    // Logger automatically logs listen address

    // Determine Base Path from Environment Variable
    logger.info(`Cache enabled: ${isCacheEnabled()}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

// Handle graceful shutdown
const signals = ["SIGINT", "SIGTERM"];
signals.forEach(signal => {
  process.on(signal, async () => {
    fastify.log.info(`${signal} received, shutting down gracefully`);
    await fastify.close(); // Close the Fastify server
    // Add any other cleanup logic here if needed
    fastify.log.info("Server closed.");
    process.exit(0);
  });
});

start();