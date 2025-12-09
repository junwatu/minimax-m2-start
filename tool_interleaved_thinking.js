// Node.js equivalent of your Python example
// npm install anthropic
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: 'https://api.minimax.io/anthropic',
});

// Define tool: weather query
const tools = [
    {
        name: "get_weather",
        description:
            "Get weather of a location, the user should supply a location first.",
        input_schema: {
            type: "object",
            properties: {
                location: {
                    type: "string",
                    description: "The city and state, e.g. San Francisco, US",
                },
            },
            required: ["location"],
        },
    },
];

async function sendMessages(messages) {
    const params = {
        model: "MiniMax-M2",
        max_tokens: 4096,
        messages,
        tools,
    };

    // create() returns the model response object (structure matches your Python example)
    const response = await client.messages.create(params);
    return response;
}

function processResponse(response) {
    const thinkingBlocks = [];
    const textBlocks = [];
    const toolUseBlocks = [];

    // response.content is expected to be an array of blocks (thinking/text/tool_use)
    for (const block of response.content || []) {
        if (block.type === "thinking") {
            thinkingBlocks.push(block);
            console.log("💭 Thinking>\n", block.thinking, "\n");
        } else if (block.type === "text") {
            textBlocks.push(block);
            console.log("💬 Model>\t", block.text);
        } else if (block.type === "tool_use") {
            toolUseBlocks.push(block);
            console.log(
                "🔧 Tool>\t",
                `${block.name}(${JSON.stringify(block.input, null, 2)})`
            );
        } else {
            // Unknown block type: print for debugging
            console.log("ℹ️ Unknown block type:", block);
        }
    }

    return { thinkingBlocks, textBlocks, toolUseBlocks };
}

(async function main() {
    try {
        // 1. User query
        const messages = [{ role: "user", content: "How's the weather in San Francisco?" }];
        console.log("\n👤 User>\t", messages[0].content);

        // 2. Model returns first response (may include tool calls)
        const response = await sendMessages(messages);
        const { toolUseBlocks } = processResponse(response);

        // 3. If tool calls exist, execute tools and continue conversation
        if (toolUseBlocks && toolUseBlocks.length > 0) {
            // ⚠️ Critical: append the assistant's complete response to message history
            // Keep the content exactly as returned (array of content blocks)
            messages.push({
                role: "assistant",
                content: response.content,
            });

            // Execute tool and return result (simulate calling a real weather API)
            console.log(`\n🔨 Executing tool: ${toolUseBlocks[0].name}`);
            const toolResult = "24℃, sunny";
            console.log("📊 Tool result:", toolResult);

            // Add tool execution result as a special user message with tool_result
            messages.push({
                role: "user",
                content: [
                    {
                        type: "tool_result",
                        tool_use_id: toolUseBlocks[0].id,
                        content: toolResult,
                    },
                ],
            });

            // 4. Get final response
            const finalResponse = await sendMessages(messages);
            processResponse(finalResponse);
        } else {
            console.log("No tool calls from model. Conversation ends here.");
        }
    } catch (err) {
        console.error("Error:", err);
    }
})();
