import { useState } from "react";
import {
  useListTopics,
  useCreateTopic,
  useUpdateTopic,
  useDeleteTopic,
  getListTopicsQueryKey,
  getGetDashboardSummaryQueryKey,
  getGetPriorityTopicsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription,
} from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useToast } from "@/hooks/use-toast";
import { Plus, Search, Library, Trash2, CheckCircle, Circle, ChevronRight } from "lucide-react";

const topicSchema = z.object({
  name: z.string().min(1, "Name is required"),
  subject: z.string().min(1, "Subject is required"),
  difficultyLevel: z.coerce.number().min(1).max(5),
  estimatedHours: z.coerce.number().min(0.5).max(1000),
  masteryScore: z.coerce.number().min(0).max(1).optional(),
  prerequisites: z.string().optional(),
});

const SUBJECTS = ["Mathematics", "Physics", "Chemistry", "Biology", "History", "Economics", "English", "Computer Science", "Other"];

export default function Topics() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [selectedSubject, setSelectedSubject] = useState<string>("all");

  const { data: topics, isLoading } = useListTopics();
  const createTopic = useCreateTopic();
  const updateTopic = useUpdateTopic();
  const deleteTopic = useDeleteTopic();

  const form = useForm<z.infer<typeof topicSchema>>({
    resolver: zodResolver(topicSchema),
    defaultValues: {
      name: "",
      subject: "",
      difficultyLevel: 3,
      estimatedHours: 10,
      masteryScore: 0,
      prerequisites: "",
    },
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListTopicsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetPriorityTopicsQueryKey() });
  };

  function onSubmit(data: z.infer<typeof topicSchema>) {
    const prereqs = data.prerequisites
      ? data.prerequisites.split(",").map((s) => parseInt(s.trim())).filter((n) => !isNaN(n))
      : [];

    createTopic.mutate(
      {
        data: {
          name: data.name,
          subject: data.subject,
          difficultyLevel: data.difficultyLevel,
          estimatedHours: data.estimatedHours,
          masteryScore: data.masteryScore ?? 0,
          prerequisites: prereqs,
        },
      },
      {
        onSuccess: () => {
          toast({ title: "Topic created" });
          setAddOpen(false);
          form.reset();
          invalidate();
        },
        onError: () => {
          toast({ title: "Error", description: "Could not create topic.", variant: "destructive" });
        },
      }
    );
  }

  function toggleComplete(topicId: number, isCompleted: boolean) {
    updateTopic.mutate(
      { id: topicId, data: { isCompleted: !isCompleted } },
      {
        onSuccess: () => {
          invalidate();
        },
      }
    );
  }

  function confirmDelete() {
    if (!deleteId) return;
    deleteTopic.mutate(
      { id: deleteId },
      {
        onSuccess: () => {
          toast({ title: "Topic deleted" });
          setDeleteId(null);
          invalidate();
        },
        onError: () => {
          toast({ title: "Error", description: "Could not delete topic.", variant: "destructive" });
        },
      }
    );
  }

  const subjects = topics ? ["all", ...Array.from(new Set(topics.map((t) => t.subject)))] : ["all"];

  const filtered = topics?.filter((t) => {
    const matchesSearch = t.name.toLowerCase().includes(search.toLowerCase()) || t.subject.toLowerCase().includes(search.toLowerCase());
    const matchesSubject = selectedSubject === "all" || t.subject === selectedSubject;
    return matchesSearch && matchesSubject;
  }) ?? [];

  return (
    <div className="space-y-6" data-testid="topics-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Topics</h1>
          <p className="text-muted-foreground">{topics?.length ?? 0} topics in your curriculum</p>
        </div>
        <Button onClick={() => setAddOpen(true)} data-testid="button-add-topic">
          <Plus className="h-4 w-4 mr-2" />
          Add Topic
        </Button>
      </div>

      <div className="flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search topics..."
            className="pl-9"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="input-search"
          />
        </div>
        <div className="flex gap-2 flex-wrap">
          {subjects.map((s) => (
            <Button
              key={s}
              variant={selectedSubject === s ? "default" : "outline"}
              size="sm"
              onClick={() => setSelectedSubject(s)}
              data-testid={`filter-${s}`}
            >
              {s === "all" ? "All" : s}
            </Button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
            <Library className="h-10 w-10 mb-3 opacity-40" />
            {topics?.length === 0 ? (
              <>
                <p className="font-medium">No topics yet</p>
                <p className="text-sm mt-1">Add your first topic to begin building your curriculum.</p>
                <Button className="mt-4" onClick={() => setAddOpen(true)}>Add your first topic</Button>
              </>
            ) : (
              <p className="font-medium">No topics match your search</p>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((topic) => (
            <Card
              key={topic.id}
              className={`transition-all hover:shadow-sm ${topic.isCompleted ? "opacity-60" : ""}`}
              data-testid={`topic-${topic.id}`}
            >
              <CardContent className="pt-4 pb-4">
                <div className="flex items-start gap-3">
                  <button
                    onClick={() => toggleComplete(topic.id, topic.isCompleted)}
                    className="mt-0.5 shrink-0 text-muted-foreground hover:text-primary transition-colors"
                    data-testid={`toggle-complete-${topic.id}`}
                  >
                    {topic.isCompleted ? (
                      <CheckCircle className="h-5 w-5 text-primary" />
                    ) : (
                      <Circle className="h-5 w-5" />
                    )}
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <h3 className={`font-semibold ${topic.isCompleted ? "line-through" : ""}`}>{topic.name}</h3>
                      <Badge variant="outline" className="text-xs">{topic.subject}</Badge>
                      <Badge variant="secondary" className="text-xs">
                        {"★".repeat(topic.difficultyLevel)}{"☆".repeat(5 - topic.difficultyLevel)}
                      </Badge>
                      {topic.prerequisites.length > 0 && (
                        <Badge variant="outline" className="text-xs text-muted-foreground">
                          {topic.prerequisites.length} prereq{topic.prerequisites.length > 1 ? "s" : ""}
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-4 text-xs text-muted-foreground mb-2">
                      <span>{topic.estimatedHours}h estimated</span>
                      <span>Mastery: {Math.round(topic.masteryScore * 100)}%</span>
                      <span>Priority: {topic.priorityScore.toFixed(2)}</span>
                      {topic.lastStudiedAt && (
                        <span>Last: {new Date(topic.lastStudiedAt).toLocaleDateString()}</span>
                      )}
                    </div>
                    <Progress value={topic.masteryScore * 100} className="h-1.5" />
                  </div>
                  <button
                    onClick={() => setDeleteId(topic.id)}
                    className="shrink-0 text-muted-foreground hover:text-destructive transition-colors mt-0.5"
                    data-testid={`delete-topic-${topic.id}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Topic</DialogTitle>
            <DialogDescription>
              Add a topic to your study curriculum. The scheduler will prioritize it using the dependency graph.
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Topic Name</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Differential Equations" data-testid="input-topic-name" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="subject"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Subject</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-subject">
                          <SelectValue placeholder="Select subject" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {SUBJECTS.map((s) => (
                          <SelectItem key={s} value={s}>{s}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={form.control}
                  name="difficultyLevel"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Difficulty (1-5)</FormLabel>
                      <FormControl>
                        <Input type="number" min="1" max="5" data-testid="input-difficulty" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="estimatedHours"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Estimated Hours</FormLabel>
                      <FormControl>
                        <Input type="number" min="0.5" step="0.5" data-testid="input-estimated-hours" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="masteryScore"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Initial Mastery (0-1)</FormLabel>
                    <FormControl>
                      <Input type="number" min="0" max="1" step="0.05" placeholder="0.0" data-testid="input-mastery" {...field} />
                    </FormControl>
                    <FormDescription>0 = no knowledge, 1 = complete mastery</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="prerequisites"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Prerequisites (Topic IDs, comma-separated)</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. 1, 3" data-testid="input-prerequisites" {...field} />
                    </FormControl>
                    <FormDescription>The scheduler won't assign this until prerequisites reach 60% mastery.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button type="submit" className="w-full" disabled={createTopic.isPending} data-testid="button-submit-topic">
                {createTopic.isPending ? "Adding..." : "Add Topic"}
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteId !== null} onOpenChange={(open) => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete topic?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the topic and all its scheduling data. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
