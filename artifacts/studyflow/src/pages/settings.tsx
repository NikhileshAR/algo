import {
  useGetStudentProfile,
  useUpdateStudentProfile,
  getGetStudentProfileQueryKey,
  getGetDashboardSummaryQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
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
import { Info } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useValidationMode } from "@/lib/validation-mode";

const settingsSchema = z.object({
  name: z.string().min(1, "Name is required"),
  examName: z.string().min(1, "Exam name is required"),
  examDate: z.string().min(1, "Exam date is required"),
  dailyTargetHours: z.coerce.number().min(1).max(24),
});

function StateVectorCard({
  label,
  value,
  max,
  description,
  unit,
}: {
  label: string;
  value: number;
  max: number;
  description: string;
  unit?: string;
}) {
  const pct = Math.min((value / max) * 100, 100);
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-sm">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">
          {value.toFixed(2)}{unit}
        </span>
      </div>
      <Progress value={pct} className="h-2" />
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

export default function Settings() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: profile, isLoading } = useGetStudentProfile();
  const updateProfile = useUpdateStudentProfile();
  const [mode, setMode] = useValidationMode();

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

  return (
    <div className="space-y-6 max-w-2xl" data-testid="settings-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">Manage your exam profile and review your system state</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Validation Mode</CardTitle>
          <CardDescription>
            Run 7 days baseline first, then 7 days adaptive, for clean same-user comparison.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Select value={mode} onValueChange={(value) => setMode(value as "adaptive" | "baseline")}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="baseline">Baseline (fixed hours, sequential topics, no reset)</SelectItem>
              <SelectItem value="adaptive">Adaptive (full scheduler + reset logic)</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Current mode affects today’s generated schedule immediately.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Exam Profile</CardTitle>
          <CardDescription>These details are used to compute urgency scores and schedule capacity.</CardDescription>
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
                      The system adapts to your actual performance — this is a target, not a hard constraint.
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
          <CardTitle className="text-base">System State Vector S = (M, C, K, D, A)</CardTitle>
          <CardDescription>
            These values are updated automatically each session. They drive the scheduling engine.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-start gap-2 text-xs text-muted-foreground bg-muted/50 rounded-md p-3">
            <Info className="h-3 w-3 mt-0.5 shrink-0" />
            <span>
              The scheduling engine models discipline as a stochastic variable. These scores reflect your observed behaviour, not your intentions. They stabilise over time as more sessions are recorded.
            </span>
          </div>

          <StateVectorCard
            label="Capacity (K)"
            value={profile.capacityScore}
            max={12}
            description="Smoothed average of actual daily study hours. Formula: K(t+1) = 0.8·K(t) + 0.2·H(t)"
            unit="h/day"
          />
          <StateVectorCard
            label="Discipline (D)"
            value={profile.disciplineScore}
            max={1}
            description="Ratio of actual focused study time to scheduled study time. Range: 0–1"
          />
          <StateVectorCard
            label="Active Practice Ratio (A)"
            value={profile.activePracticeRatio}
            max={1}
            description="Proportion of sessions that are active practice (vs lectures). Determines session type in schedule."
          />
        </CardContent>
      </Card>
    </div>
  );
}
