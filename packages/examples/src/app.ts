import {serve} from "@restatedev/restate-sdk";
import {hello} from "./gensdk/01_hello.js";
import {ticketLookup} from "./gensdk/02_tools.js";
import {chatSession} from "./gensdk/03_conversation.js";
import {ticketTriage} from "./gensdk/04_structured_output.js";
import {codeReview} from "./gensdk/05_evaluator_optimizer.js";
import {ticketApproval} from "./gensdk/06_human_approval.js";
import {racingAgents} from "./gensdk/07_racing_agents.js";
import {researchReport, researchWorker} from "./gensdk/08_research_report.js";
import {aiSession} from "./gensdk/09_support_session.js";
import {promiseHello} from "./promise/01_hello.js";
import {promiseTicketLookup} from "./promise/02_tools.js";
import {promiseChatSession} from "./promise/03_conversation.js";
import {promiseTicketTriage} from "./promise/04_structured_output.js";
import {promiseCodeReview} from "./promise/05_evaluator_optimizer.js";
import {regularSdkSupport, supportPolicies} from "./promise/06_support_session.js";

await serve({
  services: [
    hello,
    ticketLookup,
    chatSession,
    ticketTriage,
    codeReview,
    ticketApproval,
    racingAgents,
    researchReport,
    researchWorker,
    aiSession,
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
