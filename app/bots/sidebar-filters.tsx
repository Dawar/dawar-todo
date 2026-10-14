"use client";

import type { RefObject } from "react";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import type { BotTeam } from "@/lib/bots-types";

export function SidebarFilters({ search, onSearch, searchRef, archived, onArchived, teams, teamsSupported, teamFilter, onTeamFilter, sort, onSort }: {
  search: string; onSearch: (value: string) => void; searchRef: RefObject<HTMLInputElement | null>;
  archived: boolean; onArchived: (value: boolean) => void;
  teams: BotTeam[]; teamsSupported: boolean; teamFilter: string; onTeamFilter: (value: string) => void;
  sort: "recent" | "team" | "name"; onSort: (value: "recent" | "team" | "name") => void;
}) {
  const selectedTeam = teamFilter === "all" || teamFilter === "none" || teams.some(team => team.id === teamFilter) ? teamFilter : "all";
  return <div className="space-y-2 px-3 pb-3">
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <Input ref={searchRef} aria-label="Search bots" placeholder="Search bots" value={search} onChange={event => onSearch(event.target.value)} className="pl-9 pr-11" />
      {search && <Button type="button" variant="ghost" size="icon" className="absolute right-0 top-0" aria-label="Clear bot search" onClick={() => { onSearch(""); searchRef.current?.focus(); }}><X aria-hidden="true" /></Button>}
    </div>
    <div className="grid grid-cols-2 gap-2">
      <NativeSelect aria-label="Bot visibility" value={archived ? "archived" : "active"} onChange={event => onArchived(event.target.value === "archived")}><option value="active">All bots</option><option value="archived">Archived</option></NativeSelect>
      <NativeSelect aria-label="Bot list order" value={sort} onChange={event => onSort(event.target.value as "recent" | "team" | "name")}><option value="recent">Recent</option><option value="team">Team order</option><option value="name">Name</option></NativeSelect>
      {teamsSupported && <NativeSelect className="col-span-2" aria-label="Filter bots by team" value={selectedTeam} onChange={event => onTeamFilter(event.target.value)}><option value="all">All teams</option><option value="none">No team</option>{teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}</NativeSelect>}
    </div>
  </div>;
}
