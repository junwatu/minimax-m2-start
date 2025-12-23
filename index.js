import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: "https://api.minimax.io/anthropic",
});

async function main() {
  try {
    const message = await anthropic.messages.create({
      model: "Minimax-M2.1",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hi, what model are you?" }],
    });

    console.log(message.content);
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      console.error(error.status); // 400
      console.error(error.name); // BadRequestError
      console.error(error.headers); // {server: 'nginx', ...}
    } else {
      throw error;
    }
  }
}

main();
