import {serve} from "@restatedev/restate-sdk";
import {aiSession} from "./ai-session.js";

await serve({services: [aiSession], port: 9080});
