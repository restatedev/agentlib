import type {HandlerDescriptor, ServiceDescriptor} from "@restatedev/restate-sdk";
import type {InvocationPromise} from "@restatedev/restate-sdk";
import {
  makeServiceTool,
  type JsonValue,
  type MakeCall,
  type ServiceToolOptions,
} from "@restate-agents/core";
import {currentContext} from "./context.js";
import {adoptInvocation} from "./tool.js";
import type {Tool} from "./types.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Regular-SDK client call: read the ambient context, invoke the handler through the
 * interface descriptor, and adopt the invocation handle so the call is cancelled on
 * interruption (matching the promise `handlerTool` bridge).
 */
const promiseMakeCallFor =
  (descriptor: any): MakeCall =>
  (handler, key, callArg) => {
    const ctx = currentContext();
    const c = key === undefined ? ctx.client(descriptor) : ctx.client(descriptor, key);
    return adoptInvocation((c as any)[handler](callArg) as InvocationPromise<JsonValue>);
  };

/**
 * Turn a Restate interface into a single agent tool for the regular SDK. Omit `handler`
 * to get one tool that can invoke any handler; pass `handler` (typechecked against the
 * interface) to scope the tool to a single handler.
 */
export function serviceTool<H extends Record<string, HandlerDescriptor>, C = unknown>(
  iface: ServiceDescriptor<string, H>,
): Tool<C>;
export function serviceTool<H extends Record<string, HandlerDescriptor>, C = unknown>(
  options: ServiceToolOptions<H>,
): Tool<C>;
export function serviceTool<C = unknown>(
  arg: ServiceDescriptor | ServiceToolOptions<Record<string, HandlerDescriptor>>,
): Tool<C> {
  return makeServiceTool<C>(arg as any, promiseMakeCallFor) as unknown as Tool<C>;
}
