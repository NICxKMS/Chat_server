/**
 * tracing.js
 * Initializes OpenTelemetry Node SDK with auto-instrumentations for HTTP, Fastify, Axios, and gRPC.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';

// Configure OTLP exporter (uses OTEL_EXPORTER_OTLP_ENDPOINT env var, e.g., http://localhost:4318/v1/traces)
const traceExporter = new OTLPTraceExporter({
  url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT
});

// Initialize the OpenTelemetry SDK
const sdk = new NodeSDK({
  traceExporter,
  instrumentations: [getNodeAutoInstrumentations()],
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: process.env.SERVICE_NAME || 'chat-api'
  })
});

try {
  sdk.start();
  console.log('OpenTelemetry tracing initialized');
} catch (error) {
  console.error('Error initializing OpenTelemetry tracing', error);
}
