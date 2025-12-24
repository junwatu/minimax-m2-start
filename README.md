# Minimax M2 using Anthropic SDK Example

## Clone the code
```bash
git clone https://github.com/junwatu/minimax-m2-start.git
```

## Create .env
```bash
cp .env.example .env
```

## Fill the .env file

Get your API key from https://platform.minimax.io and fill it in the .env file

```bash
MINIMAX_M2_API_KEY=your_api_key
ANTHROPIC_API_KEY=$MINIMAX_M2_API_KEY
ELEVENLABS_API_KEY=your_elevenlabs_api_key
ELEVENLABS_VOICE_ID=rachel
```

## Install dependencies

First install pnpm if you haven't installed it yet

```bash
npm install -g pnpm
```

Then install dependencies

```bash
pnpm install
```

## Available Scripts

### 1. Basic Agent
```bash
pnpm run agent
```
Runs a simple translation agent using Minimax M2.1.

### 2. Podcast Generator
```bash
# Generate both script and audio
pnpm run podcast <article-url> all

# Generate script only (faster)
pnpm run podcast-script <article-url> script
```
Transforms web articles into professional podcast scripts with optional audio generation using ElevenLabs.

### 3. Script Optimizer
```bash
pnpm run optimize-script <script-file> [target-length]
```
Optimizes podcast scripts to meet character limits while preserving essential content.

**Examples:**
```bash
# Generate full podcast from article
pnpm run podcast "https://techcrunch.com/2025/12/22/openai-says-ai-browsers-may-always-be-vulnerable-to-prompt-injection-attacks/" all

# Generate script only
pnpm run podcast-script "https://example.com/article" script

# Optimize script for 10,000 character limit
pnpm run optimize-script podcast-script.txt 9900
```

## Features

- **AI-Powered Script Generation**: Uses Minimax M2.1 to create engaging podcast scripts
- **Audio Synthesis**: Converts scripts to high-quality audio using ElevenLabs
- **Smart Optimization**: Automatically handles character limits with content preservation
- **Dual Modes**: Script-only or full podcast generation
- **Professional Output**: Structured scripts with intros, main content, and conclusions

## Run the code
```bash
pnpm run start
```

