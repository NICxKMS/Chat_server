/**
 * Logger Utility
 * A simple logger for application-wide logging with different log levels
 */
import * as winston from "winston";
import config from "../config/config.js";

// Define log format
const logFormat = winston.format.printf(({ level, message, timestamp, ...meta }) => {
  return `${timestamp} [${level.toUpperCase()}]: ${message} ${
    Object.keys(meta).length ? JSON.stringify(meta, null, 2) : ""
  }`;
});

// Determine log level based on environment
const logLevel = process.env.NODE_ENV === 'production' 
  ? 'warn' 
  : process.env.NODE_ENV === 'development' 
    ? 'debug' 
    : 'info';

// Create the logger
const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    logFormat
  ),
  transports: [
    // Console transport for all environments
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
        logFormat
      )
    }),
    // File transport for production
    ...(config.environment === "production" 
      ? [
        new winston.transports.File({ 
          filename: "logs/error.log", 
          level: "error" 
        }),
        new winston.transports.File({ 
          filename: "logs/combined.log" 
        })
      ] 
      : [])
  ]
});

// Export the logger
export default logger; 