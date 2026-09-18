import {serve} from "@restatedev/restate-sdk";
import {aiSession} from "./coroutine/ai-session.js";
import {researchReport, researchWorker} from "./coroutine/research-report.js";
import {codeReview} from "./coroutine/evaluator-optimizer.js";
import {racingAgents} from "./coroutine/racing-agents.js";
import {regularSdkSupport, supportPolicies} from "./promise/regular-sdk.js";
import {promiseCodeReview} from "./promise/evaluator-optimizer.js";

await serve({
  services: [
    aiSession,
    researchReport,
    researchWorker,
    codeReview,
    racingAgents,
    regularSdkSupport,
    supportPolicies,
    promiseCodeReview,
  ],
  port: 9080,
});
