import {serve} from "@restatedev/restate-sdk";
import {hello} from "./01_hello.js";
import {ticketLookup} from "./02_tools.js";
import {chatSession} from "./03_conversation.js";
import {ticketTriage} from "./04_structured_output.js";
import {codeReview} from "./05_evaluator_optimizer.js";
import {racingAgents} from "./06_racing_agents.js";
import {researchReport, researchWorker} from "./07_research_report.js";
import {aiSession} from "./08_support_session.js";

await serve({
  services: [
    hello,
    ticketLookup,
    chatSession,
    ticketTriage,
    codeReview,
    racingAgents,
    researchReport,
    researchWorker,
    aiSession,
  ],
  port: 9080,
});
