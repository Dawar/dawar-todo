import Link from "next/link";

export function SiteHeader({ current }: { current: "todos" | "settings" }) {
  return (
    <header className="sticky top-0 z-30 border-b border-black/[0.06] bg-[#f6f7f5]/92 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2.5 rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#216e4e]">
          <span className="grid h-8 w-8 place-items-center rounded-xl bg-[#216e4e] text-base font-semibold text-white shadow-sm" aria-hidden="true">✓</span>
          <span className="text-[15px] font-semibold tracking-[-0.02em]">Dawar Todo</span>
        </Link>
        <div className="flex items-center gap-2">
          {current === "todos" ? (
            <Link href="/settings" className="rounded-lg px-3 py-2 text-sm font-medium text-[#69716c] transition hover:bg-black/[0.04] hover:text-[#252a27] focus-visible:outline-2 focus-visible:outline-[#216e4e]">
              Settings
            </Link>
          ) : (
            <Link href="/" className="rounded-lg px-3 py-2 text-sm font-medium text-[#216e4e] transition hover:bg-[#eaf3ed] focus-visible:outline-2 focus-visible:outline-[#216e4e]">
              Back to tasks
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
