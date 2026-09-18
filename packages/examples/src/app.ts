import {serve} from "@restatedev/restate-sdk";
import {aiSession} from "./ai-session.js";
import {researchReport, researchWorker} from "./research-report.js";
import {codeReview} from "./evaluator-optimizer.js";
import {racingAgents} from "./racing-agents.js";
import {regularSdkSupport, supportPolicies} from "./regular-sdk.js";

await serve({
  services: [
    aiSession,
    researchReport,
    researchWorker,
    codeReview,
    racingAgents,
    regularSdkSupport,
    supportPolicies,
  ],
  port: 9080,
});
