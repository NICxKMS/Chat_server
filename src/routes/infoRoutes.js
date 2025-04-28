/**
 * Info Routes Plugin
 * Provides general status, version, and test-auth endpoints under /api
 */
export default async function infoRoutes(fastify, opts) {
  // Health of API (status)
  fastify.get("/status", (request, reply) => {
    reply.send({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Version information
  fastify.get("/version", (request, reply) => {
    reply.send({
      version: process.env.npm_package_version || "1.0.0",
      apiVersion: "v1",
      timestamp: new Date().toISOString()
    });
  });

  // Test authentication
  fastify.get("/test-auth", (request, reply) => {
    const authenticated = Boolean(request.user);
    if (authenticated) {
      return reply.send({ authenticated: true, user: request.user });
    }
    return reply.send({ authenticated: false, message: "No user found. Authentication hook may not be running." });
  });
} 