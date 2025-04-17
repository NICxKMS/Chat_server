/**
 * Metrics Utilities
 * Prometheus metrics for monitoring system performance
 */
import * as promClient from "prom-client";

// Initialize Prometheus registry
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

// --- General Request Metrics ---

// Total HTTP requests counter
const requestCounter = new promClient.Counter({
  name: "chat_api_requests_total",
  help: "Total number of requests to the API",
  registers: [register]
});

// --- Provider Specific Metrics ---

// Provider request counter (non-streaming)
const providerRequestCounter = new promClient.Counter({
  name: "chat_api_provider_requests_total",
  help: "Total number of non-streaming requests made to providers",
  // WARNING: 'model' label can have high cardinality. Consider sanitization if needed.
  labelNames: ["provider", "model", "status"], // status: 'success', 'error', 'cached' etc.
  registers: [register]
});

// Provider response time histogram (non-streaming)
const responseTimeHistogram = new promClient.Histogram({
  name: "chat_api_response_time_seconds",
  help: "Response time for non-streaming provider requests in seconds",
  // WARNING: 'model' label can have high cardinality. Consider sanitization if needed.
  labelNames: ["provider", "model", "status_code"], // Added labels
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60], // Standard buckets
  registers: [register]
});

// Provider error counter (can be used for both streaming and non-streaming)
const providerErrorCounter = new promClient.Counter({
  name: "chat_api_provider_errors_total",
  help: "Total number of errors returned by providers",
  // WARNING: 'model' label can have high cardinality. Consider sanitization if needed.
  labelNames: ["provider", "model", "status_code"], // e.g., 4xx, 5xx, network
  registers: [register]
});

// --- Streaming Specific Metrics ---

// Time to First Byte (TTFB) for streams histogram
const streamTtfbHistogram = new promClient.Histogram({
  name: "chat_api_stream_ttfb_seconds",
  help: "Time to first byte for streaming responses in seconds",
  // WARNING: 'model' label can have high cardinality. Consider sanitization if needed.
  labelNames: ["provider", "model"], 
  buckets: [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10], // Buckets suitable for TTFB
  registers: [register]
});

// Total stream duration histogram
const streamDurationHistogram = new promClient.Histogram({
  name: "chat_api_stream_duration_seconds",
  help: "Total duration of streaming responses in seconds",
  // WARNING: 'model' label can have high cardinality. Consider sanitization if needed.
  labelNames: ["provider", "model"],
  buckets: [0.5, 1, 2, 5, 10, 30, 60, 120, 300], // Wider range for duration
  registers: [register]
});

// Stream chunk counter
const streamChunkCounter = new promClient.Counter({
  name: "chat_api_stream_chunks_total",
  help: "Total number of chunks sent in streaming responses",
  // WARNING: 'model' label can have high cardinality. Consider sanitization if needed.
  labelNames: ["provider", "model"],
  registers: [register]
});

// Stream error counter
const streamErrorCounter = new promClient.Counter({
  name: "chat_api_stream_errors_total",
  help: "Total number of errors encountered during streaming",
  // WARNING: 'model' label can have high cardinality. Consider sanitization if needed.
  labelNames: ["provider", "model", "type"], // type: 'timeout', 'provider_error', 'client_disconnect', 'write_error'
  registers: [register]
});

// --- System Metrics ---

// Circuit breaker status gauge
const circuitBreakerGauge = new promClient.Gauge({
  name: "chat_api_circuit_breaker_status",
  help: "Circuit breaker status (0=closed, 1=open, 2=half-open)",
  labelNames: ["name", "state"],
  registers: [register],
  collect() {},
});

// Memory usage gauge
const memoryGauge = new promClient.Gauge({
  name: "chat_api_memory_usage_bytes",
  help: "Memory usage in bytes",
  labelNames: ["type"],
  registers: [register],
  collect() {},
});

// --- Metric Recording Functions ---

/** Increments the total HTTP request counter. */
function incrementRequestCount() {
  requestCounter.inc();
}

/** Records the response time for a non-streaming provider request. */
function recordResponseTime(seconds) {
  // Note: This might be better if labeled by provider/model
  responseTimeHistogram.observe(seconds);
}

/** Increments the counter for non-streaming provider requests. */
function incrementProviderRequestCount(provider, model, status) {
  providerRequestCounter.labels(provider, model, status).inc();
}

/** Increments the counter for provider errors. */
function incrementProviderErrorCount(provider, model, statusCode) {
  providerErrorCounter.labels(provider, model, String(statusCode)).inc();
}

// --- Streaming Metric Functions ---

/** Records the Time To First Byte (TTFB) for a stream. */
function recordStreamTtfb(provider, model, seconds) {
  streamTtfbHistogram.labels(provider, model).observe(seconds);
}

/** Records the total duration for a completed or terminated stream. */
function recordStreamDuration(provider, model, seconds) {
  streamDurationHistogram.labels(provider, model).observe(seconds);
}

/** Increments the counter for chunks sent in a stream. */
function incrementStreamChunkCount(provider, model) {
  streamChunkCounter.labels(provider, model).inc();
}

/** Increments the counter for errors encountered during streaming. */
function incrementStreamErrorCount(provider, model, type) {
  streamErrorCounter.labels(provider, model, type).inc();
}

// --- System Metric Functions ---

/** Retrieves all metrics for the Prometheus scraper. */
function getMetrics() {
  return register.metrics();
}

/** Updates memory usage gauges. Called periodically. */
function updateMemoryMetrics() {
  const memoryUsage = process.memoryUsage();
  
  memoryGauge.labels("rss").set(memoryUsage.rss);
  memoryGauge.labels("heapTotal").set(memoryUsage.heapTotal);
  memoryGauge.labels("heapUsed").set(memoryUsage.heapUsed);
  memoryGauge.labels("external").set(memoryUsage.external);
  // dynamicHistograms.clear(); // REMOVED
}

/** Updates the gauge for a specific circuit breaker's state. */
function updateCircuitBreakerGauge(name, state, value) {
  circuitBreakerGauge.labels(name, state).set(value);
}

// Start collecting metrics automatically
updateMemoryMetrics();
setInterval(updateMemoryMetrics, 10000);

// Reset all metrics
function resetMetrics() {
  register.resetMetrics();
  // dynamicCounters.clear(); // REMOVED
  // dynamicHistograms.clear(); // REMOVED
}

// --- Exports ---

// Export metrics utilities
export {
  incrementRequestCount,
  recordResponseTime,
  getMetrics,
  updateMemoryMetrics,
  updateCircuitBreakerGauge,
  resetMetrics,
  register,
  requestCounter,
  providerRequestCounter,
  responseTimeHistogram,
  circuitBreakerGauge,
  memoryGauge,
  incrementProviderRequestCount,
  incrementProviderErrorCount,
  recordStreamTtfb,
  recordStreamDuration,
  incrementStreamChunkCount,
  incrementStreamErrorCount
}; 