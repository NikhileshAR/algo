import { useGetStudentProfile, useCreateStudentProfile, getGetStudentProfileQueryKey } from "@workspace/api-client-react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Loader2, ArrowRight, Bot, CheckCircle2, Plus, X, Sparkles, BookOpen, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";

const LEVELS = ["beginner", "intermediate", "advanced"] as const;
type Level = typeof LEVELS[number];

const onboardingSchema = z.object({
  name: z.string().min(1, "Name is required"),
  examName: z.string().min(1, "Exam name is required"),
  examDate: z.string().min(1, "Exam date is required"),
  dailyTargetHours: z.coerce.number().min(1, "Target hours must be at least 1").max(24, "Target hours must be 24 or less"),
});

type OnboardingFormData = z.infer<typeof onboardingSchema>;

interface AiSuggestedTopic {
  name: string;
  subject: string;
  difficultyLevel: number;
  estimatedHours: number;
  masteryScore: number;
}

interface AiEnrichmentResult {
  studyStrategy: string;
  scheduleTone: "aggressive" | "balanced" | "relaxed";
  suggestedTopics: AiSuggestedTopic[];
}

type Step = "profile" | "subjects" | "ai-enriching" | "review" | "creating" | "done";

async function callAiEnrich(body: {
  subjects: string[];
  currentLevel: Level;
  specificGoals?: string;
}): Promise<AiEnrichmentResult> {
  const res = await fetch("/api/ai/onboarding-enrich", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(data.error ?? `AI request failed (${res.status})`);
  }
  return res.json() as Promise<AiEnrichmentResult>;
}

async function createTopic(topic: AiSuggestedTopic): Promise<void> {
  const res = await fetch("/api/topics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...topic, masteryScore: 0 }),
  });
  if (!res.ok) throw new Error(`Failed to create topic: ${topic.name}`);
}

export default function Onboarding() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const [step, setStep] = useState<Step>("profile");
  const [subjectInput, setSubjectInput] = useState("");
  const [subjects, setSubjects] = useState<string[]>([]);
  const [currentLevel, setCurrentLevel] = useState<Level>("beginner");
  const [specificGoals, setSpecificGoals] = useState("");
  const [enrichment, setEnrichment] = useState<AiEnrichmentResult | null>(null);
  const [selectedTopics, setSelectedTopics] = useState<Set<number>>(new Set());
  const [aiError, setAiError] = useState<string | null>(null);
  const [creatingProgress, setCreatingProgress] = useState(0);

  const { data: profile, isLoading: isLoadingProfile } = useGetStudentProfile({
    query: { queryKey: getGetStudentProfileQueryKey(), retry: false },
  });

  const createProfile = useCreateStudentProfile();

  const form = useForm<OnboardingFormData>({
    resolver: zodResolver(onboardingSchema),
    defaultValues: {
      name: "",
      examName: "",
      examDate: "",
      dailyTargetHours: 4,
    },
  });

  const aiMutation = useMutation({
    mutationFn: callAiEnrich,
    onSuccess: (data) => {
      setEnrichment(data);
      setSelectedTopics(new Set(data.suggestedTopics.map((_, i) => i)));
      setStep("review");
    },
    onError: (err: Error) => {
      setAiError(err.message);
      setStep("subjects");
    },
  });

  useEffect(() => {
    if (profile && !isLoadingProfile) setLocation("/");
  }, [profile, isLoadingProfile, setLocation]);

  function addSubject() {
    const trimmed = subjectInput.trim();
    if (trimmed && !subjects.includes(trimmed)) {
      setSubjects((prev) => [...prev, trimmed]);
    }
    setSubjectInput("");
  }

  function removeSubject(s: string) {
    setSubjects((prev) => prev.filter((x) => x !== s));
  }

  function handleSubjectKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      addSubject();
    }
  }

  function toggleTopic(idx: number) {
    setSelectedTopics((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  function onProfileSubmit(data: OnboardingFormData) {
    createProfile.mutate(
      { data },
      {
        onSuccess: () => setStep("subjects"),
        onError: () => {
          toast({ title: "Error", description: "Could not create profile. Please try again.", variant: "destructive" });
        },
      }
    );
  }

  async function handleAiEnrich() {
    if (subjects.length === 0) {
      toast({ title: "Add subjects", description: "Please add at least one subject.", variant: "destructive" });
      return;
    }
    setAiError(null);
    setStep("ai-enriching");
    aiMutation.mutate({ subjects, currentLevel, specificGoals: specificGoals.trim() || undefined });
  }

  async function handleSkipAi() {
    setLocation("/");
  }

  async function handleConfirmTopics() {
    if (!enrichment) return;
    setStep("creating");
    const topicsToCreate = enrichment.suggestedTopics.filter((_, i) => selectedTopics.has(i));
    let created = 0;
    for (const topic of topicsToCreate) {
      try {
        await createTopic(topic);
      } catch {
        /* best-effort */
      }
      created++;
      setCreatingProgress(Math.round((created / topicsToCreate.length) * 100));
    }
    toast({ title: "Welcome to StudyFlow", description: `${created} topics loaded. Your cockpit is ready.` });
    setLocation("/");
  }

  if (isLoadingProfile) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (profile) return null;

  const stepNumber = { profile: 1, subjects: 2, "ai-enriching": 2, review: 3, creating: 3, done: 3 }[step];
  const totalSteps = 3;

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="max-w-lg w-full space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-700">
        <div className="text-center space-y-2">
          <div className="mx-auto h-12 w-12 rounded-xl bg-primary text-primary-foreground flex items-center justify-center font-bold text-2xl shadow-lg">S</div>
          <h1 className="text-3xl font-bold tracking-tight">StudyFlow</h1>
          <p className="text-muted-foreground">Your adaptive exam preparation companion</p>
        </div>

        <div className="flex items-center gap-2 px-2">
          {Array.from({ length: totalSteps }).map((_, i) => (
            <div key={i} className={`flex-1 h-1.5 rounded-full transition-colors ${i + 1 <= stepNumber ? "bg-primary" : "bg-muted"}`} />
          ))}
        </div>

        {/* Step 1: Profile */}
        {step === "profile" && (
          <Card className="border-border/50 shadow-xl">
            <CardHeader>
              <CardTitle>Set up your cockpit</CardTitle>
              <CardDescription>Basic info to calibrate your adaptive scheduler</CardDescription>
            </CardHeader>
            <CardContent>
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onProfileSubmit)} className="space-y-5">
                  <FormField control={form.control} name="name" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Your Name</FormLabel>
                      <FormControl><Input placeholder="Alex" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="examName" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Target Exam</FormLabel>
                      <FormControl><Input placeholder="USMLE Step 1, Bar Exam, CFA..." {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="examDate" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Exam Date</FormLabel>
                      <FormControl><Input type="date" {...field} /></FormControl>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <FormField control={form.control} name="dailyTargetHours" render={({ field }) => (
                    <FormItem>
                      <FormLabel>Daily Study Goal (Hours)</FormLabel>
                      <FormControl><Input type="number" min="1" max="24" {...field} /></FormControl>
                      <FormDescription>Be realistic. StudyFlow adapts if you over or under perform.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )} />
                  <Button type="submit" className="w-full" disabled={createProfile.isPending}>
                    {createProfile.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                    Continue <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                </form>
              </Form>
            </CardContent>
          </Card>
        )}

        {/* Step 2: Subjects + AI enrichment */}
        {(step === "subjects" || step === "ai-enriching") && (
          <Card className="border-border/50 shadow-xl">
            <CardHeader>
              <div className="flex items-center gap-2">
                <Bot className="h-5 w-5 text-primary" />
                <CardTitle>AI Study Planner</CardTitle>
              </div>
              <CardDescription>Tell the AI what you're studying — it will build your topic list and strategy</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {aiError && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>{aiError}</span>
                </div>
              )}

              <div className="space-y-2">
                <p className="text-sm font-medium">Subjects to study</p>
                <div className="flex gap-2">
                  <Input
                    placeholder="e.g. Biochemistry, Physiology..."
                    value={subjectInput}
                    onChange={(e) => setSubjectInput(e.target.value)}
                    onKeyDown={handleSubjectKeyDown}
                    disabled={step === "ai-enriching"}
                  />
                  <Button type="button" variant="outline" size="icon" onClick={addSubject} disabled={step === "ai-enriching"}>
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
                {subjects.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {subjects.map((s) => (
                      <Badge key={s} variant="secondary" className="gap-1">
                        {s}
                        {step !== "ai-enriching" && (
                          <button onClick={() => removeSubject(s)} className="ml-1 hover:text-destructive">
                            <X className="h-3 w-3" />
                          </button>
                        )}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <p className="text-sm font-medium">Current knowledge level</p>
                <div className="grid grid-cols-3 gap-2">
                  {LEVELS.map((level) => (
                    <button
                      key={level}
                      type="button"
                      disabled={step === "ai-enriching"}
                      onClick={() => setCurrentLevel(level)}
                      className={`rounded-lg border p-2.5 text-sm capitalize transition-colors ${
                        currentLevel === level
                          ? "border-primary bg-primary/10 text-primary font-medium"
                          : "border-border bg-muted/30 hover:bg-muted/60"
                      }`}
                    >
                      {level}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-sm font-medium">Specific goals <span className="text-muted-foreground font-normal">(optional)</span></p>
                <Textarea
                  placeholder="e.g. Pass with 260+, focus on high-yield topics only..."
                  value={specificGoals}
                  onChange={(e) => setSpecificGoals(e.target.value)}
                  disabled={step === "ai-enriching"}
                  className="resize-none"
                  rows={2}
                />
              </div>

              <div className="flex gap-2 pt-1">
                <Button className="flex-1" onClick={handleAiEnrich} disabled={step === "ai-enriching" || subjects.length === 0}>
                  {step === "ai-enriching" ? (
                    <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> AI is building your plan…</>
                  ) : (
                    <><Sparkles className="mr-2 h-4 w-4" /> Generate Study Plan</>
                  )}
                </Button>
                <Button variant="ghost" onClick={handleSkipAi} disabled={step === "ai-enriching"}>
                  Skip
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Step 3: Review AI suggestions */}
        {(step === "review" || step === "creating") && enrichment && (
          <Card className="border-border/50 shadow-xl">
            <CardHeader>
              <div className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-primary" />
                <CardTitle>Your AI Study Plan</CardTitle>
              </div>
              <CardDescription>{enrichment.studyStrategy}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Schedule tone</span>
                <Badge variant={enrichment.scheduleTone === "aggressive" ? "destructive" : enrichment.scheduleTone === "relaxed" ? "secondary" : "default"} className="capitalize">
                  {enrichment.scheduleTone}
                </Badge>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <p className="font-medium flex items-center gap-1.5"><BookOpen className="h-4 w-4" /> Suggested Topics</p>
                  <span className="text-muted-foreground text-xs">{selectedTopics.size}/{enrichment.suggestedTopics.length} selected</span>
                </div>
                <div className="max-h-64 overflow-y-auto space-y-1.5 pr-1">
                  {enrichment.suggestedTopics.map((topic, i) => (
                    <button
                      key={i}
                      type="button"
                      disabled={step === "creating"}
                      onClick={() => toggleTopic(i)}
                      className={`w-full flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                        selectedTopics.has(i)
                          ? "border-primary/50 bg-primary/5"
                          : "border-border bg-muted/20 opacity-50"
                      }`}
                    >
                      <CheckCircle2 className={`h-4 w-4 shrink-0 ${selectedTopics.has(i) ? "text-primary" : "text-muted-foreground"}`} />
                      <span className="flex-1 font-medium">{topic.name}</span>
                      <Badge variant="outline" className="text-xs py-0 shrink-0">{topic.subject}</Badge>
                      <span className="text-muted-foreground text-xs shrink-0">{topic.estimatedHours}h</span>
                    </button>
                  ))}
                </div>
              </div>

              {step === "creating" && (
                <div className="space-y-1.5">
                  <p className="text-xs text-muted-foreground">Creating topics…</p>
                  <Progress value={creatingProgress} className="h-1.5" />
                </div>
              )}

              <div className="flex gap-2">
                <Button className="flex-1" onClick={handleConfirmTopics} disabled={step === "creating" || selectedTopics.size === 0}>
                  {step === "creating" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  {step === "creating" ? "Creating…" : `Add ${selectedTopics.size} Topics & Start`}
                </Button>
                <Button variant="ghost" onClick={() => setLocation("/")} disabled={step === "creating"}>
                  Skip
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
