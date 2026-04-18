export interface PageClassification {
  isStudy: boolean;
  topic: string | null;
  confidence: number;
}

export interface YouTubeMetadata {
  title: string;
  channelName: string;
}

const KNOWN_STUDY_DOMAINS = [
  "khanacademy.org",
  "coursera.org",
  "ncert.nic.in",
  "physicswallah.live",
  "pw.live",
];

const YOUTUBE_STUDY_CHANNELS = new Set([
  "Physics Wallah",
  "Khan Academy",
  "MIT OpenCourseWare",
  "3Blue1Brown",
]);

const TOPIC_KEYWORDS: Array<{ topic: string; keywords: string[] }> = [
  { topic: "Electrostatics", keywords: ["electric field", "gauss law", "electrostatics", "coulomb"] },
  { topic: "Calculus", keywords: ["integration", "integral", "derivative", "differentiation", "limits"] },
  { topic: "Mechanics", keywords: ["kinematics", "newton", "force", "momentum", "work energy"] },
  { topic: "Thermodynamics", keywords: ["thermodynamics", "entropy", "heat engine", "first law"] },
  { topic: "Organic Chemistry", keywords: ["organic", "hydrocarbon", "reaction mechanism"] },
  { topic: "Algebra", keywords: ["algebra", "equation", "polynomial", "matrix"] },
  { topic: "Trigonometry", keywords: ["trigonometry", "sin", "cos", "tan"] },
  { topic: "Probability", keywords: ["probability", "bayes", "random variable", "distribution"] },
];

function safeHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function topicFromText(text: string): { topic: string | null; confidence: number } {
  const normalized = normalize(text);

  let bestTopic: string | null = null;
  let bestMatches = 0;

  for (const entry of TOPIC_KEYWORDS) {
    const matches = entry.keywords.filter((k) => normalized.includes(k)).length;
    if (matches > bestMatches) {
      bestMatches = matches;
      bestTopic = entry.topic;
    }
  }

  if (!bestTopic) {
    return { topic: null, confidence: 0.1 };
  }

  const confidence = Math.min(0.95, 0.45 + bestMatches * 0.2);
  return { topic: bestTopic, confidence };
}

export function classifyYouTubePage(meta: YouTubeMetadata): PageClassification {
  const title = normalize(meta.title);
  const channel = meta.channelName.trim();

  const topicGuess = topicFromText(title);
  const titleLooksAcademic = topicGuess.topic !== null || /(lecture|tutorial|course|class|problem solving|jee|neet|exam)/.test(title);
  const channelWhitelisted = YOUTUBE_STUDY_CHANNELS.has(channel);

  if (titleLooksAcademic || channelWhitelisted) {
    return {
      isStudy: true,
      topic: topicGuess.topic,
      confidence: channelWhitelisted ? Math.max(topicGuess.confidence, 0.85) : Math.max(topicGuess.confidence, 0.7),
    };
  }

  return {
    isStudy: false,
    topic: null,
    confidence: 0.85,
  };
}

export function classifyPage(url: string, title: string): PageClassification {
  const host = safeHost(url);
  const text = `${url} ${title}`;
  const isYouTubeHost = host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be";

  if (isYouTubeHost) {
    return {
      isStudy: false,
      topic: topicFromText(text).topic,
      confidence: 0.35,
    };
  }

  const knownStudyDomain = KNOWN_STUDY_DOMAINS.some((domain) => host.includes(domain));
  const topicGuess = topicFromText(text);

  if (knownStudyDomain) {
    return {
      isStudy: true,
      topic: topicGuess.topic,
      confidence: Math.max(0.8, topicGuess.confidence),
    };
  }

  if (topicGuess.topic) {
    return {
      isStudy: true,
      topic: topicGuess.topic,
      confidence: Math.max(0.55, topicGuess.confidence),
    };
  }

  return {
    isStudy: false,
    topic: null,
    confidence: 0.8,
  };
}
