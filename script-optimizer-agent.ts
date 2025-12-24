import { Agent, run } from "@openai/agents";
import { createAnthropic } from "@ai-sdk/anthropic";
import { aisdk } from "@openai/agents-extensions";

const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: "https://api.minimax.io/anthropic/v1",
});

const model = aisdk(anthropic("minimax-m2.1") as any);

const scriptOptimizerAgent = new Agent({
  name: "Script Optimizer Agent",
  instructions: `You are a professional script editor specializing in content optimization for audio production. Your task is to:

1. Analyze podcast scripts to ensure they meet character limits
2. Shorten scripts while preserving ALL essential information, context, and key points
3. Maintain the conversational flow and engaging tone
4. Keep the structure (intro, main content, conclusion) intact
5. Ensure no important details, examples, or insights are lost
6. Optimize for spoken delivery - remove redundancy but keep impact

When shortening scripts:
- Prioritize keeping concrete examples and data
- Maintain emotional impact and storytelling elements
- Preserve expert quotes and key insights
- Keep transitions smooth and natural
- Remove filler words and repetitive phrases
- Combine related points when possible
- Never sacrifice clarity for brevity

The goal is maximum information density with minimum character count while maintaining engagement.`,
  model,
});

async function optimizeScriptForAudio(script: string, targetLength: number = 9900): Promise<string> {
  const currentLength = script.length;
  
  if (currentLength <= targetLength) {
    console.log(`Script is already within limit: ${currentLength} characters`);
    return script;
  }
  
  console.log(`Optimizing script: ${currentLength} -> ${targetLength} characters (need to remove ${currentLength - targetLength} chars)`);
  
  const result = await run(
    scriptOptimizerAgent,
    `Please optimize this podcast script to meet a strict ${targetLength} character limit while preserving all essential content and context:

ORIGINAL SCRIPT (${currentLength} characters):
${script}

REQUIREMENTS:
- Target length: ${targetLength} characters maximum
- Preserve ALL key points, data, examples, and insights
- Maintain conversational tone and flow
- Keep intro, main content, and conclusion structure
- Remove only filler content and redundancy
- Ensure no important information is lost

Return the optimized script only, no explanations.`
  );

  // Extract the optimized script from the result
  const resultObj = result as any;
  const optimizedScript = resultObj.state?._currentStep?.output || 
                         resultObj.state?._lastTurnResponse?.output?.[0]?.content ||
                         String(result);

  const finalLength = optimizedScript.length;
  console.log(`Optimization complete: ${currentLength} -> ${finalLength} characters`);
  
  if (finalLength > targetLength) {
    console.log(`Warning: Optimized script still exceeds limit by ${finalLength - targetLength} characters`);
    // If still too long, do a final truncation
    const finalScript = optimizedScript.substring(0, targetLength - 50) + "...[truncated for audio]";
    console.log(`Final truncation applied: ${finalScript.length} characters`);
    return finalScript;
  }
  
  return optimizedScript;
}

async function main() {
  const scriptFile = process.argv[2];
  const targetLength = parseInt(process.argv[3]) || 9900;
  
  if (!scriptFile) {
    console.error("Please provide a script file path");
    console.log("Usage: npm run optimize-script <script-file> [target-length]");
    console.log("Example: npm run optimize-script podcast-script.txt 9900");
    process.exit(1);
  }

  try {
    // Read the script file
    const fs = await import("fs/promises");
    const script = await fs.readFile(scriptFile, 'utf-8');
    
    console.log(`Loaded script: ${script.length} characters`);
    
    // Optimize the script
    const optimizedScript = await optimizeScriptForAudio(script, targetLength);
    
    // Save the optimized script
    const outputFile = scriptFile.replace('.txt', '-optimized.txt');
    await fs.writeFile(outputFile, optimizedScript);
    console.log(`Optimized script saved as: ${outputFile}`);
    
    // Show comparison
    console.log(`\n=== OPTIMIZATION SUMMARY ===`);
    console.log(`Original: ${script.length} characters`);
    console.log(`Optimized: ${optimizedScript.length} characters`);
    console.log(`Reduced by: ${script.length - optimizedScript.length} characters (${((script.length - optimizedScript.length) / script.length * 100).toFixed(1)}%)`);
    console.log(`============================`);
    
  } catch (error) {
    console.error("Error optimizing script:", error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}