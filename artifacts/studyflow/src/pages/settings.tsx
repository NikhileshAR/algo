import {
  useGetStudentProfile,
  useUpdateStudentProfile,
  getGetStudentProfileQueryKey,
  getGetDashboardSummaryQueryKey,
} from "@workspace/api-client-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useToast } from "@/hooks/use-toast";
import { useEffect } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";

const settingsSchema = z.object({
  name: z.string().min(1, "Name is required"),
  examName: z.string().min(1, "Exam name is required"),
  examDate: z.string().min(1, "Exam date is required"),
  dailyTargetHours: z.coerce.number().min(1).max(24),
});

type WeeklySignals = {
  totalHours: number;
  previousWeekHours: number;
  daysWithStudy: number;
  previousWeekDaysWithStudy: number;
  practiceCount: number;
  lectureCount: number;
  previousWeekPracticeCount: number;
  previousWeekLectureCount: number;
};

const TREND_THRESHOLD = 0.01;
const LONG_FOCUS_HOURS_THRESHOLD = 4;
const STABLE_CONSISTENCY_THRESHOLD = 0.7;
const GOOD_PRACTICE_RATIO_THRESHOLD = 0.35;

function formatTrend(delta: number): { label: string; Icon: typeof ArrowUpRight | typeof ArrowDownRight | typeof Minus; className: string } {
  if (delta > TREND_THRESHOLD) return { label: "Improving", Icon: ArrowUpRight, className: "text-emerald-700" };
  if (delta < -TREND_THRESHOLD) return { label: "Dropping", Icon: ArrowDownRight, className: "text-amber-700" };
  return { label: "Steady", Icon: Minus, className: "text-muted-foreground" };
}

function CoachingMetricCard({
  label,
  value,
  max,
  description,
  interpretation,
  trendDelta,
  valueLabel,
}: {
  label: string;
  value: number;
  max: number;
  description: string;
  interpretation: string;
  trendDelta: number;
  valueLabel: string;
}) {
  const pct = Math.min((value / max) * 100, 100);
  const trend = formatTrend(trendDelta);

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <span className={`inline-flex items-center gap-1 text-xs font-medium ${trend.className}`}>
          <trend.Icon className="h-3.5 w-3.5" />
          {trend.label}
        </span>
      </div>
      <Progress value={pct} className="h-2" />
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">{valueLabel}</span>
        <span className="text-xs text-muted-foreground">{interpretation}</span>
      </div>
    </div>
  );
}

export default function Settings() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: profile, isLoading } = useGetStudentProfile();
  const { data: weeklySignals } = useQuery<WeeklySignals>({
    queryKey: ["analytics", "weekly-review", "signals"],
    queryFn: () => fetch("/api/analytics/weekly-review").then((r) => r.json()),
  });
  const updateProfile = useUpdateStudentProfile();

  const form = useForm<z.infer<typeof settingsSchema>>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      name: "",
      examName: "",
      examDate: "",
      dailyTargetHours: 4,
    },
  });

  useEffect(() => {
    if (profile) {
      form.reset({
        name: profile.name,
        examName: profile.examName,
        examDate: profile.examDate,
        dailyTargetHours: profile.dailyTargetHours,
      });
    }
  }, [profile, form]);

  function onSubmit(data: z.infer<typeof settingsSchema>) {
    updateProfile.mutate(
      { data },
      {
        onSuccess: () => {
          toast({ title: "Profile updated" });
          queryClient.invalidateQueries({ queryKey: getGetStudentProfileQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
        },
        onError: () => {
          toast({ title: "Error", description: "Could not update profile.", variant: "destructive" });
        },
      }
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (!profile) return null;

  const currentDailyHours = weeklySignals ? weeklySignals.totalHours / 7 : profile.capacityScore;
  const previousDailyHours = weeklySignals ? weeklySignals.previousWeekHours / 7 : currentDailyHours;
  const consistency = weeklySignals ? weeklySignals.daysWithStudy / 7 : profile.disciplineScore;
  const previousConsistency = weeklySignals ? weeklySignals.previousWeekDaysWithStudy / 7 : consistency;
  const currentPracticeRatio = weeklySignals
    ? weeklySignals.practiceCount / Math.max(weeklySignals.practiceCount + weeklySignals.lectureCount, 1)
    : profile.activePracticeRatio;
  const previousPracticeRatio = weeklySignals
    ? weeklySignals.previousWeekPracticeCount / Math.max(weeklySignals.previousWeekPracticeCount + weeklySignals.previousWeekLectureCount, 1)
    : currentPracticeRatio;

  return (
    <div className="space-y-6 max-w-2xl" data-testid="settings-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">Manage your exam profile and see how your study habits are shifting.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Exam Profile</CardTitle>
          <CardDescription>These details guide urgency and daily mission planning.</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input data-testid="input-name" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="examName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Target Exam</FormLabel>
                    <FormControl>
                      <Input data-testid="input-exam-name" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="examDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Exam Date</FormLabel>
                    <FormControl>
                      <Input type="date" data-testid="input-exam-date" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="dailyTargetHours"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Daily Target Hours</FormLabel>
                    <FormControl>
                      <Input type="number" min="1" max="24" data-testid="input-daily-hours" {...field} />
                    </FormControl>
                    <FormDescription>
                      This is your intent. The app still adapts to real study behavior.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button type="submit" disabled={updateProfile.isPending} data-testid="button-save-settings">
                {updateProfile.isPending ? "Saving..." : "Save Changes"}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Your Study Signals</CardTitle>
          <CardDescription>These update automatically after sessions and show where to adjust this week.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <CoachingMetricCard
            label="Your current daily study stamina"
            value={currentDailyHours}
            max={12}
            valueLabel={`${currentDailyHours.toFixed(1)}h/day`}
            trendDelta={currentDailyHours - previousDailyHours}
            description="How much focused study time you can sustain each day"
            interpretation={currentDailyHours >= LONG_FOCUS_HOURS_THRESHOLD ? "You can hold long focus blocks." : "Build stamina with shorter daily blocks."}
          />

          <CoachingMetricCard
            label="How consistently you follow your plan"
            value={consistency}
            max={1}
            valueLabel={`${Math.round(consistency * 100)}% consistency`}
            trendDelta={consistency - previousConsistency}
            description="How often you actually show up for planned study"
            interpretation={consistency >= STABLE_CONSISTENCY_THRESHOLD ? "Your routine is stable." : "You’re slipping off your plan mid-week."}
          />

          <CoachingMetricCard
            label="How much you solve vs just watch"
            value={currentPracticeRatio}
            max={1}
            valueLabel={`${Math.round(currentPracticeRatio * 100)}% solving`}
            trendDelta={currentPracticeRatio - previousPracticeRatio}
            description="Your practice share across this week’s sessions"
            interpretation={currentPracticeRatio >= GOOD_PRACTICE_RATIO_THRESHOLD ? "Good solve-heavy mix." : "You’re watching more than solving."}
          />
        </CardContent>
      </Card>
    </div>
  );
}
