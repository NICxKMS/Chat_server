import fp from "fastify-plugin";
import * as metrics from "../utils/metrics.js";

export default fp(async function metricsPlugin(fastify, opts) {
  fastify.addHook("onRequest", (request, reply, done) => {
    try {
      metrics.incrementRequestCount();
    } catch (err) {
      // Avoid crashing on metrics errors
      fastify.log.warn(`Failed to increment metrics: ${err.message}`);
    }
    done();
  });
}); 