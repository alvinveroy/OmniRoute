import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const chatCore = readFileSync(
  fileURLToPath(new URL("../../../open-sse/handlers/chatCore.ts", import.meta.url)),
  "utf8"
);
const jevPlan = readFileSync(
  fileURLToPath(new URL("../../../open-sse/services/compression/jevPlan.ts", import.meta.url)),
  "utf8"
);

// The fork resolves the plan (and its adaptive inputs) inside jevPlan.ts so the
// Jev refinement and the adaptive escalation share one owner; chatCore only
// consumes the result. Assert the same wiring at its real location.
test("the plan resolver threads modelContextLimit + requestMaxTokens into selectCompressionPlan", () => {
  assert.match(jevPlan, /modelContextLimit,/);
  assert.match(jevPlan, /requestMaxTokens,/);
});

test("chatCore takes the adaptive telemetry from the resolver result", () => {
  assert.match(chatCore, /compressionResolution\.telemetry/);
  assert.match(chatCore, /adaptiveTelemetry/);
});
