import { Agent, run } from "@openai/agents";
import { createAnthropic } from "@ai-sdk/anthropic";
import { aisdk } from "@openai/agents-extensions";
import { elevenlabs } from "@ai-sdk/elevenlabs";
import { experimental_generateSpeech as generateSpeech } from 'ai';
import { createHash } from 'crypto';

const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: "https://api.minimax.io/anthropic/v1",
});



const model = aisdk(anthropic("minimax-m2.1") as any);



const podcastAgent = new Agent({
  name: "Podcast Generator AI",
  instructions: `You are a podcast generator AI. Your task is to:

1. Use the fetch_article tool to retrieve the full article content from the provided URL.

2. Analyze and summarize the article into a dynamic podcast script, written as a simple natural dialogue between two speakers (Speaker A and Speaker B) and MUST BE less than 10000 characters

Speaker A acts as the host: introduces the topic, asks questions, and drives the flow.

Speaker B acts as the guest or expert: explains, elaborates, and adds insights.

Keep the exchange conversational and lively, with natural back-and-forth, clarifications, and reactions.

3. IMPORTANT: After creating the script, you MUST call the generate_speech tool with the dialogue formatted as an array of objects. Each object should have 'text' and 'voice_id' fields.

Use these voice IDs:
- Speaker A (Host): gmnazjXOFoOcWA59sd5m
- Speaker B (Guest): 1kNciG1jHVSuFBPoxdRZ

Always alternate speakers (A → B → A → B) and ensure the dialogue flows naturally.`,
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
        model_id: "eleven_turbo_v2", // Faster model
        voice_settings: {
          stability: 0.75, // Higher stability = faster processing
          similarity_boost: 0.25,
          style: 0.0, // Disable style for speed
        },
        optimize_streaming_latency: 2, // Optimize for speed
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

// Simple in-memory cache for audio generation
const audioCache = new Map<string, Buffer>();

function getScriptHash(script: string): string {
  return createHash('md5').update(script).digest('hex');
}

async function generatePodcastAudioWithRetry(script: string, maxRetries: number = 3): Promise<Buffer> {
  const voiceId = process.env.ELEVENLABS_VOICE_ID || "rachel";
  
  // Check cache first
  const cacheKey = getScriptHash(script + voiceId);
  if (audioCache.has(cacheKey)) {
    console.log("🎯 Using cached audio...");
    return audioCache.get(cacheKey)!;
  }
  
  // Optimize script for ElevenLabs 10,000 character limit
  const maxLength = 9900; // Leave some buffer
  const optimizedScript = await optimizeScriptForAudio(script, maxLength);
  
  let lastError: Error | null = null;
  let audioBuffer: Buffer | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`🎵 Audio generation attempt ${attempt}/${maxRetries}`);
    
    try {
      // Try AI SDK first
      const result = await generateSpeechWithProgress(optimizedScript, voiceId);
      
      if (result.success && result.audio) {
        console.log(`✅ Audio generation successful on attempt ${attempt}`);
        audioBuffer = result.audio;
        break;
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
          audioBuffer = await generatePodcastAudioDirectAPI(optimizedScript, voiceId);
          break;
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
  
  if (!audioBuffer) {
    throw new Error(`Audio generation failed after ${maxRetries} attempts. Last error: ${lastError?.message}`);
  }
  
  // Cache the result
  audioCache.set(cacheKey, audioBuffer);
  return audioBuffer;
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
        model: elevenlabs.speech('eleven_turbo_v2'),
        text: script,
        voice: voiceId,
        providerOptions: {
          elevenlabs: {
            voiceSettings: {
              stability: 0.75,
              similarity_boost: 0.25,
            },
            optimize_streaming_latency: 2,
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
  // Try segmented generation first for long scripts
  if (script.length > 3000) {
    console.log("🎯 Using segmented audio generation for better performance...");
    return await generateSegmentedAudio(script);
  }
  return generatePodcastAudioWithRetry(script, 3);
}

async function generateSegmentedAudio(script: string): Promise<Buffer> {
  const maxSegmentLength = 2500; // Optimal chunk size
  const segments: string[] = [];
  
  // Split script into sentences and create segments
  const sentences = script.match(/[^.!?]+[.!?]+/g) || [script];
  let currentSegment = "";
  
  for (const sentence of sentences) {
    if (currentSegment.length + sentence.length > maxSegmentLength && currentSegment) {
      segments.push(currentSegment.trim());
      currentSegment = sentence;
    } else {
      currentSegment += sentence;
    }
  }
  
  if (currentSegment) {
    segments.push(currentSegment.trim());
  }
  
  console.log(`🎵 Generating ${segments.length} audio segments in parallel...`);
  
  // Generate audio for segments in parallel
  const audioPromises = segments.map(async (segment, index) => {
    console.log(`🎙️ Segment ${index + 1}/${segments.length} (${segment.length} chars)`);
    return await generatePodcastAudioWithRetry(segment, 2);
  });
  
  try {
    const audioBuffers = await Promise.all(audioPromises);
    
    // Concatenate audio buffers
    const totalLength = audioBuffers.reduce((sum, buffer) => sum + buffer.length, 0);
    const concatenatedBuffer = Buffer.concat(audioBuffers, totalLength);
    
    console.log(`✅ Segmented audio complete: ${concatenatedBuffer.length} bytes`);
    return concatenatedBuffer;
    
  } catch (error) {
    console.log("❌ Segmented generation failed, falling back to single segment...");
    return generatePodcastAudioWithRetry(script, 2);
  }
}

async function createPodcastFromUrl(articleUrl: string, generateAudio: boolean = true): Promise<{ script: string; audio: Buffer; dialogue?: Array<{ text: string; voice_id: string }> }> {
  console.log("🎙️ Creating podcast using AGENTS.md format...");
  
  try {
    const articleContent = await fetchArticleContent(articleUrl);
    console.log("✅ Article content fetched successfully!");
    
    const result = await run(
      podcastAgent,
      `Please create a podcast script from this article content following the exact format specified:

ARTICLE CONTENT:
${articleContent}

REQUIREMENTS:
1. Create a dialogue between Speaker A (Host) and Speaker B (Guest)
2. MUST be less than 10,000 characters total
3. Format as JSON with this structure:
{
  "dialogue": [
    {"text": "Speaker A line", "voice_id": "gmnazjXOFoOcWA59sd5m"},
    {"text": "Speaker B line", "voice_id": "1kNciG1jHVSuFBPoxdRZ"}
  ]
}

4. Always alternate speakers (A → B → A → B)
5. Keep it conversational and lively
6. Speaker A introduces topics and asks questions
7. Speaker B explains and provides insights

Return ONLY the JSON format, no explanations.`
    );

    // Extract the JSON dialogue from the result
    const resultObj = result as any;
    const agentOutput = resultObj.state?._currentStep?.output || 
                       resultObj.state?._lastTurnResponse?.output?.[0]?.content ||
                       String(result);
    
    let dialogueData: Array<{ text: string; voice_id: string }>;
    let script: string;
    
    try {
      // Clean up the output - remove markdown code blocks if present
      let cleanOutput = agentOutput.trim();
      
      // Remove markdown code blocks
      if (cleanOutput.startsWith('```json')) {
        cleanOutput = cleanOutput.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (cleanOutput.startsWith('```')) {
        cleanOutput = cleanOutput.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }
      
      // Try to parse as JSON
      const jsonData = JSON.parse(cleanOutput);
      dialogueData = jsonData.dialogue;
      
      // Validate dialogue format meets AGENTS.md spec
      const validation = validateDialogueFormat(dialogueData);
      if (!validation.isValid) {
        console.log("⚠️ Dialogue format validation failed:", validation.errors);
        console.log("🔄 Attempting to fix format...");
        dialogueData = fixDialogueFormat(dialogueData);
      }
      
      script = dialogueData.map(item => item.text).join('\n\n');
      console.log("✅ JSON dialogue format parsed successfully!");
      console.log(`📝 Generated ${dialogueData.length} dialogue lines`);
      console.log(`🎭 Speakers: Speaker A (${dialogueData.filter((_, i) => i % 2 === 0).length} lines), Speaker B (${dialogueData.filter((_, i) => i % 2 === 1).length} lines)`);
    } catch (parseError) {
      // Fallback: treat as plain text script
      console.log("⚠️ JSON parse failed, using text format...");
      console.log("Parse error:", parseError.message);
      script = agentOutput;
      dialogueData = convertTextToDialogue(script);
    }
    
    console.log(`📝 Script generated: ${script.length} characters`);
    
    let audio: Buffer;
    
    if (generateAudio && dialogueData.length > 0) {
      console.log("🎵 Generating audio using ElevenLabs with dual voices...");
      
      // Generate audio for each dialogue segment with appropriate voice
      const audioSegments = await Promise.all(
        dialogueData.map(async (item) => {
          try {
            return await generatePodcastAudioWithVoice(item.text, item.voice_id);
          } catch (error) {
            console.log(`❌ Failed to generate audio for: ${item.text.substring(0, 50)}...`);
            return null;
          }
        })
      );
      
      // Filter out failed segments and concatenate
      const validSegments = audioSegments.filter(segment => segment !== null) as Buffer[];
      if (validSegments.length > 0) {
        audio = Buffer.concat(validSegments);
        console.log(`✅ Multi-voice audio generated: ${audio.length} bytes from ${validSegments.length} segments`);
      } else {
        throw new Error("All audio segments failed to generate");
      }
    } else if (generateAudio) {
      // Fallback to single voice if no dialogue data
      console.log("🎵 Generating audio with single voice fallback...");
      audio = await generatePodcastAudio(script);
    } else {
      console.log("📝 Skipping audio generation...");
      audio = Buffer.from("");
    }
    
    return { script, audio, dialogue: dialogueData };
  } catch (error) {
    console.error("❌ Error in createPodcastFromUrl:", error);
    throw error;
  }
}

// Validate dialogue format according to AGENTS.md spec
function validateDialogueFormat(dialogue: Array<{ text: string; voice_id: string }>) {
  const errors: string[] = [];
  
  // Check voice IDs match AGENTS.md specification
  const speakerAVoiceId = 'gmnazjXOFoOcWA59sd5m';
  const speakerBVoiceId = '1kNciG1jHVSuFBPoxdRZ';
  
  for (let i = 0; i < dialogue.length; i++) {
    const item = dialogue[i];
    const expectedVoiceId = i % 2 === 0 ? speakerAVoiceId : speakerBVoiceId;
    const speakerName = i % 2 === 0 ? 'Speaker A' : 'Speaker B';
    
    if (item.voice_id !== expectedVoiceId) {
      errors.push(`Line ${i + 1}: ${speakerName} should use voice_id "${expectedVoiceId}", got "${item.voice_id}"`);
    }
    
    if (!item.text || item.text.trim().length === 0) {
      errors.push(`Line ${i + 1}: Empty text content`);
    }
  }
  
  // Check character count
  const totalChars = dialogue.reduce((sum, item) => sum + item.text.length, 0);
  if (totalChars > 10000) {
    errors.push(`Total character count ${totalChars} exceeds 10,000 limit`);
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    totalChars,
    lineCount: dialogue.length
  };
}

// Fix dialogue format issues
function fixDialogueFormat(dialogue: Array<{ text: string; voice_id: string }>) {
  const speakerAVoiceId = 'gmnazjXOFoOcWA59sd5m';
  const speakerBVoiceId = '1kNciG1jHVSuFBPoxdRZ';
  
  return dialogue.map((item, index) => ({
    text: item.text,
    voice_id: index % 2 === 0 ? speakerAVoiceId : speakerBVoiceId
  }));
}

// Helper function to convert plain text to dialogue format
function convertTextToDialogue(text: string): Array<{ text: string; voice_id: string }> {
  const lines = text.split('\n').filter(line => line.trim().length > 0);
  const dialogue: Array<{ text: string; voice_id: string }> = [];
  
  let speaker = 'A'; // Alternate between A and B
  
  for (const line of lines) {
    if (line.trim()) {
      const voiceId = speaker === 'A' ? 'gmnazjXOFoOcWA59sd5m' : '1kNciG1jHVSuFBPoxdRZ';
      dialogue.push({ text: line.trim(), voice_id: voiceId });
      speaker = speaker === 'A' ? 'B' : 'A';
    }
  }
  
  return dialogue;
}

// Generate audio with specific voice ID
async function generatePodcastAudioWithVoice(text: string, voiceId: string): Promise<Buffer> {
  // Create a modified version of the audio generation function that uses specific voice
  const maxSegmentLength = 2500;
  
  if (text.length > maxSegmentLength) {
    const segments = splitTextIntoSegments(text, maxSegmentLength);
    console.log(`🎵 Generating ${segments.length} segments for voice ${voiceId}`);
    
    const audioPromises = segments.map(async (segment, index) => {
      console.log(`🎙️ Segment ${index + 1}/${segments.length} (${segment.length} chars)`);
      return await generateAudioSegment(segment, voiceId);
    });
    
    const audioBuffers = await Promise.all(audioPromises);
    return Buffer.concat(audioBuffers);
  }
  
  return await generateAudioSegment(text, voiceId);
}

// Generate a single audio segment with specific voice
async function generateAudioSegment(text: string, voiceId: string): Promise<Buffer> {
  try {
    // Use direct API for better control over voice ID
    return await generatePodcastAudioDirectAPI(text, voiceId);
  } catch (error) {
    console.log(`❌ Direct API failed for ${voiceId}, trying AI SDK...`);
    // Fallback to AI SDK approach
    const result = await generateSpeechWithProgress(text, voiceId);
    if (result.success && result.audio) {
      return result.audio;
    }
    throw new Error(`Audio generation failed for voice ${voiceId}`);
  }
}

// Split text into segments for processing
function splitTextIntoSegments(text: string, maxLength: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  const segments: string[] = [];
  let currentSegment = "";
  
  for (const sentence of sentences) {
    if (currentSegment.length + sentence.length > maxLength && currentSegment) {
      segments.push(currentSegment.trim());
      currentSegment = sentence;
    } else {
      currentSegment += sentence;
    }
  }
  
  if (currentSegment) {
    segments.push(currentSegment.trim());
  }
  
  return segments;
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
    const { script, audio, dialogue } = await createPodcastFromUrl(articleUrl, mode === "all");
    const totalTime = Date.now() - startTime;
    
console.log(`⏱️ Total process completed in ${totalTime/1000}s`);
    
    // Always save script
    const fs = await import("fs/promises");
    await fs.writeFile("podcast-script.txt", script);
    console.log("📄 Podcast script saved as podcast-script.txt");
    
    // Save dialogue JSON if available
    if (dialogue && dialogue.length > 0) {
      await fs.writeFile("podcast-dialogue.json", JSON.stringify({ dialogue }, null, 2));
      console.log("📄 Podcast dialogue saved as podcast-dialogue.json");
    }
    
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