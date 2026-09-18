import {serve} from "@restatedev/restate-sdk";
import {promiseHello} from "./01_hello.js";
import {promiseTicketLookup} from "./02_tools.js";
import {promiseChatSession} from "./03_conversation.js";
import {promiseTicketTriage} from "./04_structured_output.js";
import {promiseCodeReview} from "./05_evaluator_optimizer.js";
import {regularSdkSupport, supportPolicies} from "./06_support_session.js";

await serve({
  services: [
    promiseHello,
    promiseTicketLookup,
    promiseChatSession,
    promiseTicketTriage,
    promiseCodeReview,
    regularSdkSupport,
    supportPolicies,
  ],
  port: 9080,
});
