import { readFileSync } from "node:fs";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

const requiredPhrases = [
  "The handshake between coding agents.",
  "Required-response queues and completion gates",
  "Coordination, not orchestration",
  "No `agentq.config.yaml`",
  "No default repo `.agentq/`"
];

const missing = requiredPhrases.filter((phrase) => !readme.includes(phrase));

if (missing.length > 0) {
  throw new Error(`README is missing required AgentQ positioning text: ${missing.join(", ")}`);
}
