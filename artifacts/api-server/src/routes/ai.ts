import { Router, type IRouter } from "express";
import { db, studentProfileTable, topicsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import {
  AiOnboardingEnrichBody,
  AiOnboardingEnrichResponse,
  type AiOnboardingEnrichResponseType,
} from "@workspace/api-zod";
import { getAIProvider } from "../lib/ai-provider";
import { logger } from "../lib/logger";

export const aiRouter: IRouter = Router();

const ONBOARDING_SYSTEM_PROMPT = `You are an expert academic coach helping a student prepare for a high-stakes exam.
You will receive the student's profile and study preferences, and must return a structured JSON study plan.

Rules:
- Return ONLY valid JSON matching the schema exactly — no markdown, no prose, no code fences.
- suggestedTopics must have 5–20 items covering the subjects provided.
- difficultyLevel is an integer 1–5.
- estimatedHours is a realistic positive number (e.g. 10–80 for a major topic).
- masteryScore represents the student's initial mastery: 0.05 for beginners, 0.15 for intermediate, 0.30 for advanced.
- studyStrategy is a 2–4 sentence paragraph describing the recommended approach.
- scheduleTone is one of "aggressive", "balanced", or "relaxed" based on time until exam and daily hours.`;

function buildUserPrompt(context: {
  name: string;
  examName: string;
  examDate: string;
  dailyTargetHours: number;
  subjects: string[];
  currentLevel: string;
  specificGoals?: string;
  daysUntilExam: number;
}): string {
  return `Student profile:
- Name: ${context.name}
- Target exam: ${context.examName}
- Exam date: ${context.examDate} (${context.daysUntilExam} days away)
- Daily study goal: ${context.dailyTargetHours} hours/day
- Subjects to cover: ${context.subjects.join(", ")}
- Current knowledge level: ${context.currentLevel}
${context.specificGoals ? `- Specific goals: ${context.specificGoals}` : ""}

Return a JSON object with these exact fields:
{
  "studyStrategy": "<2-4 sentence study approach>",
  "scheduleTone": "<aggressive|balanced|relaxed>",
  "suggestedTopics": [
    {
      "name": "<topic name>",
      "subject": "<subject from the list above>",
      "difficultyLevel": <1-5>,
      "estimatedHours": <number>,
      "masteryScore": <0.0-1.0>
    }
  ]
}`;
}

function daysUntil(examDate: string): number {
  const now = new Date();
  const exam = new Date(examDate);
  return Math.max(Math.ceil((exam.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)), 0);
}

aiRouter.post("/ai/onboarding-enrich", async (req, res): Promise<void> => {
  const parsed = AiOnboardingEnrichBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [profile] = await db.select().from(studentProfileTable).limit(1);
  if (!profile) {
    res.status(404).json({ error: "No profile found. Create a profile first." });
    return;
  }

  const { subjects, currentLevel, specificGoals } = parsed.data;

  const userPrompt = buildUserPrompt({
    name: profile.name,
    examName: profile.examName,
    examDate: profile.examDate,
    dailyTargetHours: profile.dailyTargetHours,
    subjects,
    currentLevel,
    specificGoals,
    daysUntilExam: daysUntil(profile.examDate),
  });

  let enrichment: AiOnboardingEnrichResponseType;
  try {
    const ai = getAIProvider();
    enrichment = await ai.generateJSON(
      ONBOARDING_SYSTEM_PROMPT,
      userPrompt,
      AiOnboardingEnrichResponse,
    );
  } catch (err) {
    logger.error({ err }, "AI onboarding enrichment failed");
    res.status(502).json({ error: "AI service unavailable. Please try again or skip AI enrichment." });
    return;
  }

  res.json(enrichment);
});

aiRouter.get("/ai/status", async (_req, res): Promise<void> => {
  const configured = Boolean(process.env.OPENROUTER_API_KEY);
  res.json({ provider: "openrouter", configured });
});
