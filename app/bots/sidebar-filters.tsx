"use client";

import type { RefObject } from "react";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function SidebarFilters({ search, onSearch, searchRef, onFocusResults }: {
  search: string; onSearch: (value: string) => void; searchRef: RefObject<HTMLInputElement | null>;
  onFocusResults?: () => boolean;
}) {
  return <div className="space-y-2 px-3 pb-3">
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input ref={searchRef} aria-label="Search bots" aria-keyshortcuts="Meta+K Control+K ArrowDown" title="Search bots (⌘K / Ctrl+K); Down enters the bot list" placeholder="Search bots" value={search} onChange={event => onSearch(event.target.value)} onKeyDown={event => {
        if (event.key === 'ArrowDown' && !event.defaultPrevented && !event.nativeEvent.isComposing && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && onFocusResults?.()) event.preventDefault();
      }} className="pl-9 pr-11" />
      {search && <Button type="button" variant="ghost" size="icon" className="absolute right-0 top-0" aria-label="Clear bot search" onClick={() => { onSearch(""); searchRef.current?.focus(); }}><X aria-hidden="true" /></Button>}
    </div>
  </div>;
}
