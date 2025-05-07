/**
 * Application Configuration
 * Centralized configuration management for the application
 */
import dotenv from "dotenv";

// Load environment variables
dotenv.config();

// Default configuration values
const defaultConfig = {
  // port: parseInt(process.env.PORT || "3000", 10),
  environment: process.env.NODE_ENV || "development",
  version: process.env.npm_package_version || "1.0.0",
  logLevel: process.env.LOG_LEVEL || "debug",
  providers: {
    openai: {
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: process.env.OPENAI_BASE_URL,
      timeout: parseInt(process.env.OPENAI_TIMEOUT || "30000", 10),
      maxRetries: parseInt(process.env.OPENAI_MAX_RETRIES || "3", 10),
      models: [
        "gpt-4o",
        "gpt-4o-mini",
        "gpt-4-turbo",
        "gpt-4",
        "gpt-3.5-turbo",
        "gpt-3.5-turbo-16k"
      ],
      defaultModel: "gpt-3.5-turbo",
      dynamicModelLoading: true
    },
    anthropic: {
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseUrl: process.env.ANTHROPIC_BASE_URL,
      timeout: parseInt(process.env.ANTHROPIC_TIMEOUT || "30000", 10),
      models: ["claude-3-opus", "claude-3-sonnet", "claude-3-haiku"],
      defaultModel: "claude-3-haiku",
      dynamicModelLoading: true
    },
    gemini: {
      apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
      timeout: parseInt(process.env.GEMINI_TIMEOUT || "30000", 10),
      models: ["gemini-1.5-flash", "gemini-1.5-pro"],
      defaultModel: "gemini-1.5-flash",
      dynamicModelLoading: true,
      grpcKeepaliveTimeMs: parseInt(process.env.GEMINI_GRPC_KEEPALIVE_TIME_MS || "30000", 10),
      grpcKeepaliveTimeoutMs: parseInt(process.env.GEMINI_GRPC_KEEPALIVE_TIMEOUT_MS || "10000", 10),
      apiVersion: process.env.GEMINI_API_VERSION || "v1beta"
    },
    openrouter: {
      apiKey: process.env.OPENROUTER_API_KEY,
      baseUrl: process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
      timeout: parseInt(process.env.OPENROUTER_TIMEOUT || "60000", 10),
      models: [],
      defaultModel: "",
      dynamicModelLoading: true
    }
  },
  rateLimiting: {
    enabled: process.env.RATE_LIMITING_ENABLED !== "false",
    options: {
      points: parseInt(process.env.RATE_LIMITING_MAX || "10000000", 10),
      duration: parseInt(process.env.RATE_LIMITING_WINDOW_MS || "3600", 10), // in seconds
      blockDuration: parseInt(process.env.RATE_LIMITING_BLOCK_DURATION || "900", 10) // in seconds
    }
  },
  cache: {
    enabled: process.env.CACHE_ENABLED === "false",
    ttl: parseInt(process.env.CACHE_TTL || "300", 10),
    maxSize: parseInt(process.env.CACHE_MAX_SIZE || "100", 10)
  },
  cors: {
    origins: (process.env.CORS_ORIGINS || "*").split(","),
    headers: ["Content-Type", "Authorization", "X-Requested-With"]
  }
};

export default defaultConfig; 