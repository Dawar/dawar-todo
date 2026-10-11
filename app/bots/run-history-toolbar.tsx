"use client";
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function RunHistoryToolbar({ filter, onFilter, busy, online, onRefresh }: {
  filter: string; onFilter: (filter: string) => void; busy: boolean; online: boolean; onRefresh: () => void;
}) {
  return <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
    <div role="group" aria-label="Filter history" className="inline-flex flex-wrap gap-1 rounded-lg border border-border bg-muted p-1">
      <Button variant={filter === 'all' ? 'secondary' : 'ghost'} size="sm" type="button" aria-pressed={filter === 'all'} onClick={() => onFilter('all')}>All runs</Button>
      <Button variant={filter === 'attention' ? 'secondary' : 'ghost'} size="sm" type="button" aria-pressed={filter === 'attention'} onClick={() => onFilter('attention')}>Needs attention</Button>
    </div>
    <Button variant="ghost" size="icon" type="button" aria-label="Refresh history" title="Refresh history" disabled={busy || !online} onClick={onRefresh}><RefreshCw size={16} aria-hidden="true"/></Button>
  </div>;
}
