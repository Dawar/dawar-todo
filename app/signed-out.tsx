"use client";

import { preparePortableSignIn } from "../lib/portable-sign-out";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function SignedOut({ signInFailed = false }: { signInFailed?: boolean }) {
  return <main className="grid min-h-dvh place-items-center bg-background px-4 py-10 text-foreground">
    <Card className="w-full max-w-md text-center">
      <CardHeader>
        <p className="text-sm font-medium text-primary">Dawar Todo</p>
        <CardTitle className="pt-2 text-2xl">{signInFailed ? "Couldn’t sign in" : "You’re signed out"}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm leading-6 text-muted-foreground">{signInFailed ? "Sign-in wasn’t completed. Try again with the account you use for Dawar Todo." : "Sign in to access your tasks and bots. Your saved data is kept."}</p>
        <Button className="mt-6" asChild><a href="/auth/login?return_to=%2Fbots" onClick={preparePortableSignIn}>{signInFailed ? "Try again" : "Sign in"}</a></Button>
      </CardContent>
    </Card>
  </main>;
}
