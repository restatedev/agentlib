import {serve} from "@restatedev/restate-sdk";
import {regularSdkSupport, supportPolicies} from "./regular-sdk.js";
import {promiseCodeReview} from "./evaluator-optimizer.js";

await serve({
  services: [regularSdkSupport, supportPolicies, promiseCodeReview],
  port: 9080,
});
