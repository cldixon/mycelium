// The Worker <-> runner protocol version, stamped on every response. Must equal
// RUNNER_PROTOCOL in instance/src/shared/jobs.ts (a test checks). It lives here
// as a value because the image's build context is runner/ only: the runner may
// import types from the instance, never values.
export const RUNNER_PROTOCOL = 2;
export const PROTOCOL_HEADER = "x-mycelium-runner-protocol";
