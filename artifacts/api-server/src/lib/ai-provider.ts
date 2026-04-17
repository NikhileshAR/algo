import { z } from "zod";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { logger } from "./logger";

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

let _provider: LLMProvider | null = null;

export function getAIProvider(): LLMProvider {
  if (_provider) return _provider;

  const providerName = (process.env.AI_PROVIDER ?? "gemini").toLowerCase();

  if (providerName === "ollama") {
    _provider = new OllamaProvider(
      process.env.OLLAMA_BASE_URL,
      process.env.OLLAMA_MODEL,
    );
    return _provider;
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY environment variable is required when AI_PROVIDER=gemini (the default). " +
        "Set it in your environment or switch to AI_PROVIDER=ollama for local inference.",
    );
  }
  _provider = new GeminiProvider(apiKey, process.env.GEMINI_MODEL ?? "gemini-1.5-flash");
  return _provider;
}
