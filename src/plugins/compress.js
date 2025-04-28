import fastifyCompress from "@fastify/compress";

export default async function compressPlugin(fastify) {
  await fastify.register(fastifyCompress);
} 