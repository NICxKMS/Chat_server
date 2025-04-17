# Use an official Node.js LTS version (e.g., Node 20)
FROM node:20-slim

# Set working directory
WORKDIR /usr/src/app

# --- Dependency Installation ---
# Copy package files first for better caching
COPY package*.json ./

# Install production dependencies cleanly
# Note: 'concurrently' is needed to run both services.
# Ensure 'concurrently' is listed under "dependencies" in your package.json, not just "devDependencies".
# If not, run: npm install concurrently --save-prod
RUN npm ci --omit=dev

# --- Application Code ---
# Copy source code and pre-compiled binary
COPY src ./src
COPY main.exe ./main.exe

# --- Build Step ---
# Run the build script defined in package.json (adjust if needed)
# This assumes the output is in the 'dist' directory
RUN npm run build

# --- Permissions ---
# Make the Go binary executable
RUN chmod +x ./main.exe

# --- Runtime Configuration ---
# Inform Docker that the container listens on port 8080 (standard for Cloud Run)
# Ensure your Node.js (Fastify) app listens on the PORT environment variable (e.g., process.env.PORT || 8080)
EXPOSE 8080

# --- Startup Command ---
# Run both the Node.js server (from the build output) and the Go binary concurrently.
# IMPORTANT: Ensure main.exe is configured to listen on a DIFFERENT port than the Node.js app (e.g., 8081).
# The Node.js app (dist/server.js) should listen on the port specified by the PORT env var (default 8080).
# Example command assumes Node.js on $PORT (8080) and main.exe on 8081.
CMD ["npx", "concurrently", "node dist/server.js", "./main.exe"] 