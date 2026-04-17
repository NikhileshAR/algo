import { z } from "zod";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { logger } from "./logger";

const OPENROUTER_DEFAULT_MODEL = "meta-llama/llama-3.3-70b-instruct:free";

export interface LLMProvider {
  generateJSON<T>(
    systemPrompt: string,
    userPrompt: string,
    schema: z.ZodType<T>,
    retries?: number,
  ): Promise<T>;
}

class GeminiProvider implements LLMProvider {
  private client: GoogleGenerativeAI;
  private modelName: string;

  constructor(apiKey: string, modelName = "gemini-1.5-flash") {
    this.client = new GoogleGenerativeAI(apiKey);
    this.modelName = modelName;
  }

  async generateJSON<T>(
    systemPrompt: string,
    userPrompt: string,
    schema: z.ZodType<T>,
    retries = 2,
  ): Promise<T> {
    const model = this.client.getGenerativeModel({
      model: this.modelName,
      systemInstruction: systemPrompt,
      generationConfig: { responseMimeType: "application/json" },
    });

    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await model.generateContent(userPrompt);
        const text = result.response.text();
        const raw = JSON.parse(text);
        return schema.parse(raw);
      } catch (err) {
        lastError = err;
        logger.warn({ err, attempt }, "AI response parse/validation failed, retrying");
      }
    }
    throw lastError;
  }
}

class OllamaProvider implements LLMProvider {
  private baseUrl: string;
  private modelName: string;

  constructor(baseUrl = "http://localhost:11434", modelName = "llama3.2") {
    this.baseUrl = baseUrl;
    this.modelName = modelName;
  }

  async generateJSON<T>(
    systemPrompt: string,
    userPrompt: string,
    schema: z.ZodType<T>,
    retries = 2,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: this.modelName,
            stream: false,
            format: "json",
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
          }),
        });
        if (!response.ok) {
          throw new Error(`Ollama request failed: ${response.status}`);
        }
        const data = (await response.json()) as { message?: { content?: string } };
        const raw = JSON.parse(data.message?.content ?? "{}");
        return schema.parse(raw);
      } catch (err) {
        lastError = err;
        logger.warn({ err, attempt }, "Ollama response parse/validation failed, retrying");
      }
    }
    throw lastError;
  }
}

class OpenRouterProvider implements LLMProvider {
  private apiKey: string;
  private modelName: string;

  constructor(apiKey: string, modelName = OPENROUTER_DEFAULT_MODEL) {
    this.apiKey = apiKey;
    this.modelName = modelName;
  }

  async generateJSON<T>(
    systemPrompt: string,
    userPrompt: string,
    schema: z.ZodType<T>,
    retries = 2,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "authorization": `Bearer ${this.apiKey}`,
            "http-referer": "https://studyflow.app",
            "x-title": "StudyFlow",
          },
          body: JSON.stringify({
            model: this.modelName,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
          }),
        });
        if (!response.ok) {
          const body = await response.text();
          throw new Error(`OpenRouter request failed: ${response.status} ${body}`);
        }
        const data = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const content = data.choices?.[0]?.message?.content ?? "{}";
        const raw = JSON.parse(content);
        return schema.parse(raw);
      } catch (err) {
        lastError = err;
        logger.warn({ err, attempt }, "OpenRouter response parse/validation failed, retrying");
      }
    }
    throw lastError;
  }
}

let _provider: LLMProvider | null = null;

export function getAIProvider(): LLMProvider {
  if (_provider) return _provider;

  const providerName = (process.env.AI_PROVIDER ?? "openrouter").toLowerCase();

  if (providerName === "ollama") {
    _provider = new OllamaProvider(
      process.env.OLLAMA_BASE_URL,
      process.env.OLLAMA_MODEL,
    );
    return _provider;
  }

  if (providerName === "gemini") {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "GEMINI_API_KEY environment variable is required when AI_PROVIDER=gemini. " +
          "Set it in your .env file or switch to AI_PROVIDER=openrouter.",
      );
    }
    _provider = new GeminiProvider(apiKey, process.env.GEMINI_MODEL ?? "gemini-1.5-flash");
    return _provider;
  }

  // Default: openrouter
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENROUTER_API_KEY environment variable is required. " +
        "Set it in your .env file.",
    );
  }
  _provider = new OpenRouterProvider(
    apiKey,
    process.env.OPENROUTER_MODEL ?? OPENROUTER_DEFAULT_MODEL,
  );
  return _provider;
}
