/**
 * Intake Engine — Phase 2
 *
 * Pure state-machine that drives the conversational onboarding process.
 * No React, no I/O — takes a state + user input and returns a new state
 * plus the bot messages to display next.
 *
 * Phases (in order):
 *   greeting         → collect name
 *   exam_name        → identify exam (fuzzy match against curriculum graph)
 *   exam_date        → parse exam date from natural language
 *   subjects_confirm → show auto-detected subjects, let user confirm
 *   prior_knowledge  → per-subject: "studied before?" (iterates subjects)
 *   diagnostic       → 2 conceptual questions per subject with prior knowledge
 *   capacity         → daily study hours (clamped 1–10)
 *   confirm          → show full summary, ask for confirmation
 *   complete         → signals the UI to commit to IndexedDB and navigate
 *
 * Design:
 *   - All state lives in IntakeState (plain object, safe for React useState)
 *   - processUserInput() is the single entry point; it returns the new state
 *     plus the bot messages the UI should append to the chat
 *   - Mastery starts at a prior-knowledge baseline (0.05 / 0.15 / 0.35)
 *     and is refined upward by correct diagnostic answers (up to 0.65 cap)
 *   - Topics and prerequisites come entirely from the curriculum graph;
 *     no manual entry is ever required
 */

import { findExam, getExamTopics, type CurriculumExamDef } from "./curriculum-graph";
import {
  getQuestionsForSubject,
  scoreDiagnosticAnswer,
  DIAGNOSTIC_BONUS,
} from "./diagnostic-questions";

// ─── Types ────────────────────────────────────────────────────────────────────

export type IntakePhase =
  | "greeting"
  | "exam_name"
  | "exam_date"
  | "subjects_confirm"
  | "prior_knowledge"
  | "diagnostic"
  | "capacity"
  | "confirm"
  | "complete";

export interface ChatMessage {
  id: string;
  role: "bot" | "user";
  content: string;
  timestamp: string;
  /** Quick-reply button labels shown below this message */
  options?: string[];
}

/** A single topic entry accumulated during intake */
export interface IntakeTopic {
  name: string;
  subject: string;
  difficulty: number;
  estimatedHours: number;
  masteryScore: number;
  confidenceScore: number;
  prerequisiteNames: string[];
}

export type PriorKnowledgeLevel = "none" | "some" | "good";

export interface IntakeState {
  phase: IntakePhase;
  // Collected data
  name: string;
  examName: string;
  examDate: string;           // YYYY-MM-DD (empty until parsed)
  subjects: string[];         // confirmed subject names
  topics: IntakeTopic[];
  dailyHours: number;
  // Per-subject prior knowledge ("none" | "some" | "good")
  priorKnowledge: Record<string, PriorKnowledgeLevel>;
  // Iteration cursors
  priorSubjectIndex: number;
  diagnosticSubjectIndex: number;
  diagnosticQuestionIndex: number;
}

export interface ProcessResult {
  newState: IntakeState;
  botMessages: ChatMessage[];
}

// ─── Message factory ──────────────────────────────────────────────────────────

let _msgSeq = 0;

function botMsg(content: string, options?: string[]): ChatMessage {
  return {
    id: `bot-${++_msgSeq}`,
    role: "bot",
    content,
    timestamp: new Date().toISOString(),
    options,
  };
}

export function userMsg(content: string): ChatMessage {
  return {
    id: `user-${++_msgSeq}`,
    role: "user",
    content,
    timestamp: new Date().toISOString(),
  };
}

// ─── Phase processors ─────────────────────────────────────────────────────────

function handleGreeting(state: IntakeState, input: string): ProcessResult {
  const name = extractName(input);
  return {
    newState: { ...state, name, phase: "exam_name" },
    botMessages: [
      botMsg(
        `Nice to meet you, ${name}! 🎯\n\nWhat exam are you preparing for?\n\nI know the curriculum for: JEE Advanced, JEE Main, NEET UG, USMLE Step 1, Bar Exam, CFA Level 1, GRE, GMAT — or just type yours.`,
      ),
    ],
  };
}

function handleExamName(state: IntakeState, input: string): ProcessResult {
  const exam = findExam(input);
  const examName = exam?.name ?? titleCase(input.trim());
  return {
    newState: { ...state, examName, phase: "exam_date" },
    botMessages: [
      botMsg(
        `Got it — **${examName}**! 📚\n\nWhen is your exam? (e.g. "June 2025", "2025-06-15", "in 4 months")`,
      ),
    ],
  };
}

function handleExamDate(state: IntakeState, input: string): ProcessResult {
  const examDate = parseDate(input);
  if (!examDate) {
    return {
      newState: state,
      botMessages: [
        botMsg(
          `I couldn't parse that date. Could you try again? For example: "June 2025", "2025-06-15", or "in 3 months".`,
        ),
      ],
    };
  }

  const exam = findExam(state.examName);
  if (exam) {
    const subjects = exam.subjects.map((s) => s.name);
    const list = subjects.map((s) => `• ${s}`).join("\n");
    return {
      newState: { ...state, examDate, phase: "subjects_confirm" },
      botMessages: [
        botMsg(
          `For **${state.examName}**, the standard subjects are:\n\n${list}\n\nDoes this look right?`,
          ["Yes, looks good", "Some adjustments needed"],
        ),
      ],
    };
  }

  // Unknown exam — ask user to list subjects
  return {
    newState: { ...state, examDate, phase: "subjects_confirm" },
    botMessages: [
      botMsg(
        `I don't have a built-in curriculum for **${state.examName}**, so please list the main subjects it covers (comma-separated or one per line).`,
      ),
    ],
  };
}

function handleSubjectsConfirm(state: IntakeState, input: string): ProcessResult {
  const exam = findExam(state.examName);
  let subjects: string[];

  if (exam) {
    // Confirmed or adjusted — for now always use the full curriculum subjects
    subjects = exam.subjects.map((s) => s.name);
  } else {
    // Custom exam — parse the subject list from user input
    subjects = input
      .split(/[,\n;]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map(titleCase);

    if (subjects.length === 0) {
      return {
        newState: state,
        botMessages: [
          botMsg(
            `I didn't catch any subjects. Could you list them again, separated by commas? (e.g. "Math, Physics, Chemistry")`,
          ),
        ],
      };
    }
  }

  // Build topics from curriculum or create placeholder topics
  const topics: IntakeTopic[] = exam
    ? getExamTopics(exam)
        .filter((ct) => subjects.includes(ct.subject))
        .map((ct) => ({
          name: ct.name,
          subject: ct.subject,
          difficulty: ct.difficulty,
          estimatedHours: ct.estimatedHours,
          masteryScore: 0.05,
          confidenceScore: 0.05,
          prerequisiteNames: ct.prerequisiteNames,
        }))
    : subjects.map((subject) => ({
        name: subject,
        subject,
        difficulty: 3,
        estimatedHours: 20,
        masteryScore: 0.05,
        confidenceScore: 0.05,
        prerequisiteNames: [],
      }));

  const firstSubject = subjects[0];
  return {
    newState: {
      ...state,
      subjects,
      topics,
      priorSubjectIndex: 0,
      phase: "prior_knowledge",
    },
    botMessages: [
      botMsg(
        `Great! I've loaded **${topics.length} topics** across **${subjects.length} subjects**. 🎉\n\nNow let me calibrate your starting level — this helps the scheduler set the right difficulty from day one.\n\nHave you studied **${firstSubject}** before?`,
        ["Yes, I know it well", "A little bit", "Not yet"],
      ),
    ],
  };
}

function handlePriorKnowledge(state: IntakeState, input: string): ProcessResult {
  const lower = input.toLowerCase();
  let knowledge: PriorKnowledgeLevel;

  if (/\b(well|good|strong|lot|deep|thorough|know it well|yes.*well)\b/.test(lower)) {
    knowledge = "good";
  } else if (/\b(little|some|basic|bit|partial|kind of|sort of|somewhat|studied|yes|yeah|yep|yup)\b/.test(lower)) {
    knowledge = "some";
  } else {
    knowledge = "none";
  }

  const currentSubject = state.subjects[state.priorSubjectIndex];
  const priorKnowledge = { ...state.priorKnowledge, [currentSubject]: knowledge };

  // Set baseline mastery for this subject's topics
  const baseMastery =
    knowledge === "good" ? 0.35 : knowledge === "some" ? 0.15 : 0.05;
  const updatedTopics = state.topics.map((t) =>
    t.subject === currentSubject
      ? { ...t, masteryScore: baseMastery, confidenceScore: baseMastery }
      : t,
  );

  const ackText =
    knowledge === "good"
      ? `Great foundation in ${currentSubject}! 💪`
      : knowledge === "some"
        ? `Some background in ${currentSubject} — we'll build on that.`
        : `Starting fresh with ${currentSubject} — no problem!`;

  const nextPriorIndex = state.priorSubjectIndex + 1;

  // More subjects to ask about?
  if (nextPriorIndex < state.subjects.length) {
    const nextSubject = state.subjects[nextPriorIndex];
    return {
      newState: {
        ...state,
        priorKnowledge,
        topics: updatedTopics,
        priorSubjectIndex: nextPriorIndex,
      },
      botMessages: [
        botMsg(ackText),
        botMsg(
          `Have you studied **${nextSubject}** before?`,
          ["Yes, I know it well", "A little bit", "Not yet"],
        ),
      ],
    };
  }

  // All subjects covered — decide whether to run diagnostics
  const diagSubjects = state.subjects.filter((s) => {
    const k = priorKnowledge[s];
    return k === "some" || k === "good";
  });

  if (diagSubjects.length === 0) {
    // No prior knowledge at all — skip straight to capacity
    return {
      newState: { ...state, priorKnowledge, topics: updatedTopics, phase: "capacity" },
      botMessages: [
        botMsg(ackText),
        botMsg(
          `Got it — starting fresh across all subjects. We'll build from the ground up!\n\nLast question: **how many hours per day can you realistically study?** Be honest — the system adapts over time.`,
          ["2 hours", "4 hours", "6 hours", "8+ hours"],
        ),
      ],
    };
  }

  // Kick off diagnostics
  const firstDiagSubject = diagSubjects[0];
  const questions = getQuestionsForSubject(firstDiagSubject);

  if (questions.length === 0) {
    return {
      newState: { ...state, priorKnowledge, topics: updatedTopics, phase: "capacity" },
      botMessages: [
        botMsg(ackText),
        botMsg(
          `Thanks! I've mapped your starting knowledge.\n\n**How many hours per day can you realistically study?**`,
          ["2 hours", "4 hours", "6 hours", "8+ hours"],
        ),
      ],
    };
  }

  return {
    newState: {
      ...state,
      priorKnowledge,
      topics: updatedTopics,
      diagnosticSubjectIndex: 0,
      diagnosticQuestionIndex: 0,
      phase: "diagnostic",
    },
    botMessages: [
      botMsg(ackText),
      botMsg(
        `Let me ask a couple of quick calibration questions — answer in your own words, no pressure.\n\n📝 **${firstDiagSubject}:**\n\n${questions[0].text}`,
      ),
    ],
  };
}

function handleDiagnostic(state: IntakeState, input: string): ProcessResult {
  const diagSubjects = state.subjects.filter((s) => {
    const k = state.priorKnowledge[s];
    return k === "some" || k === "good";
  });

  const currentSubject = diagSubjects[state.diagnosticSubjectIndex];
  const questions = getQuestionsForSubject(currentSubject);
  const currentQuestion = questions[state.diagnosticQuestionIndex];

  // Score the answer
  const score = scoreDiagnosticAnswer(input, currentQuestion);
  const bonus = DIAGNOSTIC_BONUS[score];

  // Apply mastery/confidence refinement
  const updatedTopics = state.topics.map((t) =>
    t.subject === currentSubject && bonus > 0
      ? {
          ...t,
          masteryScore: Math.min(t.masteryScore + bonus, 0.65),
          confidenceScore: Math.min(t.confidenceScore + bonus * 0.8, 0.65),
        }
      : t,
  );

  const feedback =
    score === "strong"
      ? `✅ Strong answer — solid conceptual grasp of ${currentSubject}.`
      : score === "partial"
        ? `👍 Partially right. Key idea: *${currentQuestion.hint}*`
        : `That's okay — here's the key idea: *${currentQuestion.hint}*`;

  // Next question in same subject?
  const nextQuestionIndex = state.diagnosticQuestionIndex + 1;
  if (nextQuestionIndex < questions.length) {
    return {
      newState: { ...state, topics: updatedTopics, diagnosticQuestionIndex: nextQuestionIndex },
      botMessages: [
        botMsg(feedback),
        botMsg(
          `📝 **${currentSubject}** (question ${nextQuestionIndex + 1}/${questions.length}):\n\n${questions[nextQuestionIndex].text}`,
        ),
      ],
    };
  }

  // Next subject?
  const nextSubjectIndex = state.diagnosticSubjectIndex + 1;
  if (nextSubjectIndex < diagSubjects.length) {
    const nextSubject = diagSubjects[nextSubjectIndex];
    const nextQs = getQuestionsForSubject(nextSubject);

    if (nextQs.length === 0) {
      // No questions for this subject — jump to capacity
      return {
        newState: {
          ...state,
          topics: updatedTopics,
          diagnosticSubjectIndex: nextSubjectIndex,
          diagnosticQuestionIndex: 0,
          phase: "capacity",
        },
        botMessages: [
          botMsg(feedback),
          botMsg(
            `**How many hours per day can you realistically study?**`,
            ["2 hours", "4 hours", "6 hours", "8+ hours"],
          ),
        ],
      };
    }

    return {
      newState: {
        ...state,
        topics: updatedTopics,
        diagnosticSubjectIndex: nextSubjectIndex,
        diagnosticQuestionIndex: 0,
      },
      botMessages: [
        botMsg(feedback),
        botMsg(`Now let's look at **${nextSubject}**:\n\n${nextQs[0].text}`),
      ],
    };
  }

  // All diagnostics done
  return {
    newState: {
      ...state,
      topics: updatedTopics,
      diagnosticSubjectIndex: 0,
      diagnosticQuestionIndex: 0,
      phase: "capacity",
    },
    botMessages: [
      botMsg(feedback),
      botMsg(
        `🎯 Calibration complete! I've mapped your starting mastery across all subjects.\n\nLast question: **How many hours per day can you realistically study?** (The schedule adapts if you over or under-deliver)`,
        ["2 hours", "4 hours", "6 hours", "8+ hours"],
      ),
    ],
  };
}

function handleCapacity(state: IntakeState, input: string): ProcessResult {
  const hours = extractHours(input);
  if (hours === null) {
    return {
      newState: state,
      botMessages: [
        botMsg(
          `I didn't catch a number. How many hours per day can you study? (1–10)`,
          ["2 hours", "4 hours", "6 hours", "8 hours"],
        ),
      ],
    };
  }

  const dailyHours = Math.min(Math.max(Math.round(hours), 1), 10);
  const avgMastery =
    state.topics.length > 0
      ? state.topics.reduce((s, t) => s + t.masteryScore, 0) / state.topics.length
      : 0;

  const summary = [
    `**Name:** ${state.name}`,
    `**Exam:** ${state.examName}`,
    `**Exam Date:** ${formatDate(state.examDate)}`,
    `**Subjects:** ${state.subjects.length} (${state.subjects.join(", ")})`,
    `**Topics loaded:** ${state.topics.length}`,
    `**Avg starting mastery:** ${Math.round(avgMastery * 100)}%`,
    `**Daily study target:** ${dailyHours} hrs`,
  ].join("\n");

  const encouragement =
    dailyHours >= 7
      ? "Serious commitment — the system will push hard! 🔥"
      : dailyHours >= 4
        ? "Solid target — consistency will be key! 💪"
        : "Every focused hour counts! 📖";

  return {
    newState: { ...state, dailyHours, phase: "confirm" },
    botMessages: [
      botMsg(
        `${dailyHours} hrs/day — ${encouragement}\n\nHere's your starting configuration:\n\n${summary}\n\nReady to initialize StudyFlow?`,
        ["Let's go! 🚀", "Start over"],
      ),
    ],
  };
}

function handleConfirm(state: IntakeState, input: string): ProcessResult {
  const isConfirmed = /\b(yes|go|start|ready|launch|let'?s|ok|okay|confirm|proceed|initialize|init)\b/i.test(
    input.toLowerCase(),
  );

  if (!isConfirmed) {
    return {
      newState: { ...state, phase: "exam_name" },
      botMessages: [
        botMsg(`No problem — let's start over. What exam are you preparing for?`),
      ],
    };
  }

  return {
    newState: { ...state, phase: "complete" },
    botMessages: [
      botMsg(
        `🚀 Initializing your study system...\n\nCreating your profile, loading curriculum, and preparing your first schedule. Just a moment!`,
      ),
    ],
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Process a user message and advance the intake state machine.
 *
 * @param state  Current intake state
 * @param input  Raw user input (will be trimmed)
 * @returns      New state + bot messages to append to the chat
 */
export function processUserInput(
  state: IntakeState,
  input: string,
): ProcessResult {
  const trimmed = input.trim();
  if (!trimmed) return { newState: state, botMessages: [] };

  switch (state.phase) {
    case "greeting":         return handleGreeting(state, trimmed);
    case "exam_name":        return handleExamName(state, trimmed);
    case "exam_date":        return handleExamDate(state, trimmed);
    case "subjects_confirm": return handleSubjectsConfirm(state, trimmed);
    case "prior_knowledge":  return handlePriorKnowledge(state, trimmed);
    case "diagnostic":       return handleDiagnostic(state, trimmed);
    case "capacity":         return handleCapacity(state, trimmed);
    case "confirm":          return handleConfirm(state, trimmed);
    case "complete":         return { newState: state, botMessages: [] };
  }
}

/** Initial state for a fresh intake session */
export function createInitialState(): IntakeState {
  return {
    phase: "greeting",
    name: "",
    examName: "",
    examDate: "",
    subjects: [],
    topics: [],
    dailyHours: 4,
    priorKnowledge: {},
    priorSubjectIndex: 0,
    diagnosticSubjectIndex: 0,
    diagnosticQuestionIndex: 0,
  };
}

/** Opening messages shown before the user has typed anything */
export function getWelcomeMessages(): ChatMessage[] {
  return [
    botMsg(
      `👋 Welcome to StudyFlow!\n\nI'm your setup assistant. In about 10 minutes I'll initialize your personalized study system with:\n• Your exam curriculum\n• Your starting knowledge level\n• A realistic daily study target\n\nNo forms, no dropdowns — just a conversation.\n\nLet's start: **what's your name?**`,
    ),
  ];
}

// ─── Progress helper ──────────────────────────────────────────────────────────

const PHASE_ORDER: IntakePhase[] = [
  "greeting",
  "exam_name",
  "exam_date",
  "subjects_confirm",
  "prior_knowledge",
  "diagnostic",
  "capacity",
  "confirm",
  "complete",
];

/** Returns 0–1 progress through the intake flow */
export function intakeProgress(phase: IntakePhase): number {
  const idx = PHASE_ORDER.indexOf(phase);
  return idx < 0 ? 0 : idx / (PHASE_ORDER.length - 1);
}

// ─── Parsing helpers (pure functions, exported for testing) ──────────────────

/** Extract a display name from free text (title-case, 1–3 words) */
export function extractName(input: string): string {
  return input
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .map(titleCase)
    .join(" ");
}

/** Parse a variety of natural-language date expressions into YYYY-MM-DD */
export function parseDate(input: string): string | null {
  const lower = input.toLowerCase().trim();

  // ISO 8601: 2025-06-15
  const iso = lower.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const d = new Date(iso[0]);
    if (!isNaN(d.getTime())) return iso[0];
  }

  // DD/MM/YYYY
  const slash = lower.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slash) {
    const d = new Date(
      `${slash[3]}-${slash[2].padStart(2, "0")}-${slash[1].padStart(2, "0")}`,
    );
    if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
  }

  // Month YYYY (e.g. "June 2025")
  const MONTHS: Record<string, string> = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
    january: "01", february: "02", march: "03", april: "04", june: "06",
    july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
  };
  for (const [month, num] of Object.entries(MONTHS)) {
    const yearMatch = lower.match(new RegExp(`${month}\\s*(\\d{4})`));
    if (yearMatch) return `${yearMatch[1]}-${num}-01`;

    const dayYearMatch = lower.match(new RegExp(`(\\d{1,2})\\s+${month}\\s+(\\d{4})`));
    if (dayYearMatch) {
      return `${dayYearMatch[2]}-${num}-${dayYearMatch[1].padStart(2, "0")}`;
    }
  }

  // "in N months"
  const inMonths = lower.match(/in\s+(\d+)\s+months?/);
  if (inMonths) {
    const d = new Date();
    d.setMonth(d.getMonth() + parseInt(inMonths[1], 10));
    return d.toISOString().split("T")[0];
  }

  // "in N weeks"
  const inWeeks = lower.match(/in\s+(\d+)\s+weeks?/);
  if (inWeeks) {
    const d = new Date(
      Date.now() + parseInt(inWeeks[1], 10) * 7 * 86_400_000,
    );
    return d.toISOString().split("T")[0];
  }

  // "next year"
  if (/next year/.test(lower)) {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 1);
    return d.toISOString().split("T")[0];
  }

  return null;
}

/** Extract the first number from a string (for hours parsing) */
export function extractHours(input: string): number | null {
  const m = input.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function titleCase(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}

function formatDate(isoDate: string): string {
  if (!isoDate) return "Unknown";
  const d = new Date(isoDate);
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}
