"use client";

import { preparePortableSignIn } from "../lib/portable-sign-out";

export function SignedOut() {
  return <main className="grid min-h-dvh place-items-center bg-[#f6f7f5] px-4 text-[#1d211f]">
    <section className="w-full max-w-md rounded-2xl border border-black/[0.07] bg-white p-7 text-center shadow-sm">
      <p className="text-sm font-semibold text-[#216e4e]">Dawar Todo</p>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight">You’re signed out</h1>
      <p className="mt-3 text-sm leading-6 text-[#69716c]">Sign in to access your tasks and bots. Your saved data is kept.</p>
      <a href="/auth/login?return_to=%2Fbots" onClick={preparePortableSignIn} className="mt-6 inline-flex min-h-11 items-center justify-center rounded-xl bg-[#216e4e] px-6 py-2 text-sm font-semibold text-white hover:bg-[#195d41] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#216e4e]">Sign in</a>
    </section>
  </main>;
}
