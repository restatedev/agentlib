import {serve} from "@restatedev/restate-sdk";
import {hello} from "./01_hello.js";
import {ticketLookup} from "./02_tools.js";
import {chatSession} from "./03_conversation.js";
import {ticketTriage} from "./04_structured_output.js";
import {codeReview} from "./05_evaluator_optimizer.js";
import {ticketApproval} from "./06_human_approval.js";
import {racingAgents} from "./07_racing_agents.js";
import {researchReport, researchWorker} from "./08_research_report.js";
import {aiSession} from "./09_support_session.js";
import {refundAgent, refundService} from "./10_service_tool.js";

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
    refundService,
    refundAgent,
  ],
  port: 9080,
});
