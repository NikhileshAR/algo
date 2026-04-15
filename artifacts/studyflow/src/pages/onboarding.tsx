import { useGetStudentProfile, useCreateStudentProfile } from "@workspace/api-client-react";
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
import { Button } from "@/components/ui/button";
import { Loader2, ArrowRight } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useEffect } from "react";

const onboardingSchema = z.object({
  name: z.string().min(1, "Name is required"),
  examName: z.string().min(1, "Exam name is required"),
  examDate: z.string().min(1, "Exam date is required"),
  dailyTargetHours: z.coerce.number().min(1, "Target hours must be at least 1").max(24, "Target hours must be 24 or less"),
});

export default function Onboarding() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const { data: profile, isLoading: isLoadingProfile } = useGetStudentProfile({
    query: {
      retry: false,
    },
  });

  const createProfile = useCreateStudentProfile();

  const form = useForm<z.infer<typeof onboardingSchema>>({
    resolver: zodResolver(onboardingSchema),
    defaultValues: {
      name: "",
      examName: "",
      examDate: "",
      dailyTargetHours: 4,
    },
  });

  useEffect(() => {
    if (profile && !isLoadingProfile) {
      setLocation("/");
    }
  }, [profile, isLoadingProfile, setLocation]);

  const onSubmit = (data: z.infer<typeof onboardingSchema>) => {
    createProfile.mutate(
      { data },
      {
        onSuccess: () => {
          toast({
            title: "Welcome to StudyFlow",
            description: "Your academic cockpit is ready.",
          });
          setLocation("/");
        },
        onError: (err) => {
          toast({
            title: "Error",
            description: "Could not create profile. Please try again.",
            variant: "destructive",
          });
        },
      }
    );
  };

  if (isLoadingProfile) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (profile) return null;

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="max-w-md w-full space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
        <div className="text-center space-y-2">
          <div className="mx-auto h-12 w-12 rounded-xl bg-primary text-primary-foreground flex items-center justify-center font-bold text-2xl shadow-lg">
            S
          </div>
          <h1 className="text-3xl font-bold tracking-tight">StudyFlow</h1>
          <p className="text-muted-foreground">Your adaptive exam preparation companion</p>
        </div>

        <Card className="border-border/50 shadow-xl">
          <CardHeader>
            <CardTitle>Let's set up your cockpit</CardTitle>
            <CardDescription>
              StudyFlow models your learning behavior and discipline to build an adaptive control-loop schedule.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Your Name</FormLabel>
                      <FormControl>
                        <Input placeholder="Alex" {...field} />
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
                        <Input placeholder="USMLE Step 1, Bar Exam, CFA..." {...field} />
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
                        <Input type="date" {...field} />
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
                      <FormLabel>Daily Study Goal (Hours)</FormLabel>
                      <FormControl>
                        <Input type="number" min="1" max="24" {...field} />
                      </FormControl>
                      <FormDescription>
                        Be realistic. StudyFlow will adapt if you over or under perform.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <Button 
                  type="submit" 
                  className="w-full" 
                  disabled={createProfile.isPending}
                >
                  {createProfile.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : null}
                  Initialize System <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
