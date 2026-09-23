import {serve} from "@restatedev/restate-sdk";
import {gensdkServices} from "./services.js";

await serve({services: gensdkServices, port: 9080});
