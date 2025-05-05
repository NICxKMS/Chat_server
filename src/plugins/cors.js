import fastifyCors from "@fastify/cors";
import logger from "../utils/logger.js";

export default async function corsPlugin(fastify) {
  await fastify.register(fastifyCors, {
    origin: (origin, cb) => {
      const allowedOrigins = [
        "http://localhost:3000",
        "https://chat-api-9ru.pages.dev",
        "https://nicxkms.github.io/chat-api/",
        "https://nicxkms.github.io",
        "https://chat-8fh.pages.dev",
        "http://localhost:8000"
      ];
      const allowedDomainPrefix = "nicxkms.github.io";
      const allowedDomainSuffix = ".chat-api-9ru.pages.dev";

      if (process.env.NODE_ENV !== "production") {
        logger.debug(`CORS request from origin: ${origin || "same-origin"}`);
        cb(null, true);
        return;
      } else {
        if (!origin) {
          cb(null, true);
          return;
        }
        try {
          const originUrl = new URL(origin);
          if (
            allowedOrigins.includes(origin) ||
            originUrl.hostname.endsWith(allowedDomainSuffix) ||
            originUrl.hostname.startsWith(allowedDomainPrefix)
          ) {
            cb(null, true);
          } else {
            logger.warn(`CORS denied for origin: ${origin}`);
            cb(new Error("Not allowed by CORS"), false);
          }
        } catch (e) {
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

  fastify.addHook("preHandler", (req, reply, done) => {
    reply.header("Access-Control-Allow-Origin", req.headers.origin || "*");
    reply.header("Access-Control-Allow-Credentials", "true");
    done();
  });
} 