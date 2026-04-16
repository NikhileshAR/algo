/**
 * Diagnostic Question Bank — Phase 2 (Intake Engine)
 *
 * 2–3 lightweight conceptual questions per subject, used during intake to
 * calibrate initial mastery estimates. This is NOT an evaluation test —
 * it is a calibration probe to give the scheduler a meaningful starting
 * state vector rather than defaulting everyone to mastery = 0.05.
 *
 * Scoring model:
 *   strong  → mastery bonus +0.20  (cap: 0.65 before any real test data)
 *   partial → mastery bonus +0.08
 *   weak    → no bonus (prior-knowledge baseline is kept)
 *
 * Questions are deliberately open-ended. Keyword matching is used to
 * classify answers — no NLP required.
 */

export interface DiagnosticQuestion {
  id: string;
  /** Matches the subject name in the curriculum graph (case-insensitive partial match) */
  subject: string;
  text: string;
  /** Any one of these words in the answer → "strong" */
  strongKeywords: string[];
  /** Any one of these words in the answer → "partial" (checked only if not strong) */
  partialKeywords: string[];
  /** Brief clarification shown after the user answers */
  hint: string;
}

export type DiagnosticScore = "strong" | "partial" | "weak";

/** Mastery bonus applied for each score level */
export const DIAGNOSTIC_BONUS: Record<DiagnosticScore, number> = {
  strong: 0.20,
  partial: 0.08,
  weak: 0,
};

// ─── Question bank ────────────────────────────────────────────────────────────

export const DIAGNOSTIC_QUESTIONS: DiagnosticQuestion[] = [
  // ── Physics ─────────────────────────────────────────────────────────────────
  {
    id: "phys-1",
    subject: "Physics",
    text: "In your own words, what does Newton's second law say about force and acceleration?",
    strongKeywords: ["proportional", "f=ma", "force equals mass", "directly proportional", "net force", "f = ma"],
    partialKeywords: ["force", "acceleration", "mass", "newton"],
    hint: "F = ma — net force equals mass times acceleration.",
  },
  {
    id: "phys-2",
    subject: "Physics",
    text: "What is the key idea behind conservation of energy?",
    strongKeywords: ["cannot be created or destroyed", "converted", "isolated system", "total energy remains", "constant"],
    partialKeywords: ["energy", "conserved", "constant"],
    hint: "Energy cannot be created or destroyed — only converted between forms.",
  },

  // ── Chemistry ────────────────────────────────────────────────────────────────
  {
    id: "chem-1",
    subject: "Chemistry",
    text: "What makes a molecule a Brønsted–Lowry acid?",
    strongKeywords: ["proton donor", "h+ donor", "donates proton", "hydrogen ion donor"],
    partialKeywords: ["proton", "acid", "hydrogen", "donate"],
    hint: "A Brønsted–Lowry acid donates a proton (H⁺) to another species.",
  },
  {
    id: "chem-2",
    subject: "Chemistry",
    text: "What does Le Chatelier's principle predict when pressure increases on a gas-phase equilibrium?",
    strongKeywords: ["fewer moles", "fewer gas molecules", "less moles", "side with less gas"],
    partialKeywords: ["shift", "equilibrium", "pressure", "moles"],
    hint: "Increasing pressure shifts equilibrium toward the side with fewer moles of gas.",
  },

  // ── Mathematics ──────────────────────────────────────────────────────────────
  {
    id: "math-1",
    subject: "Mathematics",
    text: "What does a derivative represent geometrically?",
    strongKeywords: ["slope", "tangent line", "instantaneous rate of change", "rate of change at a point"],
    partialKeywords: ["slope", "tangent", "rate", "change"],
    hint: "A derivative is the slope of the tangent line at a point — the instantaneous rate of change.",
  },
  {
    id: "math-2",
    subject: "Mathematics",
    text: "Briefly describe what the Fundamental Theorem of Calculus connects.",
    strongKeywords: ["differentiation and integration", "derivative of integral", "antiderivative", "inverse operations"],
    partialKeywords: ["integration", "differentiation", "antiderivative", "connects", "inverse"],
    hint: "It links differentiation and integration — the antiderivative evaluated at the bounds gives the definite integral.",
  },

  // ── Biology ──────────────────────────────────────────────────────────────────
  {
    id: "bio-1",
    subject: "Biology",
    text: "What is the role of mitochondria in a cell?",
    strongKeywords: ["atp", "energy production", "cellular respiration", "powerhouse", "oxidative phosphorylation"],
    partialKeywords: ["energy", "atp", "power"],
    hint: "Mitochondria produce ATP via cellular respiration — often called the cell's powerhouse.",
  },
  {
    id: "bio-2",
    subject: "Biology",
    text: "How does DNA replication ensure accuracy?",
    strongKeywords: ["proofreading", "exonuclease", "base pairing", "semi-conservative", "error checking"],
    partialKeywords: ["proofreading", "complementary", "base pairing", "polymerase", "accuracy"],
    hint: "DNA polymerase has 3'→5' proofreading exonuclease activity to correct mismatched bases.",
  },

  // ── Biochemistry ─────────────────────────────────────────────────────────────
  {
    id: "bioc-1",
    subject: "Biochemistry",
    text: "What is Km in enzyme kinetics and what does a high Km indicate?",
    strongKeywords: ["michaelis constant", "half vmax", "low affinity", "affinity", "substrate concentration at"],
    partialKeywords: ["km", "substrate", "affinity", "michaelis", "enzyme"],
    hint: "Km is the substrate concentration at half-maximal velocity. High Km = low enzyme-substrate affinity.",
  },
  {
    id: "bioc-2",
    subject: "Biochemistry",
    text: "Approximately how many ATP molecules are produced per glucose in aerobic respiration?",
    strongKeywords: ["30", "32", "36", "38", "30-32", "36-38"],
    partialKeywords: ["atp", "glucose", "glycolysis", "yield"],
    hint: "Approximately 30–32 ATP per glucose (or classically 36–38 in older textbooks).",
  },

  // ── Physiology ───────────────────────────────────────────────────────────────
  {
    id: "physiol-1",
    subject: "Physiology",
    text: "What happens to heart rate when blood pressure suddenly rises (baroreceptor reflex)?",
    strongKeywords: ["decreases", "bradycardia", "parasympathetic", "vagus", "baroreceptor", "carotid sinus"],
    partialKeywords: ["decrease", "slow", "reflex", "baroreceptor"],
    hint: "Baroreceptors detect high BP → activate vagus nerve → heart rate decreases (baroreflex).",
  },

  // ── Anatomy ──────────────────────────────────────────────────────────────────
  {
    id: "anat-1",
    subject: "Anatomy",
    text: "What structure separates the thoracic and abdominal cavities, and what is its primary function?",
    strongKeywords: ["diaphragm", "breathing", "respiration", "contraction", "inspiration"],
    partialKeywords: ["diaphragm", "muscle", "thorax", "abdomen"],
    hint: "The diaphragm contracts during inspiration, increasing thoracic volume to draw air in.",
  },

  // ── Pathology ────────────────────────────────────────────────────────────────
  {
    id: "path-1",
    subject: "Pathology",
    text: "What is the key difference between apoptosis and necrosis?",
    strongKeywords: ["programmed", "inflammation", "regulated", "necrosis causes inflammation", "apoptosis orderly", "no inflammation"],
    partialKeywords: ["apoptosis", "necrosis", "inflammation", "programmed"],
    hint: "Apoptosis is programmed, orderly, no inflammation. Necrosis is uncontrolled and triggers inflammation.",
  },

  // ── Pharmacology ─────────────────────────────────────────────────────────────
  {
    id: "pharm-1",
    subject: "Pharmacology",
    text: "What does bioavailability mean and why is oral bioavailability typically less than 100%?",
    strongKeywords: ["first pass", "fraction absorbed", "hepatic metabolism", "first-pass effect", "gut wall"],
    partialKeywords: ["bioavailability", "absorption", "first pass", "liver", "oral"],
    hint: "Bioavailability = fraction of drug reaching systemic circulation. Oral drugs undergo first-pass hepatic metabolism.",
  },

  // ── Microbiology ─────────────────────────────────────────────────────────────
  {
    id: "micro-1",
    subject: "Microbiology",
    text: "Why do gram-positive bacteria stain purple?",
    strongKeywords: ["thick peptidoglycan", "cell wall", "crystal violet", "retain stain"],
    partialKeywords: ["peptidoglycan", "crystal violet", "stain", "purple", "cell wall"],
    hint: "Thick peptidoglycan layer retains crystal violet dye → purple stain.",
  },

  // ── Behavioral Science ───────────────────────────────────────────────────────
  {
    id: "behav-1",
    subject: "Behavioral Science",
    text: "What is the difference between sensitivity and specificity in a diagnostic test?",
    strongKeywords: ["true positive rate", "true negative rate", "sensitivity detects", "specificity rules out", "snout spin"],
    partialKeywords: ["sensitivity", "specificity", "positive", "negative", "true", "false"],
    hint: "Sensitivity = true positive rate (detects disease). Specificity = true negative rate (rules out disease).",
  },

  // ── Contracts ────────────────────────────────────────────────────────────────
  {
    id: "contr-1",
    subject: "Contracts",
    text: "What are the three core requirements for a valid contract?",
    strongKeywords: ["offer", "acceptance", "consideration", "mutual assent"],
    partialKeywords: ["offer", "acceptance", "consideration"],
    hint: "Offer + Acceptance + Consideration (mutual assent and consideration).",
  },

  // ── Torts ────────────────────────────────────────────────────────────────────
  {
    id: "torts-1",
    subject: "Torts",
    text: "What are the four elements of a negligence claim?",
    strongKeywords: ["duty", "breach", "causation", "damages"],
    partialKeywords: ["duty", "breach", "cause", "damages"],
    hint: "Duty → Breach → Causation → Damages.",
  },

  // ── Constitutional Law ───────────────────────────────────────────────────────
  {
    id: "con-1",
    subject: "Constitutional Law",
    text: "What standard of review applies to laws that discriminate based on race?",
    strongKeywords: ["strict scrutiny", "compelling government interest", "narrowly tailored"],
    partialKeywords: ["strict", "scrutiny", "compelling", "race", "suspect"],
    hint: "Race = suspect classification → strict scrutiny (compelling interest + narrowly tailored).",
  },

  // ── Criminal Law & Procedure ─────────────────────────────────────────────────
  {
    id: "crim-1",
    subject: "Criminal Law",
    text: "What distinguishes murder from voluntary manslaughter?",
    strongKeywords: ["heat of passion", "provocation", "malice aforethought", "adequate provocation"],
    partialKeywords: ["provocation", "passion", "heat", "malice", "intent"],
    hint: "Murder = malice aforethought. Voluntary manslaughter = adequate provocation causing heat of passion.",
  },

  // ── Civil Procedure ──────────────────────────────────────────────────────────
  {
    id: "civpro-1",
    subject: "Civil Procedure",
    text: "When does a federal court have diversity jurisdiction?",
    strongKeywords: ["75000", "75,000", "complete diversity", "citizens of different states"],
    partialKeywords: ["diversity", "amount in controversy", "citizenship", "different states"],
    hint: "Complete diversity between all parties + amount in controversy exceeds $75,000.",
  },

  // ── Real Property ────────────────────────────────────────────────────────────
  {
    id: "prop-1",
    subject: "Real Property",
    text: "What is the main difference between a joint tenancy and a tenancy in common?",
    strongKeywords: ["right of survivorship", "survivorship", "no survivorship"],
    partialKeywords: ["survivorship", "joint tenancy", "tenancy in common", "inherit"],
    hint: "Joint tenancy has right of survivorship; tenancy in common does not.",
  },

  // ── Evidence ─────────────────────────────────────────────────────────────────
  {
    id: "evid-1",
    subject: "Evidence",
    text: "What is hearsay and why is it generally excluded?",
    strongKeywords: ["out-of-court statement", "for the truth", "truth of the matter asserted"],
    partialKeywords: ["out of court", "statement", "truth", "hearsay"],
    hint: "Hearsay = out-of-court statement offered for truth of the matter asserted. Excluded: no cross-examination.",
  },

  // ── CFA — Quantitative Methods ───────────────────────────────────────────────
  {
    id: "cfa-qm-1",
    subject: "Quantitative",
    text: "What does a p-value tell you in a hypothesis test?",
    strongKeywords: ["probability", "null hypothesis", "if null is true", "observed data"],
    partialKeywords: ["p-value", "null hypothesis", "probability", "significance"],
    hint: "P-value = probability of observing the test statistic (or more extreme) if the null hypothesis were true.",
  },

  // ── CFA — Fixed Income ───────────────────────────────────────────────────────
  {
    id: "cfa-fi-1",
    subject: "Fixed Income",
    text: "Why do bond prices move inversely to interest rates?",
    strongKeywords: ["present value", "future cash flows", "discount rate", "fixed payments"],
    partialKeywords: ["interest rate", "price", "inverse", "yield", "discount"],
    hint: "Bond price = PV of fixed future cash flows. Higher yield → lower present value → lower price.",
  },

  // ── Verbal Reasoning (GRE) ───────────────────────────────────────────────────
  {
    id: "gre-verb-1",
    subject: "Verbal",
    text: "What strategy helps most when a GRE reading passage is dense and complex?",
    strongKeywords: ["main idea", "author's purpose", "structure", "map the passage", "skim"],
    partialKeywords: ["main idea", "structure", "purpose", "passage"],
    hint: "Build a structural map: main idea + author's purpose. Don't get lost in details before seeing the big picture.",
  },

  // ── Quantitative Reasoning (GRE / GMAT) ─────────────────────────────────────
  {
    id: "gre-quant-1",
    subject: "Quantitative Reasoning",
    text: "What is the core approach for rate/work problems?",
    strongKeywords: ["rate times time", "r*t=d", "rate × time", "distance formula"],
    partialKeywords: ["rate", "time", "distance", "formula", "work"],
    hint: "Rate × Time = Distance (or Work). Most rate problems reduce to this relationship.",
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Return up to 2 questions for a given subject name.
 * Matching is case-insensitive partial string match.
 */
export function getQuestionsForSubject(subject: string): DiagnosticQuestion[] {
  const subjectLower = subject.toLowerCase();
  const matched = DIAGNOSTIC_QUESTIONS.filter(
    (q) =>
      q.subject.toLowerCase().includes(subjectLower) ||
      subjectLower.includes(q.subject.toLowerCase()),
  );
  return matched.slice(0, 2);
}

/** Classify a free-text answer against a question's keyword lists. */
export function scoreDiagnosticAnswer(
  answer: string,
  question: DiagnosticQuestion,
): DiagnosticScore {
  const lower = answer.toLowerCase();
  if (question.strongKeywords.some((kw) => lower.includes(kw.toLowerCase()))) {
    return "strong";
  }
  if (question.partialKeywords.some((kw) => lower.includes(kw.toLowerCase()))) {
    return "partial";
  }
  return "weak";
}
