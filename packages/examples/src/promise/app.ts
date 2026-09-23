import {serve} from "@restatedev/restate-sdk";
import {promiseServices} from "./services.js";

await serve({services: promiseServices, port: 9080});
