# Use an official Node.js LTS version (e.g., Node 20)
FROM node:20-slim

# Set working directory
WORKDIR /usr/src/app

# Create directory for Firebase credentials
RUN mkdir -p /secrets/firebase

# --- Dependency Installation ---
# Copy package files first for better caching
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# --- Application Code ---
# Copy build output (dist generated by workflow)
COPY dist ./dist

COPY mainr ./mainr

# --- Permissions ---
# Make the Go binary executable
RUN chmod +x ./mainr

# --- Runtime Configuration ---
# Inform Docker that the container listens on port 8080 (standard for Cloud Run)
# Ensure your Node.js (Fastify) app listens on the PORT environment variable (e.g., process.env.PORT || 8080)
EXPOSE 8080

# --- Startup Command ---
# Run both the Node.js server (from the build output) and the Go binary concurrently.
# IMPORTANT: Ensure main is configured to listen on a DIFFERENT port than the Node.js app (e.g., 8090).
# The Node.js app (dist/server.js) should listen on the port specified by the PORT env var (default 8080).
CMD ["npx", "concurrently", "node dist/server.js", "./mainr"] 