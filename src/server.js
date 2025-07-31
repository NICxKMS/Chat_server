/**
 * @file Main server entry point
 * @description Sets up the Fastify server with optimized plugins, routes, and middleware.
 * @version 2.2.0
 */

import "./tracing.js"; // Initialize OpenTelemetry first
import Fastify from "fastify";
import admin from "firebase-admin";

// Fastify plugins
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import compress from "@fastify/compress";

// Local module imports
import config from "./config/config.js";
import fastifyErrorHandler from "./middleware/errorHandler.js";
import rateLimiterHook from "./middleware/rateLimiter.js";
import { authenticateUser } from "./middleware/auth/index.js";
import mainApiRoutes from "./routes/index.js";
import infoRoutes from "./routes/infoRoutes.js";
import { getMetrics } from "./utils/metrics.js";
import modelController from "./controllers/ModelController.js";
import { applyCaching } from "./controllers/ModelControllerCache.js";
import logger from "./utils/logger.js";

const coldStartStart = Date.now();

/**
 * Initializes and configures the Fastify server instance.
 * @returns {import('fastify').FastifyInstance} The configured Fastify instance.
 */
async function buildServer() {
  const fastify = Fastify({
    logger: {
      level: config.logLevel,
      redact: { paths: ["req.headers.authorization"], remove: true },
    },
    bodyLimit: 10 * 1024 * 1024, // 10MB
  });

  const allowedOrigins = new Set([
    "http://localhost:3001",
    "https://chat-api-9ru.pages.dev",
    "https://nicxkms.github.io/chat-api",
    "https://nicxkms.github.io",
    "https://chat-8fh.pages.dev",
    "http://localhost:8000",
    "http://localhost:5500",
  ]);

  // Register essential plugins
  await fastify.register(cors, {
    origin: true, // Dynamically reflects the request origin.
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Accept",
      "Cache-Control",
      "Connection",
      "X-Requested-With",
      "Range",
    ],
    maxAge: 3600, // Cache preflight requests for 1 hour.
  });

  await fastify.register(helmet, {
    contentSecurityPolicy: false, // Specific policies can be configured here if needed.
    dnsPrefetchControl: false,
    frameguard: { action: "sameorigin" },
    noSniff: true,
    referrerPolicy: { policy: "no-referrer" },
  });

  await fastify.register(compress, { encodings: ["gzip"] });

  // Register application-level hooks
  if (config.rateLimiting?.enabled) {
    fastify.addHook("onRequest", rateLimiterHook);
  }
  fastify.addHook("onRequest", authenticateUser());
  fastify.setErrorHandler(fastifyErrorHandler);

  // Register route handlers
  await fastify.register(infoRoutes);
  await fastify.register(mainApiRoutes, { prefix: "/api" });
  fastify.get("/metrics", async (request, reply) => {
    reply.type("text/plain").send(await getMetrics());
  });

  return fastify;
}

/**
 * Initializes the Firebase Admin SDK using available credentials.
 */
function initializeFirebase() {
  try {
    const firebaseConfigEnv = process.env.FIREBASE_CONFIG;
    let credential;

    if (firebaseConfigEnv) {
      const firebaseConfig = JSON.parse(firebaseConfigEnv);
      credential = admin.credential.cert(firebaseConfig);
      logger.info("Initializing Firebase Admin SDK with FIREBASE_CONFIG.");
    } else {
      credential = admin.credential.applicationDefault();
      logger.info("Initializing Firebase Admin SDK with application default credentials.");
    }

    admin.initializeApp({ credential });
  } catch (error) {
    logger.error("Firebase Admin SDK initialization failed:", error);
    process.exit(1);
  }
}

/**
 * Handles graceful shutdown of the server and connected services.
 * @param {string} signal - The signal that triggered the shutdown.
 * @param {import('fastify').FastifyInstance} server - The Fastify server instance.
 */
async function gracefulShutdown(signal, server) {
  logger.info(`${signal} received, shutting down gracefully...`);
  await server.close();
  await admin.app().delete();
  logger.info("Server and Firebase app shut down successfully.");
  process.exit(0);
}

/**
 * The main entry point for the application.
 * Initializes services, builds the server, and starts listening for requests.
 */
async function main() {
  initializeFirebase();

  if (process.env.FIRESTORE_CACHE_ENABLED !== "false") {
    applyCaching(modelController);
  }

  const server = await buildServer();

  // Set up signal handlers for graceful shutdown
  process.on("SIGINT", () => gracefulShutdown("SIGINT", server));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM", server));

  try {
    await server.listen({ port: config.port || 8080, host: "0.0.0.0" });
    const coldStartTime = Date.now() - coldStartStart;
    logger.info(`Cold start completed in ${coldStartTime}ms`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

main();
