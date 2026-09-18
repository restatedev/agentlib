import {SpanStatusCode, type Tracer} from "@opentelemetry/api";
import {run, type Operation} from "@restatedev/restate-sdk-gen";
import type {AgentUpdate, ModelRequest, ModelResponse} from "./types.js";

/** Called inside journaled model I/O. Completed attempts do not emit again on replay. */
export async function traceModel(
  tracer: Tracer | undefined,
  request: ModelRequest,
  generate: () => Promise<ModelResponse>,
): Promise<ModelResponse> {
  if (!tracer) return generate();
  return tracer.startActiveSpan(
    "agent.model",
    {attributes: {"gen_ai.operation.name": "chat", "agent.step": request.step ?? 0}},
    async (span) => {
      try {
        return await generate();
      } catch (error) {
        span.setStatus({code: SpanStatusCode.ERROR});
        if (error instanceof Error) span.recordException(error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}
/** Metadata-only event hook. Configure an OTel/Braintrust exporter in the host. */
export function otelUpdates(tracer: Tracer) {
  return function* (event: AgentUpdate): Operation<void> {
    yield* run(
      async () => {
        const span = tracer.startSpan(`agent.${event.type}`, {
          attributes: {"agent.event_id": event.id, "agent.step": event.step},
        });
        span.end();
        return null;
      },
      {name: `otel:${event.id}`, retry: {maxAttempts: 1}},
    );
  };
}
