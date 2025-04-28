import fp from "fastify-plugin";
import config from "../config/config.js";

export default fp(async function healthPlugin(fastify, opts) {
  fastify.get("/health", (request, reply) => {
    reply.status(200).send({ status: "OK", version: config.version });
  });
}); 