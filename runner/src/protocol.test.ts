import { expect, test } from "bun:test";
import * as instance from "../../instance/src/shared/jobs.ts";
import * as runner from "./protocol.ts";

test("runner and instance agree on the protocol version", () => {
  expect(runner.RUNNER_PROTOCOL).toBe(instance.RUNNER_PROTOCOL);
  expect(runner.PROTOCOL_HEADER).toBe(instance.PROTOCOL_HEADER);
});
