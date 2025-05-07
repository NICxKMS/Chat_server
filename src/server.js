/**
 * Main server entry point
 * Sets up Fastify server with configured routes and middleware
 */
import dotenv from "dotenv";
import Fastify from "fastify";
import { promises as fsPromises } from "node:fs"; // Use promises API

import zlib from "node:zlib"; // For inline compression
import mainApiRoutes from "./routes/index.js"; // Main plugin

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

// Create Fastify application with optional HTTP/2 support
const useHttp2 = process.env.HTTP2_ENABLED === "true";
const fastifyOptions = {
  logger: true,
  bodyLimit: chatBodyLimit // Set the global body limit here
};

if (useHttp2) {
  fastifyOptions.http2 = true;
  // In Cloud Run, TLS is terminated by the platform; use h2c without certs
  if (process.env.K_SERVICE) {
    logger.info("Fastify configured with HTTP/2 cleartext (h2c) for Cloud Run");
  } else {
    // Local/dev: use mkcert-generated key & cert for secure HTTP/2
    const keyPath = "./localhost+2-key.pem"; // Changed to double quotes, relative to src/
    const certPath = "./localhost+2.pem"; // Changed to double quotes, relative to src/

    // Validate existence asynchronously and read files using promises
    try {
      await fsPromises.access(keyPath);
      await fsPromises.access(certPath);
    } catch {
      logger.error(`HTTP/2 enabled locally but key/cert files not found at ${keyPath} or ${certPath}. Please ensure they are in the src/ directory or adjust paths.`);
      process.exit(1);
    }
    const [key, cert] = await Promise.all([
      fsPromises.readFile(keyPath),
      fsPromises.readFile(certPath)
    ]);
    fastifyOptions.https = {
      key,
      cert
    };
    logger.info("Fastify configured with HTTP/2+TLS using mkcert files.");
  }
}

const fastify = Fastify(fastifyOptions);
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
    // Apply Firestore caching to the ModelController if enabled
    const useCache = process.env.FIRESTORE_CACHE_ENABLED !== "false";
    if (useCache) {
      applyCaching(modelController);
    }

    // Inline CORS handling using a whitelist of allowed origins
    const allowedOrigins = [
      "http://localhost:3001",
      "https://chat-api-9ru.pages.dev",
      "https://nicxkms.github.io/chat-api",
      "https://nicxkms.github.io",
      "https://chat-8fh.pages.dev",
      "http://localhost:8000",
      "http://localhost:5000"
    ];
    fastify.addHook("onRequest", (request, reply, done) => {
      const origin = request.headers.origin;
      if (origin && allowedOrigins.includes(origin)) {
        reply.header("Access-Control-Allow-Origin", origin);
        reply.header("Vary", "Origin");
      }
      reply.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
      reply.header("Access-Control-Allow-Headers", "Content-Type,Authorization,Accept,Cache-Control,Connection,X-Requested-With,Range");
      // Cache preflight response for 1 hour
      reply.header("Access-Control-Max-Age", "3600");
      if (request.raw.method === "OPTIONS") {
        reply.status(204).send();
      } else {
        done();
      }
    });
    // Inline minimal security headers (subset of Helmet)
    fastify.addHook("onSend", (request, reply, payload, done) => {
      reply.header("X-DNS-Prefetch-Control", "off");
      reply.header("X-Frame-Options", "SAMEORIGIN");
      reply.header("X-Download-Options", "noopen");
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("X-Permitted-Cross-Domain-Policies", "none");
      done(null, payload);
    });
    // Inline basic compression for JSON/text payloads
    fastify.addHook("onSend", (request, reply, payload, done) => {
      const acceptEncoding = request.headers["accept-encoding"] || "";
      const contentType = reply.getHeader("Content-Type") || "";
      if (/\bgzip\b/.test(acceptEncoding) && /application\/json|text\//.test(contentType) && (typeof payload === "string" || Buffer.isBuffer(payload))) {
        zlib.gzip(payload, (err, compressed) => {
          if (err) {
            return done(err);
          }
          reply.header("Content-Encoding", "gzip");
          done(null, compressed);
        });
      } else {
        done(null, payload);
      }
    });

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

    // Warm up 'classified-models' cache before accepting real traffic
    // if (useCache) {
    // logger.info("Warming up 'classified-models' cache via Firestore...");
    // await fastify.ready();
    // const res = await fastify.inject({ method: "GET", url: "/api/models/classified" });
    // }

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