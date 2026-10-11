"use client";

import { ControlledDialog } from "@/components/ui/controlled-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ActionIcon } from "./action-icon";
import { cn } from "@/lib/utils";

type Counts = { open: number; snoozed: number; done: number };
type ProjectView = "open" | "snoozed" | "done" | "all";
const countsLabel = (counts: Counts) => `${counts.open} open · ${counts.snoozed} snoozed · ${counts.done} done`;

export function ProjectBrowser({ selected, total, unassigned, unassignedValue, projects, loading, onSelect, onView, onCreate, onDelete, onClose }: {
  selected: string; total: number; unassigned: Counts; unassignedValue: string;
  projects: [string, Counts][]; loading: boolean;
  onSelect: (name: string) => void; onView: (name: string, view: ProjectView) => void;
  onCreate: () => void; onDelete: (name: string) => void; onClose: () => void;
}) {
  return <ControlledDialog title="Projects" onClose={onClose} onEscapeKeyDown={event => event.stopPropagation()} className="max-w-3xl">
    <div className="flex justify-start"><Button type="button" onClick={onCreate}><ActionIcon name="create-project"/>New project</Button></div>
    <div className="grid gap-3 sm:grid-cols-2">
      {[
        { id: "", name: "All projects", detail: `${total} tasks`, icon: "view-all" as const },
        { id: unassignedValue, name: "Unassigned", detail: countsLabel(unassigned), icon: "folder" as const },
      ].map(item => <Button key={item.id} type="button" variant="outline" aria-pressed={selected === item.id} onClick={() => onSelect(item.id)} className="h-auto sm:h-auto min-h-20 justify-start whitespace-normal p-4 text-left aria-pressed:border-primary aria-pressed:bg-accent">
        <ActionIcon name={item.icon}/><span className="min-w-0"><span className="block font-medium">{item.name}</span><span className="mt-1 block text-[13px] font-normal text-muted-foreground">{item.detail}</span></span>
      </Button>)}
    </div>
    {loading ? <div role="status" aria-label="Loading projects" className="grid gap-3 sm:grid-cols-2">{[0,1,2,3].map(key => <Skeleton key={key} className="h-36 rounded-lg"/>)}</div>
    : projects.length ? <ul className="grid gap-3 sm:grid-cols-2">
      {projects.map(([name, counts]) => <li key={name} className="min-w-0">
        <Card className={cn("flex h-full flex-col overflow-hidden shadow-none", selected === name && "border-primary bg-accent")}>
          <Button type="button" variant="ghost" aria-pressed={selected === name} onClick={() => onSelect(name)} className="h-auto sm:h-auto min-h-24 w-full flex-1 items-start justify-start whitespace-normal rounded-none p-4 text-left" aria-label={`Select ${name}, ${counts.open + counts.snoozed + counts.done} tasks`}>
            <ActionIcon name="folder"/><span className="min-w-0"><span className="block break-words text-sm font-medium">{name}</span><span className="mt-1 block text-[13px] font-normal text-muted-foreground">{countsLabel(counts)}</span></span>
          </Button>
          <div className="grid grid-cols-5 border-t border-border" role="group" aria-label={`Actions for ${name}`}>
            {([['open','view-open','Open'],['snoozed','snooze','Snoozed'],['done','done','Done'],['all','view-all','All']] as const).map(([view,icon,label]) => <Button key={view} type="button" variant="ghost" size="icon" className="w-full rounded-none sm:w-full" onClick={() => onView(name,view)} aria-label={`View ${label.toLowerCase()} tasks in ${name}`} title={label}><ActionIcon name={icon}/></Button>)}
            <Button type="button" variant="ghost" size="icon" className="w-full rounded-none text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:w-full" onClick={() => onDelete(name)} aria-label={`Delete project: ${name}`} title="Delete project"><ActionIcon name="delete"/></Button>
          </div>
        </Card>
      </li>)}
    </ul> : <div className="rounded-lg border border-dashed border-border px-5 py-8 text-center"><p className="text-sm font-medium">No projects yet</p><p className="mt-2 text-sm text-muted-foreground">Create a project to group related tasks.</p></div>}
  </ControlledDialog>;
}
