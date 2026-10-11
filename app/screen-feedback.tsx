"use client";
import Link from "next/link";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function ScreenLoading({ label = "Opening…" }: { label?: string }) {
  return <div className="mx-auto flex max-w-5xl items-center gap-2 p-6 text-sm text-muted-foreground" role="status">
    <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden="true" />{label}
  </div>;
}
export function ScreenError({ title = "This screen could not open", onRetry }: { title?: string; onRetry: () => void }) {
  return <main className="grid min-h-[100dvh] place-items-center bg-background px-4 py-10 text-foreground">
    <Card className="w-full max-w-lg" role="alert">
      <CardHeader><CardTitle className="text-xl">{title}</CardTitle></CardHeader>
      <CardContent>
        <p className="text-sm leading-6 text-muted-foreground">Try again, or return to your tasks.</p>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row">
          <Button type="button" onClick={onRetry}>Try again</Button>
          <Button variant="outline" asChild><Link href="/tasks">Back to tasks</Link></Button>
        </div>
      </CardContent>
    </Card>
  </main>;
}
