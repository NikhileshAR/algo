import { z } from "zod";
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
