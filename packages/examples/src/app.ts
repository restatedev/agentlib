// Serves both flavors from one endpoint.
import {serve} from "@restatedev/restate-sdk";
import {gensdkServices} from "./gensdk/services.js";
import {promiseServices} from "./promise/services.js";

await serve({services: [...gensdkServices, ...promiseServices], port: 9080});
