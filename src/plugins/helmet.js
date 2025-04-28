import fastifyHelmet from "@fastify/helmet";

export default async function helmetPlugin(fastify) {
  await fastify.register(fastifyHelmet, {
    // Consider default policies or configure properly for production
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  });
} 