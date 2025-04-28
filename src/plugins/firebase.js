import fp from "fastify-plugin";
import admin from "firebase-admin";
import logger from "../utils/logger.js";
import { authenticateUser } from "../middleware/auth/index.js";

export default fp(async function fastifyFirebase(fastify, opts) {
  // Initialize Firebase Admin SDK
  try {
    if (!admin.apps.length) {
      if (process.env.FIREBASE_CONFIG) {
        const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
        admin.initializeApp({
          credential: admin.credential.cert(firebaseConfig)
        });
        logger.info("Firebase initialized via FIREBASE_CONFIG");
      } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        admin.initializeApp({
          credential: admin.credential.applicationDefault()
        });
        logger.info("Firebase initialized via GOOGLE_APPLICATION_CREDENTIALS");
      } else {
        throw new Error("No Firebase credentials found.");
      }
    } else {
      logger.info("Firebase already initialized, skipping duplicate initialization.");
    }
  } catch (err) {
    logger.error("Firebase initialization error:", err);
    // Exit process if Firebase fails to initialize
    process.exit(1);
  }

  // Register authentication hook
  fastify.addHook("onRequest", authenticateUser());
}); 