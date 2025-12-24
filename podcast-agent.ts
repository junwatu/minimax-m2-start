import { Agent, run } from "@openai/agents";
import { createAnthropic } from "@ai-sdk/anthropic";
import { aisdk } from "@openai/agents-extensions";
import { elevenlabs } from "@ai-sdk/elevenlabs";
import { experimental_generateSpeech as generateSpeech } from 'ai';

const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: "https://api.minimax.io/anthropic/v1",
});



const model = aisdk(anthropic("minimax-m2.1") as any);

const podcastAgent = new Agent({
  name: "Podcast Agent",
  instructions: `You are a professional podcast script creator. Your task is to:
1. Transform article content into an engaging podcast script
2. The script should be conversational, engaging, and suitable for audio narration
3. Include proper pacing, transitions, and natural language flow
4. Structure the script with an introduction, main content, and conclusion
5. Keep the language natural and easy to understand when spoken`,
  model,
});

async function fetchArticleContent(url: string): Promise<string> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const html = await response.text();
    
    // Simple extraction of text content (basic approach)
    const textMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (textMatch) {
      // Remove HTML tags
      let text = textMatch[1].replace(/<[^>]*>/g, ' ');
      // Clean up whitespace
      text = text.replace(/\s+/g, ' ').trim();
      return text.substring(0, 10000); // Limit length
    }
    throw new Error('Could not extract content from HTML');
  } catch (error) {
    throw new Error(`Failed to fetch article: ${error.message}`);
  }
}

async function optimizeScriptForAudio(script: string, targetLength: number = 9900): Promise<string> {
  const currentLength = script.length;
  
  if (currentLength <= targetLength) {
    return script;
  }
  
  console.log(`Optimizing script for audio: ${currentLength} -> ${targetLength} characters`);
  
  const result = await run(
    podcastAgent,
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
  console.log(`Script optimization: ${currentLength} -> ${finalLength} characters`);
  
  if (finalLength > targetLength) {
    console.log(`Warning: Optimized script still exceeds limit, applying final truncation`);
    return optimizedScript.substring(0, targetLength - 50) + "...[truncated for audio]";
  }
  
  return optimizedScript;
}

interface AudioGenerationResult {
  success: boolean;
  audio?: Buffer;
  error?: string;
  requestId?: string;
  status?: string;
}

async function generatePodcastAudioDirectAPI(script: string, voiceId: string): Promise<Buffer> {
  console.log("🔄 Falling back to direct ElevenLabs API...");
  
  const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
  
  if (!elevenLabsApiKey) {
    throw new Error("ELEVENLABS_API_KEY environment variable is required");
  }

  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: "POST",
      headers: {
        "Accept": "audio/mpeg",
        "Content-Type": "application/json",
        "xi-api-key": elevenLabsApiKey,
      },
      body: JSON.stringify({
        text: script,
        model_id: "eleven_monolingual_v1",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.5,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ElevenLabs API error: ${response.status} - ${errorText}`);
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  console.log(`✅ Direct API audio generated: ${audioBuffer.length} bytes`);
  
  return audioBuffer;
}

async function generatePodcastAudioWithRetry(script: string, maxRetries: number = 3): Promise<Buffer> {
  const voiceId = process.env.ELEVENLABS_VOICE_ID || "rachel";
  
  // Optimize script for ElevenLabs 10,000 character limit
  const maxLength = 9900; // Leave some buffer
  const optimizedScript = await optimizeScriptForAudio(script, maxLength);
  
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`🎵 Audio generation attempt ${attempt}/${maxRetries}`);
    
    try {
      // Try AI SDK first
      const result = await generateSpeechWithProgress(optimizedScript, voiceId);
      
      if (result.success && result.audio) {
        console.log(`✅ Audio generation successful on attempt ${attempt}`);
        return result.audio;
      } else {
        throw new Error(result.error || 'Audio generation failed');
      }
      
    } catch (error) {
      lastError = error as Error;
      console.log(`❌ AI SDK attempt ${attempt} failed: ${error.message}`);
      
      // If AI SDK fails, try direct API on last attempt or if it's a timeout
      if (attempt === maxRetries || error.message.includes('timeout')) {
        console.log("🔄 Trying direct ElevenLabs API as fallback...");
        try {
          return await generatePodcastAudioDirectAPI(optimizedScript, voiceId);
        } catch (directError) {
          console.log(`❌ Direct API also failed: ${directError.message}`);
          lastError = directError as Error;
        }
      }
      
      if (attempt < maxRetries) {
        const delay = Math.min(5000 * attempt, 15000); // Exponential backoff, max 15s
        console.log(`⏳ Retrying in ${delay/1000} seconds...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw new Error(`Audio generation failed after ${maxRetries} attempts. Last error: ${lastError?.message}`);
}

async function generateSpeechWithProgress(script: string, voiceId: string): Promise<AudioGenerationResult> {
  const startTime = Date.now();
  const timeoutMs = 300000; // 5 minutes timeout for longer scripts
  
  console.log(`🎵 Starting audio generation (${script.length} chars)...`);
  
  // Progress indicator
  let lastProgress = 0;
  const progressInterval = setInterval(() => {
    const elapsed = Date.now() - startTime;
    const currentProgress = Math.floor(elapsed/1000);
    
    // Only log every 15 seconds to reduce spam
    if (currentProgress - lastProgress >= 15) {
      console.log(`⏳ Audio generation in progress... (${currentProgress}s elapsed)`);
      lastProgress = currentProgress;
    }
  }, 5000); // Check every 5 seconds, log every 15
  
  try {
    // Use a wrapper that handles the promise properly
    const audioPromise = new Promise((resolve, reject) => {
      generateSpeech({
        model: elevenlabs.speech('eleven_multilingual_v2'),
        text: script,
        voice: voiceId,
        providerOptions: {
          elevenlabs: {
            voiceSettings: {
              stability: 0.5,
              similarity_boost: 0.5,
            },
          },
        },
      }).then(resolve).catch(reject);
    });

    // Create a timeout promise with better error handling
    const timeoutPromise = new Promise<AudioGenerationResult>((_, reject) => {
      setTimeout(() => {
        clearInterval(progressInterval);
        console.log(`⏰ Timeout reached after ${timeoutMs/1000}s`);
        reject(new Error(`Audio generation timeout after ${timeoutMs/1000}s`));
      }, timeoutMs);
    });

    // Race between audio generation and timeout
    const result = await Promise.race([audioPromise, timeoutPromise]) as any;
    
    clearInterval(progressInterval);
    const duration = Date.now() - startTime;
    console.log(`✅ Audio generation completed in ${duration/1000}s`);
    
    // Extract audio data from the result
    const audioData = result.audio as any;
    
    if (!audioData) {
      return {
        success: false,
        error: 'No audio data in response'
      };
    }
    
    // Handle the DefaultGeneratedAudioFile format
    if (audioData.uint8ArrayData) {
      const uint8Data = audioData.uint8ArrayData;
      const length = Math.max(...Object.keys(uint8Data).map(key => parseInt(key))) + 1;
      const audioArray = new Uint8Array(length);
      
      for (const key in uint8Data) {
        audioArray[parseInt(key)] = uint8Data[key];
      }
      
      const audioBuffer = Buffer.from(audioArray);
      console.log(`🎧 Audio generated: ${audioBuffer.length} bytes`);
      
      return {
        success: true,
        audio: audioBuffer
      };
    }
    
    // Fallback for other formats
    if (Buffer.isBuffer(audioData)) {
      console.log(`🎧 Audio generated (Buffer): ${audioData.length} bytes`);
      return { success: true, audio: audioData };
    }
    
    if (audioData instanceof Uint8Array) {
      const audioBuffer = Buffer.from(audioData);
      console.log(`🎧 Audio generated (Uint8Array): ${audioBuffer.length} bytes`);
      return { success: true, audio: audioBuffer };
    }
    
    return {
      success: false,
      error: 'Unsupported audio format from ElevenLabs'
    };
    
  } catch (error) {
    clearInterval(progressInterval);
    const duration = Date.now() - startTime;
    console.log(`❌ Audio generation failed after ${duration/1000}s: ${error.message}`);
    
    return {
      success: false,
      error: error.message
    };
  }
}

async function generatePodcastAudio(script: string): Promise<Buffer> {
  return generatePodcastAudioWithRetry(script, 3);
}

async function createPodcastFromUrl(articleUrl: string, generateAudio: boolean = true): Promise<{ script: string; audio: Buffer }> {
  console.log("Fetching article content...");
  
  try {
    const articleContent = await fetchArticleContent(articleUrl);
    console.log("Article content fetched successfully!");
    
    const result = await run(
      podcastAgent,
      `Transform the following article content into an engaging podcast script suitable for audio narration:

ARTICLE CONTENT:
${articleContent}

Please create a conversational podcast script with:
1. An engaging introduction
2. Main content with clear explanations
3. A thoughtful conclusion
4. Natural language that flows well when spoken aloud`
    );

    // Extract the text content from the result - it's in _currentStep.output
    const resultObj = result as any;
    const script = resultObj.state?._currentStep?.output || 
                  resultObj.state?._lastTurnResponse?.output?.[0]?.content ||
                  "Podcast script generation failed - please check agent output";
    console.log("Podcast script generated successfully!");
    
    let audio: Buffer;
    
    if (generateAudio) {
      console.log("Converting script to audio using ElevenLabs...");
      audio = await generatePodcastAudio(script);
      console.log("Audio generated successfully!");
    } else {
      console.log("Skipping audio generation...");
      audio = Buffer.from(""); // Empty buffer for script-only mode
    }
    
    return { script, audio };
  } catch (error) {
    console.error("Error in createPodcastFromUrl:", error);
    throw error;
  }
}

async function savePodcastAudio(audio: Buffer, filename: string = "podcast.mp3"): Promise<void> {
  try {
    const fs = await import("fs/promises");
    await fs.writeFile(filename, audio);
    
    // Verify the file was created and has content
    const stats = await fs.stat(filename);
    console.log(`✅ Podcast saved as ${filename} (${stats.size} bytes)`);
    
    if (stats.size === 0) {
      throw new Error('Audio file is empty');
    }
    
  } catch (error) {
    throw new Error(`Failed to save audio file: ${error.message}`);
  }
}

async function verifyAudioFile(filename: string): Promise<boolean> {
  try {
    const fs = await import("fs/promises");
    const stats = await fs.stat(filename);
    
    // Check if file exists and has reasonable size (at least 1KB)
    return stats.size > 1024;
  } catch {
    return false;
  }
}

// Main execution
async function main() {
  const articleUrl = process.argv[2];
  const mode = process.argv[3] || "all"; // "script" or "all" (default)
  
  if (!articleUrl) {
    console.error("Please provide an article URL as argument");
    console.log("Usage: npm run podcast <article-url> [mode]");
    console.log("Modes:");
    console.log("  script - Generate only podcast script");
    console.log("  all    - Generate script and audio (default)");
    process.exit(1);
  }

  if (mode !== "script" && mode !== "all") {
    console.error("Invalid mode. Use 'script' or 'all'");
    process.exit(1);
  }

  try {
    console.log(`🎙️ Mode: ${mode === "script" ? "Script only" : "Script + Audio"}`);
    console.log(`📊 Starting podcast generation process...`);
    
    const startTime = Date.now();
    const { script, audio } = await createPodcastFromUrl(articleUrl, mode === "all");
    const totalTime = Date.now() - startTime;
    
console.log(`⏱️ Total process completed in ${totalTime/1000}s`);
    
    // Always save script
    const fs = await import("fs/promises");
    await fs.writeFile("podcast-script.txt", script);
    console.log("📄 Podcast script saved as podcast-script.txt");
    
    // Save audio only if mode is "all"
    if (mode === "all") {
      console.log("🎵 Saving audio file...");
      try {
        await savePodcastAudio(audio);
        
        // Verify the audio file was created successfully
        if (await verifyAudioFile("podcast.mp3")) {
          console.log("✅ Audio file verification successful");
        } else {
          console.log("⚠️ Warning: Audio file verification failed");
        }
      } catch (saveError) {
        console.log(`❌ Failed to save audio: ${saveError.message}`);
      }
    } else {
      console.log("📝 Audio generation skipped (script-only mode)");
    }
    
    // Final summary
    console.log("\n📋 PROCESS SUMMARY ===");
    console.log(`📄 Script: ${script.length} characters`);
    if (mode === "all" && audio) {
      console.log(`🎵 Audio: ${audio.length} bytes`);
    }
    console.log(`📁 Files: podcast-script.txt${mode === "all" ? ", podcast.mp3" : ""}`);
    console.log("==================");
    
    console.log("\n=== PODCAST SCRIPT PREVIEW ===");
    console.log(script.substring(0, 1000) + (script.length > 1000 ? "..." : ""));
    console.log("==============================");
    
  } catch (error) {
    console.error("Error creating podcast:", error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}