import {SpanStatusCode, type Tracer} from "@opentelemetry/api";
import type {ModelRequest, ModelResponse} from "./types.js";

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
