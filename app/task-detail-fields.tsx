"use client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";
import { ActionIcon } from "./action-icon";

type DetailMetadata = {project: string; context: string; priority: number; dueDate: string; recurrenceCron: string};
export function TaskDetailFields({taskId, editDraft, savingEdit, recurrenceError, scheduleTimeZone, onAssignProject, updateEditDraftField}: {
  taskId: number;
  editDraft: DetailMetadata;
  savingEdit: boolean;
  recurrenceError: string | null;
  scheduleTimeZone: string;
  onAssignProject: () => void;
  updateEditDraftField: <K extends keyof DetailMetadata>(field: K, value: DetailMetadata[K]) => void;
}) {
  return (
<div className="mt-4 grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="block min-w-0">
                  <span className="mb-1.5 block text-sm font-medium text-muted-foreground">Project</span>
                  <Button variant="ghost"
                    type="button"
                    onClick={onAssignProject}
                    disabled={savingEdit}
                    aria-label={`Assign project. Current project: ${editDraft.project || "Unassigned"}`}
                    className="w-full min-w-0 justify-between border border-input px-3 text-base sm:text-sm"
                  >
                    <span className="min-w-0 truncate">{editDraft.project || "Unassigned"}</span>
                    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-semibold text-primary"><ActionIcon name="move" />Change</span>
                  </Button>
                </div>
                <label className="block min-w-0">
                  <span className="mb-1.5 block text-sm font-medium text-muted-foreground">Context</span>
                  <Input value={editDraft.context} onChange={(event) => updateEditDraftField("context", event.target.value)} placeholder="No context" className="min-w-0" />
                </label>
                <label className="block min-w-0">
                  <span className="mb-1.5 flex items-center text-sm font-medium text-muted-foreground sm:min-h-8">Priority</span>
                  <NativeSelect value={editDraft.priority} onChange={(event) => updateEditDraftField("priority", Number(event.target.value))} className="min-w-0">
                    <option value="1">Urgent</option>
                    <option value="2">High</option>
                    <option value="3">Normal</option>
                    <option value="4">Low</option>
                  </NativeSelect>
                </label>
                <div className="block min-w-0">
                  <div className="mb-1.5 flex min-h-11 sm:min-h-8 items-center justify-between gap-2">
                    <label htmlFor={`task-due-date-${taskId}`} className="text-sm font-medium text-muted-foreground">Due date</label>
                    <Button variant="ghost"
                      type="button"
                      onClick={() => updateEditDraftField("dueDate", "")}
                      disabled={!editDraft.dueDate}
                      aria-label="Clear due date"
                      size="sm" className="text-primary disabled:invisible"
                    >
                      <ActionIcon name="close" className="h-3 w-3" />Clear
                    </Button>
                  </div>
                  <Input id={`task-due-date-${taskId}`} type="date" value={editDraft.dueDate} onChange={(event) => updateEditDraftField("dueDate", event.target.value)} className="min-w-0" />
                </div>
                <label className="block min-w-0 sm:col-span-2">
                  <span className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-muted-foreground"><ActionIcon name="repeat" className="h-3.5 w-3.5" />Recurring schedule</span>
                  <Input
                    value={editDraft.recurrenceCron}
                    onChange={(event) => updateEditDraftField("recurrenceCron", event.target.value)}
                    placeholder="0 9 * * 1-5"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    aria-invalid={Boolean(recurrenceError)}
                    aria-describedby={`task-recurrence-help-${taskId}`}
                    className={cn("font-mono", recurrenceError && "border-destructive focus-visible:ring-destructive")}
                  />
                  <p id={`task-recurrence-help-${taskId}`} className={cn("mt-1.5 text-[13px] leading-5", recurrenceError ? "font-medium text-red-600" : "text-muted-foreground")}>{recurrenceError ?? `Five-field cron in ${scheduleTimeZone}. Recurring tasks cannot be snoozed.`}</p>
                </label>
              </div>
  );
}
