/**
 * Curriculum Graph — Phase 2 (Intake Engine)
 *
 * Static knowledge graph: exam → subjects → topics with prerequisites.
 * Used by the intake engine to auto-expand a user's exam into a full,
 * structured topic list — no manual entry required.
 *
 * Design:
 *   - prerequisiteNames reference other topic names within the same exam;
 *     they are resolved to local IDs at DB-commit time.
 *   - difficulty mirrors the LocalTopic schema (1–5).
 *   - estimatedHours is a realistic first-pass total study time per topic.
 *
 * Supported exams:
 *   JEE Advanced, JEE Main, NEET UG,
 *   USMLE Step 1, Bar Exam (MBE), CFA Level 1, GRE, GMAT
 */

export interface CurriculumTopicDef {
  name: string;
  difficulty: number;       // 1–5
  estimatedHours: number;
  prerequisiteNames: string[];
}

export interface CurriculumSubjectDef {
  name: string;
  topics: CurriculumTopicDef[];
}

export interface CurriculumExamDef {
  name: string;
  /** Lowercase variants used for fuzzy matching against user input */
  aliases: string[];
  subjects: CurriculumSubjectDef[];
}

// ─── Shorthand builder ────────────────────────────────────────────────────────

function t(
  name: string,
  difficulty: number,
  estimatedHours: number,
  prerequisiteNames: string[] = [],
): CurriculumTopicDef {
  return { name, difficulty, estimatedHours, prerequisiteNames };
}

// ─── Curriculum data ──────────────────────────────────────────────────────────

export const CURRICULUM: CurriculumExamDef[] = [
  // ── JEE Advanced ────────────────────────────────────────────────────────────
  {
    name: "JEE Advanced",
    aliases: ["jee advanced", "jee adv", "iit jee", "iit-jee"],
    subjects: [
      {
        name: "Physics",
        topics: [
          t("Kinematics", 2, 10),
          t("Laws of Motion", 3, 12, ["Kinematics"]),
          t("Work, Energy & Power", 3, 10, ["Laws of Motion"]),
          t("Rotational Motion", 4, 14, ["Laws of Motion", "Work, Energy & Power"]),
          t("Gravitation", 3, 8, ["Laws of Motion"]),
          t("Thermodynamics", 3, 12),
          t("Electrostatics", 4, 14),
          t("Current Electricity", 3, 12, ["Electrostatics"]),
          t("Magnetism & EMI", 4, 14, ["Current Electricity"]),
          t("Optics", 3, 12),
          t("Modern Physics", 4, 10, ["Optics"]),
          t("Waves & Oscillations", 3, 10),
        ],
      },
      {
        name: "Chemistry",
        topics: [
          t("Atomic Structure", 2, 8),
          t("Chemical Bonding", 3, 10, ["Atomic Structure"]),
          t("States of Matter", 2, 6),
          t("Chemical Thermodynamics", 3, 10),
          t("Chemical Equilibrium", 3, 10, ["Chemical Thermodynamics"]),
          t("Electrochemistry", 4, 12, ["Chemical Equilibrium"]),
          t("Organic Chemistry Basics", 3, 10),
          t("Hydrocarbons", 3, 10, ["Organic Chemistry Basics"]),
          t("Carbonyl Compounds", 4, 12, ["Hydrocarbons"]),
          t("Coordination Chemistry", 4, 12, ["Chemical Bonding"]),
          t("s-Block & p-Block Elements", 2, 8),
          t("d-Block Elements", 3, 8),
        ],
      },
      {
        name: "Mathematics",
        topics: [
          t("Sets, Relations & Functions", 2, 8),
          t("Trigonometry", 2, 10),
          t("Coordinate Geometry", 3, 12, ["Trigonometry"]),
          t("Limits & Continuity", 3, 10),
          t("Differential Calculus", 4, 14, ["Limits & Continuity"]),
          t("Integral Calculus", 4, 14, ["Differential Calculus"]),
          t("Vectors & 3D Geometry", 3, 10, ["Coordinate Geometry"]),
          t("Matrices & Determinants", 3, 10),
          t("Probability", 3, 10, ["Sets, Relations & Functions"]),
          t("Complex Numbers", 3, 8),
          t("Binomial Theorem", 2, 6),
          t("Sequence & Series", 2, 6),
        ],
      },
    ],
  },

  // ── JEE Main ────────────────────────────────────────────────────────────────
  {
    name: "JEE Main",
    aliases: ["jee main", "jee mains"],
    subjects: [
      {
        name: "Physics",
        topics: [
          t("Kinematics", 2, 8),
          t("Laws of Motion", 3, 10, ["Kinematics"]),
          t("Work, Energy & Power", 2, 8, ["Laws of Motion"]),
          t("Rotational Motion", 3, 12, ["Laws of Motion"]),
          t("Gravitation", 2, 6, ["Laws of Motion"]),
          t("Thermodynamics", 2, 8),
          t("Electrostatics", 3, 10),
          t("Current Electricity", 3, 10, ["Electrostatics"]),
          t("Magnetism & EMI", 3, 10, ["Current Electricity"]),
          t("Optics", 2, 8),
          t("Modern Physics", 3, 8, ["Optics"]),
        ],
      },
      {
        name: "Chemistry",
        topics: [
          t("Atomic Structure", 2, 6),
          t("Chemical Bonding", 2, 8, ["Atomic Structure"]),
          t("Chemical Thermodynamics", 2, 8),
          t("Chemical Equilibrium", 3, 8, ["Chemical Thermodynamics"]),
          t("Electrochemistry", 3, 10, ["Chemical Equilibrium"]),
          t("Organic Chemistry Basics", 2, 8),
          t("Hydrocarbons", 2, 8, ["Organic Chemistry Basics"]),
          t("Carbonyl Compounds", 3, 10, ["Hydrocarbons"]),
          t("Coordination Chemistry", 3, 8, ["Chemical Bonding"]),
          t("s-Block & p-Block Elements", 2, 6),
        ],
      },
      {
        name: "Mathematics",
        topics: [
          t("Sets, Relations & Functions", 2, 6),
          t("Trigonometry", 2, 8),
          t("Coordinate Geometry", 3, 10, ["Trigonometry"]),
          t("Limits & Continuity", 3, 8),
          t("Differential Calculus", 3, 12, ["Limits & Continuity"]),
          t("Integral Calculus", 3, 12, ["Differential Calculus"]),
          t("Matrices & Determinants", 2, 8),
          t("Probability", 2, 8),
          t("Complex Numbers", 2, 6),
          t("Binomial Theorem", 2, 4),
        ],
      },
    ],
  },

  // ── NEET UG ─────────────────────────────────────────────────────────────────
  {
    name: "NEET UG",
    aliases: ["neet", "neet ug", "neet-ug"],
    subjects: [
      {
        name: "Physics",
        topics: [
          t("Kinematics", 2, 6),
          t("Laws of Motion", 2, 8, ["Kinematics"]),
          t("Work, Energy & Power", 2, 6, ["Laws of Motion"]),
          t("Thermodynamics", 2, 6),
          t("Electrostatics", 3, 8),
          t("Current Electricity", 2, 8, ["Electrostatics"]),
          t("Magnetism", 3, 8, ["Current Electricity"]),
          t("Optics", 2, 6),
          t("Modern Physics", 3, 6, ["Optics"]),
        ],
      },
      {
        name: "Chemistry",
        topics: [
          t("Atomic Structure", 2, 6),
          t("Chemical Bonding", 2, 6, ["Atomic Structure"]),
          t("Chemical Thermodynamics", 2, 6),
          t("Chemical Equilibrium", 2, 6),
          t("Organic Chemistry Basics", 2, 8),
          t("Hydrocarbons", 2, 6, ["Organic Chemistry Basics"]),
          t("Biomolecules", 2, 6),
          t("s-Block & p-Block Elements", 2, 6),
          t("d-Block & f-Block Elements", 2, 4),
        ],
      },
      {
        name: "Biology",
        topics: [
          t("Cell Biology", 2, 8),
          t("Cell Division", 2, 6, ["Cell Biology"]),
          t("Genetics & Heredity", 3, 10, ["Cell Division"]),
          t("Molecular Biology", 3, 10, ["Genetics & Heredity"]),
          t("Plant Kingdom", 2, 6),
          t("Animal Kingdom", 2, 6),
          t("Human Physiology", 3, 12),
          t("Ecology & Environment", 2, 8),
          t("Evolution", 2, 6, ["Genetics & Heredity"]),
          t("Biotechnology", 3, 8, ["Molecular Biology"]),
        ],
      },
    ],
  },

  // ── USMLE Step 1 ────────────────────────────────────────────────────────────
  {
    name: "USMLE Step 1",
    aliases: ["usmle", "usmle step 1", "usmle step1", "step 1"],
    subjects: [
      {
        name: "Biochemistry",
        topics: [
          t("Amino Acids & Proteins", 3, 10),
          t("Enzyme Kinetics", 3, 8, ["Amino Acids & Proteins"]),
          t("Energy Metabolism", 4, 12, ["Enzyme Kinetics"]),
          t("Nucleotide Metabolism", 3, 8),
          t("Lipid Metabolism", 3, 8, ["Energy Metabolism"]),
          t("Molecular Biology & Genetics", 4, 12),
          t("Vitamins & Cofactors", 2, 6),
        ],
      },
      {
        name: "Physiology",
        topics: [
          t("Cardiovascular Physiology", 4, 14),
          t("Respiratory Physiology", 4, 12),
          t("Renal Physiology", 4, 12),
          t("GI Physiology", 3, 10),
          t("Neurophysiology", 4, 12),
          t("Endocrine Physiology", 4, 12),
          t("Reproductive Physiology", 3, 8),
        ],
      },
      {
        name: "Anatomy",
        topics: [
          t("Embryology", 3, 8),
          t("Histology", 3, 8),
          t("Gross Anatomy", 3, 12),
          t("Neuroanatomy", 4, 12, ["Gross Anatomy"]),
          t("Vascular Anatomy", 3, 8, ["Gross Anatomy"]),
        ],
      },
      {
        name: "Pathology",
        topics: [
          t("Cell Injury & Inflammation", 3, 10),
          t("Neoplasia", 3, 10, ["Cell Injury & Inflammation"]),
          t("Cardiovascular Pathology", 4, 12),
          t("Pulmonary Pathology", 3, 10),
          t("GI Pathology", 3, 10),
          t("Renal Pathology", 4, 10),
          t("Hematopathology", 4, 12),
        ],
      },
      {
        name: "Pharmacology",
        topics: [
          t("Pharmacokinetics & Pharmacodynamics", 3, 8),
          t("Autonomic Pharmacology", 4, 10, ["Pharmacokinetics & Pharmacodynamics"]),
          t("Cardiovascular Drugs", 4, 12, ["Autonomic Pharmacology"]),
          t("CNS Pharmacology", 4, 12),
          t("Antimicrobials", 4, 12),
          t("Anti-Cancer Drugs", 3, 8),
        ],
      },
      {
        name: "Microbiology",
        topics: [
          t("Bacteriology", 3, 10),
          t("Virology", 3, 10),
          t("Mycology & Parasitology", 3, 8),
          t("Immunology", 4, 12),
          t("Clinical Microbiology", 3, 8, ["Bacteriology", "Virology"]),
        ],
      },
      {
        name: "Behavioral Science",
        topics: [
          t("Biostatistics & Epidemiology", 3, 10),
          t("Psychiatry Basics", 2, 8),
          t("Psychopharmacology", 3, 6, ["Psychiatry Basics"]),
          t("Ethics & Law", 2, 6),
          t("Social & Developmental Psychology", 2, 6),
        ],
      },
    ],
  },

  // ── Bar Exam (MBE) ──────────────────────────────────────────────────────────
  {
    name: "Bar Exam",
    aliases: ["bar exam", "bar", "mbe", "uniform bar exam", "ube"],
    subjects: [
      {
        name: "Contracts",
        topics: [
          t("Contract Formation", 2, 8),
          t("Contract Defenses", 3, 8, ["Contract Formation"]),
          t("Contract Performance & Breach", 3, 8, ["Contract Formation"]),
          t("Contract Remedies", 3, 6, ["Contract Performance & Breach"]),
          t("Third-Party Rights", 3, 6, ["Contract Formation"]),
        ],
      },
      {
        name: "Torts",
        topics: [
          t("Negligence", 3, 10),
          t("Intentional Torts", 2, 6),
          t("Strict Liability", 3, 6, ["Negligence"]),
          t("Products Liability", 3, 6, ["Strict Liability"]),
          t("Defamation & Privacy", 3, 6),
        ],
      },
      {
        name: "Constitutional Law",
        topics: [
          t("Federal Powers & Structure", 3, 8),
          t("Individual Rights", 3, 10, ["Federal Powers & Structure"]),
          t("Due Process", 4, 8, ["Individual Rights"]),
          t("Equal Protection", 4, 8, ["Individual Rights"]),
          t("First Amendment", 3, 8),
        ],
      },
      {
        name: "Criminal Law & Procedure",
        topics: [
          t("Crimes & Elements", 2, 8),
          t("Criminal Defenses", 3, 6, ["Crimes & Elements"]),
          t("Constitutional Criminal Procedure", 4, 10),
          t("4th Amendment Search & Seizure", 3, 8, ["Constitutional Criminal Procedure"]),
          t("5th & 6th Amendment Rights", 3, 6, ["Constitutional Criminal Procedure"]),
        ],
      },
      {
        name: "Civil Procedure",
        topics: [
          t("Subject Matter Jurisdiction", 3, 8),
          t("Personal Jurisdiction", 3, 6),
          t("Pleading & Motions", 2, 6),
          t("Discovery", 2, 4),
          t("Trial & Judgment", 3, 6),
        ],
      },
      {
        name: "Real Property",
        topics: [
          t("Freehold Estates", 3, 8),
          t("Future Interests", 4, 8, ["Freehold Estates"]),
          t("Landlord-Tenant", 2, 6),
          t("Recording Acts & Title", 3, 6),
          t("Easements & Covenants", 3, 6),
        ],
      },
      {
        name: "Evidence",
        topics: [
          t("Relevance & Exclusion", 2, 6),
          t("Hearsay & Exceptions", 4, 10),
          t("Privileges", 3, 6),
          t("Expert Witnesses", 2, 4),
          t("Constitutional Evidence Issues", 3, 6),
        ],
      },
    ],
  },

  // ── CFA Level 1 ─────────────────────────────────────────────────────────────
  {
    name: "CFA Level 1",
    aliases: ["cfa", "cfa level 1", "cfa l1", "cfa1"],
    subjects: [
      {
        name: "Ethical & Professional Standards",
        topics: [
          t("Code of Ethics", 1, 6),
          t("Standards of Conduct", 2, 8, ["Code of Ethics"]),
          t("GIPS", 2, 6),
        ],
      },
      {
        name: "Quantitative Methods",
        topics: [
          t("Time Value of Money", 2, 8),
          t("Probability & Statistics", 3, 10),
          t("Hypothesis Testing", 3, 8, ["Probability & Statistics"]),
          t("Regression Analysis", 4, 10, ["Hypothesis Testing"]),
        ],
      },
      {
        name: "Economics",
        topics: [
          t("Microeconomics", 2, 8),
          t("Macroeconomics", 3, 8),
          t("International Trade & FX", 3, 6, ["Macroeconomics"]),
        ],
      },
      {
        name: "Financial Statement Analysis",
        topics: [
          t("Income Statement", 2, 8),
          t("Balance Sheet", 2, 8),
          t("Cash Flow Statement", 3, 8, ["Income Statement", "Balance Sheet"]),
          t("Financial Ratios & Analysis", 3, 10, ["Cash Flow Statement"]),
          t("Inventories & Long-Lived Assets", 3, 6),
        ],
      },
      {
        name: "Corporate Finance",
        topics: [
          t("Capital Budgeting", 3, 8, ["Time Value of Money"]),
          t("Cost of Capital (WACC)", 4, 8, ["Capital Budgeting"]),
          t("Leverage & Dividends", 3, 6),
          t("Working Capital Management", 2, 4),
        ],
      },
      {
        name: "Equity",
        topics: [
          t("Markets & Instruments", 2, 6),
          t("Equity Valuation", 4, 10, ["Financial Ratios & Analysis"]),
          t("Industry Analysis", 3, 6),
        ],
      },
      {
        name: "Fixed Income",
        topics: [
          t("Bond Pricing & Yields", 3, 8, ["Time Value of Money"]),
          t("Duration & Convexity", 4, 8, ["Bond Pricing & Yields"]),
          t("Credit Analysis", 3, 8),
          t("Yield Curve & Risk", 3, 6, ["Bond Pricing & Yields"]),
        ],
      },
      {
        name: "Derivatives",
        topics: [
          t("Forwards & Futures", 3, 6),
          t("Swaps", 3, 6, ["Forwards & Futures"]),
          t("Options", 4, 8, ["Forwards & Futures"]),
        ],
      },
      {
        name: "Portfolio Management",
        topics: [
          t("Modern Portfolio Theory", 4, 8, ["Probability & Statistics"]),
          t("CAPM & Factor Models", 4, 8, ["Modern Portfolio Theory"]),
          t("Risk Management", 3, 6, ["CAPM & Factor Models"]),
        ],
      },
    ],
  },

  // ── GRE ─────────────────────────────────────────────────────────────────────
  {
    name: "GRE",
    aliases: ["gre", "gre general", "gre exam"],
    subjects: [
      {
        name: "Verbal Reasoning",
        topics: [
          t("Vocabulary in Context", 2, 10),
          t("Reading Comprehension", 3, 12),
          t("Text Completion", 2, 8, ["Vocabulary in Context"]),
          t("Sentence Equivalence", 2, 6, ["Vocabulary in Context"]),
          t("Critical Reasoning", 3, 8, ["Reading Comprehension"]),
        ],
      },
      {
        name: "Quantitative Reasoning",
        topics: [
          t("Arithmetic & Number Properties", 2, 8),
          t("Algebra", 3, 10, ["Arithmetic & Number Properties"]),
          t("Geometry", 3, 8),
          t("Data Analysis & Statistics", 3, 8, ["Arithmetic & Number Properties"]),
          t("Word Problems", 3, 6, ["Algebra"]),
        ],
      },
      {
        name: "Analytical Writing",
        topics: [
          t("Issue Essay", 2, 8),
          t("Argument Essay", 3, 8),
        ],
      },
    ],
  },

  // ── GMAT ────────────────────────────────────────────────────────────────────
  {
    name: "GMAT",
    aliases: ["gmat", "gmat exam"],
    subjects: [
      {
        name: "Verbal",
        topics: [
          t("Critical Reasoning", 3, 10),
          t("Reading Comprehension", 3, 8),
          t("Sentence Correction", 3, 10),
        ],
      },
      {
        name: "Quantitative",
        topics: [
          t("Arithmetic & Algebra", 2, 8),
          t("Problem Solving", 3, 10, ["Arithmetic & Algebra"]),
          t("Data Sufficiency", 4, 12, ["Problem Solving"]),
          t("Geometry & Word Problems", 3, 8, ["Arithmetic & Algebra"]),
        ],
      },
      {
        name: "Integrated Reasoning",
        topics: [
          t("Multi-Source Reasoning", 3, 6),
          t("Table Analysis", 2, 4),
          t("Two-Part Analysis", 3, 6),
        ],
      },
    ],
  },
];

// ─── Lookup helpers ───────────────────────────────────────────────────────────

/**
 * Fuzzy-match a user input string against known exam aliases.
 * Returns the first matching exam, or null if none found.
 */
export function findExam(input: string): CurriculumExamDef | null {
  const normalized = input.toLowerCase().trim();
  return (
    CURRICULUM.find((exam) =>
      exam.aliases.some((alias) => normalized.includes(alias)),
    ) ?? null
  );
}

/**
 * Get all topics for an exam, optionally filtered by subject names.
 * Each returned topic is annotated with its parent subject name.
 */
export function getExamTopics(
  exam: CurriculumExamDef,
  subjectNames?: string[],
): Array<CurriculumTopicDef & { subject: string }> {
  const subjects =
    subjectNames && subjectNames.length > 0
      ? exam.subjects.filter((s) =>
          subjectNames.some((n) =>
            s.name.toLowerCase().includes(n.toLowerCase()),
          ),
        )
      : exam.subjects;

  return subjects.flatMap((s) =>
    s.topics.map((topic) => ({ ...topic, subject: s.name })),
  );
}
