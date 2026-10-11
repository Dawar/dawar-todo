"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function SettingsError({ error, reset }: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[todo-ui] settings route crashed", {
      message: error.message,
      digest: error.digest ?? null,
      onlineHint: navigator.onLine,
    });
  }, [error]);

  return (
    <main className="grid min-h-screen place-items-center bg-background px-4 py-10 text-foreground">
      <Card className="w-full max-w-lg" role="alert">
        <CardHeader>
          <CardTitle className="text-xl">Settings could not open</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm leading-6 text-muted-foreground">Try opening Settings again, or return to your tasks.</p>
          <div className="mt-6 flex flex-col gap-2 sm:flex-row">
            <Button type="button" onClick={reset}>Try again</Button>
            <Button variant="outline" asChild><Link href="/tasks">Back to tasks</Link></Button>
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
