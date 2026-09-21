import {serve} from "@restatedev/restate-sdk";
import {promiseHello} from "./01_hello.js";
import {promiseTicketLookup} from "./02_tools.js";
import {promiseChatSession} from "./03_conversation.js";
import {promiseTicketTriage} from "./04_structured_output.js";
import {promiseCodeReview} from "./05_evaluator_optimizer.js";
import {promiseTicketApproval} from "./06_human_approval.js";
import {regularSdkSupport, supportPolicies} from "./07_support_session.js";
import {refundAgent, refundService} from "./08_service_tool.js";

await serve({
  services: [
    promiseHello,
    promiseTicketLookup,
    promiseChatSession,
    promiseTicketTriage,
    promiseCodeReview,
    promiseTicketApproval,
    regularSdkSupport,
    supportPolicies,
    refundService,
    refundAgent,
  ],
  port: 9080,
});
