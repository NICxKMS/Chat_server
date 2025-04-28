/**
 * Main server entry point
 * Sets up Fastify server with configured routes and middleware
 */
import dotenv from "dotenv";
import Fastify from "fastify";
import autoload from "@fastify/autoload";
import path from "path";
import { fileURLToPath } from "url";

// import mainApiRoutes from "./routes/index.js"; // Main plugin (autoloaded below)
import fastifyErrorHandler from "./middleware/errorHandler.js"; // Added error handler import
import rateLimiterHook from "./middleware/rateLimiter.js"; // Hook import
import { authenticateUser } from "./middleware/auth/index.js"; // New auth middleware
import config from "./config/config.js";
import admin from "firebase-admin"; // Added Firebase Admin
import logger from "./utils/logger.js"; // Import logger
import { bodyLimit as chatBodyLimit } from "./controllers/ChatController.js"; // Import bodyLimit
import fastifyCors from "@fastify/cors"; // Import CORS directly

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
    // Register CORS first, before any other plugins or routes
    await fastify.register(fastifyCors, {
      origin: true, // Allow all origins in development
      credentials: true,
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
      exposedHeaders: ["Content-Length", "Content-Range", "Content-Encoding"]
    });
    logger.info("CORS plugin registered directly in server.js");

    // Auto-load all plugins (cors, helmet, compress, etc.) from /plugins
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    await fastify.register(autoload, {
      dir: path.join(__dirname, "plugins"),
      // Skip loading cors.js since we're registering it directly
      ignorePattern: /cors\.js$/
    });

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
    // Health check endpoint provided by healthPlugin

    // Auto-load all route plugins from /routes under /api
    await fastify.register(autoload, {
      dir: path.join(__dirname, "routes"),
      options: { prefix: "/api" },
      // index.js and infoRoutes.js only; chatRoutes and modelRoutes are registered via index.js
      ignorePattern: /(?:chatRoutes|modelRoutes)\.js$/
    });

    // --- Register Error Handler ---
    fastify.setErrorHandler(fastifyErrorHandler);

    // --- Start Server ---
    await fastify.listen({ port: PORT, host: "0.0.0.0" });
    // Logger automatically logs listen address
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