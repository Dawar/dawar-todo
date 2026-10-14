"use client";
import { memo, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button } from "@/components/ui/button";
import { ActionIcon, type ActionIconName } from "./action-icon";
import type { Todo } from "./task-model";
import { observeTitleSize, scheduleTitleSize } from "./task-title-layout";
import { isActivelySnoozed as isSnoozed } from "../lib/snooze-clock";
import { nextCronOccurrence } from "../lib/cron";
import { snoozeLabel } from "../lib/snooze-label";
import { formatDueDate, isDueTodayOrOverdue } from "./date-only";
type TodoAction = "complete" | "snooze" | "unsnooze" | "delete";
const SWIPE_ACTION_THRESHOLD = 0.14;
const SWIPE_LONG_ACTION_THRESHOLD = 0.5;
function classNames(...values: Array<string | false | null | undefined>) { return values.filter(Boolean).join(" "); }
const priorityLabels: Record<number, string> = {
  1: "Urgent",
  2: "High",
  3: "Normal",
  4: "Low",
};
function recurrenceLabel(expression: string, status: Todo["status"], now: number, timeZone: string) {
  try {
    const next = nextCronOccurrence(expression, new Date(now), timeZone);
    if (!next) return status === "completed" ? "Scheduled to return" : "Recurring";
    const formatted = new Intl.DateTimeFormat(undefined, {
      timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(next);
    return `${status === "completed" ? "Returns" : "Next"} ${formatted}`;
  } catch {
    return status === "completed" ? "Scheduled to return" : "Recurring";
  }
}
export function SnoozeStatusBadge({ value, now, timeZone }: { value: string; now: number; timeZone: string }) {
  return (
    <span className="inline-flex min-h-[22px] items-center gap-1 rounded-full bg-warning px-2 py-0.5 text-warning-foreground ring-1 ring-inset ring-warning-foreground/20">
      <ActionIcon name="snooze" className="h-3 w-3" />
      {snoozeLabel(value, now, timeZone)}
    </span>
  );
}

export const TaskRow = memo(function TaskRow({
  todo,
  selected,
  now,
  timeZone,
  onSelect,
  onAction,
  onEdit,
  onQueue,
  onPin,
  onAcknowledgeUrgent,
  onTitleChange,
  onTitleBlur,
  onTitleFocus,
  onTitleArrowNavigate,
  onReorderStart,
  onReorderMove,
  onReorderEnd,
  showPin,
  reordering,
  reorderTarget,
}: {
  todo: Todo;
  selected: boolean;
  now: number;
  timeZone: string;
  onSelect: (todo: Todo) => void;
  onAction: (todo: Todo, action: TodoAction, source: "hover" | "swipe") => void;
  onEdit: (todo: Todo, source: "hover" | "swipe") => void;
  onQueue: (todo: Todo) => void;
  onPin: (todo: Todo) => void;
  onAcknowledgeUrgent: (todo: Todo) => void;
  onTitleChange: (todo: Todo, title: string) => void;
  onTitleBlur: (todo: Todo, title: string) => void;
  onTitleFocus: (todo: Todo) => void;
  onTitleArrowNavigate: (todo: Todo, direction: "previous" | "next") => boolean;
  onReorderStart: (todo: Todo, event: ReactPointerEvent<HTMLButtonElement>) => void;
  onReorderMove: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onReorderEnd: (event: ReactPointerEvent<HTMLButtonElement>, cancelled: boolean) => void;
  showPin: boolean;
  reordering: boolean;
  reorderTarget: boolean;
}) {
  const [offset, setOffset] = useState(0);
  const [swipeWidth, setSwipeWidth] = useState(1);
  const [dragging, setDragging] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(todo.title);
  const gesture = useRef<{ startX: number; startY: number; width: number; rail: "left" | "right" } | null>(null);
  const offsetRef = useRef(0);
  const suppressTitleClickRef = useRef(false);
  const titleRef = useRef<HTMLTextAreaElement | null>(null);
  const pending = todo.id < 0;
  const snoozed = isSnoozed(todo, now);
  const recurring = Boolean(todo.recurrenceCron);
  const agentUrgent = todo.status === "open" && todo.priority === 1 && todo.sourceKind === "api-token";
  const primaryAction: { action: TodoAction; label: string; icon: ActionIconName } = todo.status === "open"
    ? { action: "complete", label: "Done", icon: "done" }
    : { action: "unsnooze", label: "Open", icon: "open" };
  const leftSecondaryAction: { action: TodoAction; label: string; icon: ActionIconName } = todo.status === "completed"
    ? primaryAction
    : snoozed
      ? { action: "unsnooze", label: "Wake", icon: "wake" }
      : recurring
        ? primaryAction
        : { action: "snooze", label: "Snooze", icon: "snooze" };
  const swipeRatio = Math.abs(offset) / swipeWidth;
  const longSwipe = swipeRatio >= SWIPE_LONG_ACTION_THRESHOLD;
  const revealAction = offset < 0
    ? (longSwipe ? leftSecondaryAction.label : primaryAction.label)
    : (longSwipe ? "Queue" : "Edit");
  const revealIcon: ActionIconName = offset < 0
    ? (longSwipe ? leftSecondaryAction.icon : primaryAction.icon)
    : (longSwipe ? "forward" : "edit");
  const revealClass = offset < 0
    ? longSwipe && (leftSecondaryAction.icon === "snooze" || leftSecondaryAction.icon === "wake") ? "bg-warning text-warning-foreground" : "bg-primary text-primary-foreground"
    : longSwipe ? "bg-primary text-primary-foreground" : "bg-accent text-accent-foreground";

  function pointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (pending || event.pointerType !== "touch") return;
    const rail = (event.target as HTMLElement).closest<HTMLElement>("[data-swipe-rail]");
    const railSide = rail?.dataset.swipeRail;
    if (railSide !== "left" && railSide !== "right") return;
    suppressTitleClickRef.current = false;
    const width = event.currentTarget.getBoundingClientRect().width;
    gesture.current = {
      startX: event.clientX,
      startY: event.clientY,
      width,
      rail: railSide,
    };
    setSwipeWidth(width);
    setDragging(true);
    console.info("[todo-gesture] mobile task swipe started from side rail", {
      todoId: todo.id,
      rail: railSide,
      source: (event.target as HTMLElement).closest("[data-row-action]") ? "control" : "rail",
      width,
    });
  }

  function pointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const active = gesture.current;
    if (!active) return;
    const deltaX = event.clientX - active.startX;
    const deltaY = event.clientY - active.startY;
    if (Math.abs(deltaY) > Math.abs(deltaX) && Math.abs(deltaY) > 10) {
      console.info("[todo-gesture] mobile task swipe cancelled for vertical movement", {
        todoId: todo.id,
        rail: active.rail,
        deltaX: Math.round(deltaX),
        deltaY: Math.round(deltaY),
      });
      gesture.current = null;
      setDragging(false);
      offsetRef.current = 0;
      setOffset(0);
      return;
    }
    const allowedDeltaX = active.rail === "left"
      ? Math.max(0, deltaX)
      : Math.min(0, deltaX);
    const limit = active.width * 0.62;
    if (Math.abs(allowedDeltaX) > 8) {
      suppressTitleClickRef.current = true;
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
    }
    const nextOffset = Math.max(-limit, Math.min(limit, allowedDeltaX));
    offsetRef.current = nextOffset;
    setOffset(nextOffset);
  }

  function finishSwipe() {
    const active = gesture.current;
    gesture.current = null;
    setDragging(false);
    if (!active) {
      setOffset(0);
      return;
    }
    const completedOffset = offsetRef.current;
    const ratio = Math.abs(completedOffset) / active.width;
    const direction = Math.sign(completedOffset);
    offsetRef.current = 0;
    setOffset(0);
    if (suppressTitleClickRef.current) {
      window.setTimeout(() => {
        suppressTitleClickRef.current = false;
      }, 0);
    }
    const action = direction < 0
      ? (ratio >= SWIPE_LONG_ACTION_THRESHOLD ? leftSecondaryAction.action : primaryAction.action)
      : (ratio >= SWIPE_LONG_ACTION_THRESHOLD ? "forward" : "edit");
    const activated = ratio >= SWIPE_ACTION_THRESHOLD && direction !== 0;
    console.info("[todo-gesture] mobile task swipe finished", {
      todoId: todo.id,
      rail: active.rail,
      direction: direction < 0 ? "left" : direction > 0 ? "right" : "none",
      distance: Math.round(Math.abs(completedOffset)),
      ratio: Number(ratio.toFixed(3)),
      activated,
      action: activated ? action : null,
    });
    if (!activated) return;
    if (direction < 0) onAction(todo, action as TodoAction, "swipe");
    else if (action === "forward") onQueue(todo);
    else onEdit(todo, "swipe");
  }

  function cancelSwipe() {
    const active = gesture.current;
    if (active) {
      console.info("[todo-gesture] mobile task swipe cancelled by pointer", {
        todoId: todo.id,
        rail: active.rail,
        distance: Math.round(Math.abs(offsetRef.current)),
      });
    }
    gesture.current = null;
    offsetRef.current = 0;
    setDragging(false);
    setOffset(0);
  }

  const hoverActions: Array<{ action: TodoAction | "edit" | "pin"; label: string; icon: ActionIconName }> = [
    ...(showPin ? [{ action: "pin" as const, label: todo.pinned ? "Unpin" : "Pin", icon: todo.pinned ? "unpin" as const : "pin" as const }] : []),
    primaryAction,
    ...(todo.status === "open" && leftSecondaryAction.action !== primaryAction.action ? [leftSecondaryAction] : []),
    { action: "edit", label: "Edit", icon: "edit" },
    { action: "delete", label: "Delete", icon: "delete" },
  ];

  function resizeTitle() {
    scheduleTitleSize(titleRef.current);
  }

  useLayoutEffect(() => {
    resizeTitle();
  }, [editingTitle, titleDraft, todo.title]);
  useLayoutEffect(() => observeTitleSize(titleRef.current), []);

  return (
    <li
      data-task-row-id={todo.id}
      className={classNames(
        "group relative scroll-m-24 overflow-hidden",
        selected && !editingTitle && "ring-1 ring-inset ring-primary/30",
        reordering && "z-20 opacity-70 shadow-lg",
        reorderTarget && "ring-2 ring-inset ring-primary/45",
      )}
    >
      <div className={classNames("absolute inset-0 flex items-center justify-between px-5 text-sm font-semibold md:hidden", revealClass)} aria-hidden="true">
        <span className={classNames("inline-flex items-center gap-2 transition-opacity", offset > 0 ? "opacity-100" : "opacity-0")}><ActionIcon name={revealIcon} />{revealAction}</span>
        <span className={classNames("inline-flex items-center gap-2 transition-opacity", offset < 0 ? "opacity-100" : "opacity-0")}><ActionIcon name={revealIcon} />{revealAction}</span>
      </div>
      <div
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={finishSwipe}
        onPointerCancel={cancelSwipe}
        style={{ transform: `translateX(${offset}px)` }}
        className={classNames(
          "relative flex min-h-[72px] items-start gap-0 bg-card px-4 py-4 hover:bg-muted/50 sm:px-5",
          !dragging && "transition-transform duration-200 ease-out",
          selected && !editingTitle && "bg-accent hover:bg-accent",
        )}
      >
        <div className="flex w-5 shrink-0 flex-col items-center gap-1 md:mr-3">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onSelect(todo)}
            aria-label={`Select: ${todo.title}`}
            className={classNames("mt-0.5 h-5 w-5 shrink-0 cursor-pointer rounded border-input accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring", pending && "animate-pulse")}
          />
          <Button variant="ghost" size="icon"
            type="button"
            data-row-action
            aria-label={`Drag to reorder: ${todo.title}`}
            title="Drag to reorder"
            disabled={pending || todo.offline || editingTitle}
            onPointerDown={(event) => onReorderStart(todo, event)}
            onPointerMove={onReorderMove}
            onPointerUp={(event) => onReorderEnd(event, false)}
            onPointerCancel={(event) => onReorderEnd(event, true)}
            className="h-6 w-6 sm:h-6 sm:w-6 touch-none select-none place-items-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground active:scale-95 active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-25 md:cursor-grab"
          >
            <ActionIcon name="reorder" className="h-4 w-4" />
          </Button>
        </div>
        <div aria-hidden="true" className="relative w-6 shrink-0 self-stretch md:hidden">
          <div
            data-swipe-rail="left"
            className="absolute inset-x-0 -bottom-4 -top-4 touch-pan-y"
          />
        </div>
        <div
          onClick={(event) => {
            if (suppressTitleClickRef.current) {
              suppressTitleClickRef.current = false;
              event.preventDefault();
              titleRef.current?.blur();
              return;
            }
            if (event.target !== titleRef.current) {
              titleRef.current?.focus();
              titleRef.current?.setSelectionRange(todo.title.length, todo.title.length);
            }
          }}
          className="min-w-0 flex-1 rounded-lg text-left transition-colors"
        >
          <div className="flex min-w-0 items-start gap-2">
            <textarea
              ref={titleRef}
              data-inline-title
              value={editingTitle ? titleDraft : todo.title}
              onChange={(event) => {
                setTitleDraft(event.target.value);
                onTitleChange(todo, event.target.value);
                resizeTitle();
              }}
              onFocus={() => {
                setTitleDraft(todo.title);
                setEditingTitle(true);
                onTitleFocus(todo);
              }}
              onBlur={(event) => {
                setEditingTitle(false);
                onTitleBlur(todo, event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.currentTarget.blur();
                } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  event.currentTarget.blur();
                } else if (
                  !event.shiftKey
                  && !event.metaKey
                  && !event.ctrlKey
                  && !event.altKey
                  && event.currentTarget.selectionStart === event.currentTarget.selectionEnd
                  && (
                    (event.key === "ArrowDown" && event.currentTarget.selectionEnd === event.currentTarget.value.length)
                    || (event.key === "ArrowUp" && event.currentTarget.selectionStart === 0)
                  )
                ) {
                  const direction = event.key === "ArrowDown" ? "next" : "previous";
                  if (onTitleArrowNavigate(todo, direction)) event.preventDefault();
                }
              }}
              rows={1}
              maxLength={2000}
              aria-label={`Edit title: ${todo.title}`}
              className={classNames(
                "block min-h-5 min-w-0 flex-1 resize-none overflow-hidden border-0 bg-transparent p-0 text-[16px] leading-5 text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 sm:text-[15px]",
                todo.status === "completed" && "text-muted-foreground line-through",
              )}
            />
            
          </div>
          {todo.notes && <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm leading-5 text-muted-foreground">{todo.notes}</p>}
          {(todo.attachmentCount > 0 || todo.project || todo.context || todo.dueDate || todo.priority <= 2 || snoozed || recurring || todo.offline || todo.queueLastTransfer) && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[13px] font-medium leading-4 [&>span]:max-w-full [&>span]:break-words [&_svg]:shrink-0">
              {todo.attachmentCount > 0 && <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[13px] font-medium text-muted-foreground"><ActionIcon name="attachment" className="h-3 w-3" />{todo.attachmentCount}</span>}
              {todo.priority <= 2 && <span className={classNames("inline-flex min-h-[22px] items-center rounded-full px-2 py-0.5", todo.priority === 1 ? "bg-destructive/10 text-destructive ring-1 ring-inset ring-destructive/20" : "bg-warning text-warning-foreground ring-1 ring-inset ring-warning-foreground/20")}>{priorityLabels[todo.priority]}</span>}
              {todo.project && <span className="inline-flex min-h-[22px] items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-muted-foreground ring-1 ring-inset ring-border"><ActionIcon name="folder" className="h-3 w-3" />{todo.project}</span>}
              {todo.context && <span className="inline-flex min-h-[22px] items-center rounded-full bg-secondary px-2 py-0.5 text-secondary-foreground ring-1 ring-inset ring-border">{todo.context}</span>}
              {todo.dueDate && <span className={classNames("inline-flex min-h-[22px] items-center gap-1 rounded-full px-2 py-0.5 ring-1 ring-inset", isDueTodayOrOverdue(todo.dueDate) && todo.status === "open" && !snoozed ? "bg-destructive/10 text-destructive ring-destructive/20" : "bg-muted text-muted-foreground ring-border")}><ActionIcon name="calendar" className="h-3 w-3" />{formatDueDate(todo.dueDate)}</span>}
              {snoozed && todo.snoozedUntil && <SnoozeStatusBadge value={todo.snoozedUntil} now={now} timeZone={timeZone} />}
              {todo.recurrenceCron && <span className="inline-flex min-h-[22px] items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-secondary-foreground ring-1 ring-inset ring-border"><ActionIcon name="repeat" className="h-3 w-3" />{recurrenceLabel(todo.recurrenceCron, todo.status, now, timeZone)}</span>}
              {todo.queueLastTransfer && <span className="inline-flex min-h-[22px] items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-accent-foreground">Queued</span>}
              {todo.offline && <span className="inline-flex min-h-[22px] items-center gap-1 rounded-full bg-warning px-2 py-0.5 text-warning-foreground ring-1 ring-inset ring-warning-foreground/20"><ActionIcon name="retry" className="h-3 w-3" />Saved on device</span>}
            </div>
          )}
        </div>
        <div
          data-swipe-rail="right"
          className="-mr-4 flex shrink-0 self-stretch touch-pan-y pr-4 sm:-mr-5 sm:pr-5 md:hidden"
        >
          <div aria-hidden="true" className="relative w-6 shrink-0 self-stretch">
            <div className="absolute inset-x-0 -bottom-4 -top-4" />
          </div>
          {showPin && !pending && !todo.offline && (
            <Button variant="ghost" size="icon"
              type="button"
              data-row-action
              onClick={(event) => {
                if (suppressTitleClickRef.current) {
                  event.preventDefault();
                  event.stopPropagation();
                  return;
                }
                onPin(todo);
              }}
              aria-label={`${todo.pinned ? "Unpin" : "Pin"}: ${todo.title}`}
              title={todo.pinned ? "Unpin" : "Pin"}
              className={classNames("shrink-0 transition focus-visible:outline-2 focus-visible:outline-ring", todo.pinned ? "bg-accent text-primary" : "text-muted-foreground hover:bg-muted")}
            >
              <ActionIcon name={todo.pinned ? "unpin" : "pin"} className="h-[18px] w-[18px]" />
            </Button>
          )}
          {agentUrgent && !pending && !todo.offline && (
            <Button variant="ghost" size="icon"
              type="button"
              data-row-action
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onAcknowledgeUrgent(todo)}
              aria-label={`Acknowledge urgent alert: ${todo.title}`}
              title="Acknowledge urgent alert"
              className="shrink-0 text-destructive transition hover:bg-destructive/10 focus-visible:outline-2 focus-visible:outline-ring"
            >
              <ActionIcon name="phone" className="h-[18px] w-[18px]" />
            </Button>
          )}
        </div>
        {!pending && !todo.offline && (
          <div className="hidden shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 md:ml-3 md:flex">
            {agentUrgent && (
              <Button variant="ghost" size="icon"
                type="button"
                data-row-action
                onClick={() => onAcknowledgeUrgent(todo)}
                aria-label={`Acknowledge urgent alert: ${todo.title}`}
                title="Acknowledge urgent alert"
                className="grid h-9 w-9 place-items-center rounded-lg text-destructive transition hover:bg-destructive/10 focus-visible:outline-2 focus-visible:outline-ring"
              >
                <ActionIcon name="phone" className="h-[18px] w-[18px]" />
                <span className="sr-only">Acknowledge urgent alert</span>
              </Button>
            )}
            <Button variant="ghost" size="icon" type="button" data-row-action onClick={() => onQueue(todo)} aria-label={`Queue to bot: ${todo.title}`} title="Queue to bot" className="grid h-9 w-9 place-items-center rounded-lg text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"><ActionIcon name="forward" className="h-[18px] w-[18px]" /><span className="sr-only">Queue to bot</span></Button>
            {hoverActions.map(({ action, label, icon }) => (
              <Button variant="ghost" size="icon"
                key={action}
                type="button"
                data-row-action
                onClick={() => action === "edit" ? onEdit(todo, "hover") : action === "pin" ? onPin(todo) : onAction(todo, action, "hover")}
                aria-label={`${label}: ${todo.title}`}
                title={label}
                className={classNames(
                  "text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
                  (action === "complete" || action === "unsnooze") && "hover:bg-accent hover:text-accent-foreground",
                  action === "snooze" && "hover:bg-warning hover:text-warning-foreground",
                  action === "pin" && "hover:bg-accent hover:text-primary",
                  action === "delete" && "hover:bg-destructive/10 hover:text-destructive",
                )}
              >
                <ActionIcon name={icon} className="h-[18px] w-[18px]" />
                <span className="sr-only">{label}</span>
              </Button>
            ))}
          </div>
        )}
      </div>
    </li>
  );
});

