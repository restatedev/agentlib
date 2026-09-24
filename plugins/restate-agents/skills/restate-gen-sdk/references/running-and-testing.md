# Running and testing

## Local loop

```sh
npx @restatedev/restate-server                               # ingress :8080, admin/UI :9070
npx tsx watch src/app.ts                                     # your endpoint on :9080
npx @restatedev/restate deployments register http://localhost:9080
curl localhost:8080/Greeter/greet --json '"Ada"'             # service
curl localhost:8080/Counter/user-42/add --json '1'           # object: /Name/key/handler
curl localhost:8080/Greeter/greet/send --json '"Ada"'        # one-way, returns an invocation ID
```

Rerun `register` after adding or changing handlers. The UI at
http://localhost:9070 shows each invocation's journal, which is the fastest
way to see why a handler is waiting or retrying.

## Calling from application code

```ts
import {clients} from "@restatedev/restate-sdk-gen";
import {greeter} from "./greeter.js";

const ingress = clients.connect({url: "http://localhost:8080"});
const greeting = await clients.client(ingress, greeter).greet("Ada");
```

`clients.sendClient` starts an invocation without waiting. Use
`clients.Opts.from({idempotencyKey})` to make a call safe to retry.

## Tests with forced replay

Run handlers against a real Restate server in Docker, with replay forced
after every step. A handler that is not deterministic fails the test instead
of failing in production on a retry.

```ts
import {after, before, test} from "node:test";
import assert from "node:assert/strict";
import {RestateContainer, RestateTestEnvironment} from "@restatedev/restate-sdk-testcontainers";
import {connect} from "@restatedev/restate-sdk-clients";
import {counter} from "../src/counter.js";

let env: RestateTestEnvironment;
before(async () => {
  env = await RestateTestEnvironment.start({
    services: [counter],
    container: () => new RestateContainer().alwaysReplay(),
  });
});
after(async () => env?.stop());

test("counts per key", async () => {
  const ingress = connect({url: env.baseUrl()});
  await ingress.client(counter, "a").add(2);
  assert.equal(await ingress.client(counter, "a").add(3), 5);
});
```

Any change to a handler's steps (new `run`, reordered calls, new branches)
needs a test like this that passes before the change is done.

## Debugging checklist

- **Stuck invocation:** open it in the UI. The last journal entry shows what it
  waits for: a sleep, a call, a signal, or an awakeable.
- **Journal mismatch after a deploy:** the handler changed the order or kind
  of its steps while invocations were in flight. Version the service or let
  in-flight work drain.
- **Endless retries:** an ordinary error keeps retrying. Throw
  `TerminalError` for failures that retrying cannot fix, or set a
  `retryPolicy`.
