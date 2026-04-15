import { useListSessions } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { History, FlaskConical, BookOpen } from "lucide-react";

export default function Sessions() {
  const { data: sessions, isLoading } = useListSessions({ limit: 50 });

  return (
    <div className="space-y-6" data-testid="sessions-page">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Study History</h1>
        <p className="text-muted-foreground">{sessions?.length ?? 0} sessions logged</p>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      ) : sessions && sessions.length > 0 ? (
        <div className="space-y-2">
          {sessions.map((session) => (
            <Card key={session.id} data-testid={`session-${session.id}`}>
              <CardContent className="pt-4 pb-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 text-muted-foreground">
                      {session.sessionType === "practice" ? (
                        <FlaskConical className="h-5 w-5" />
                      ) : (
                        <BookOpen className="h-5 w-5" />
                      )}
                    </div>
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-semibold">{session.topicName}</h3>
                        <Badge variant={session.sessionType === "practice" ? "default" : "secondary"} className="text-xs">
                          {session.sessionType}
                        </Badge>
                        {session.testScore !== null && session.testScoreMax !== null && (
                          <Badge variant="outline" className="text-xs">
                            Score: {session.testScore}/{session.testScoreMax} ({Math.round((session.testScore / session.testScoreMax) * 100)}%)
                          </Badge>
                        )}
                      </div>
                      {session.notes && (
                        <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{session.notes}</p>
                      )}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-medium">{session.durationMinutes}m</p>
                    <p className="text-xs text-muted-foreground">
                      {new Date(session.studiedAt).toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center text-muted-foreground">
            <History className="h-10 w-10 mb-3 opacity-40" />
            <p className="font-medium">No sessions yet</p>
            <p className="text-sm mt-1">Your study history will appear here after you log your first session.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
