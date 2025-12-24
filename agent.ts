import { Agent, run } from "@openai/agents";
import { createAnthropic } from "@ai-sdk/anthropic";
import { aisdk } from "@openai/agents-extensions";

const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: "https://api.minimax.io/anthropic/v1",
});

const model = aisdk(anthropic("minimax-m2.1") as any);

const agent = new Agent({
  name: "Language Agent",
  instructions: "You are a professional language translator assistant.",
  model,
});

const result = await run(
  agent,
  'What is the Indonessian translation of "Hello, world"?',
);

console.log(result);
