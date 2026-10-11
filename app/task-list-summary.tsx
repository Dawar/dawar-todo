import { Button } from '@/components/ui/button';
import { ActionIcon } from './action-icon';

export function TaskListSummary({ label, count, syncing, allSelected, filtersActive, onSelection, onClearFilters }: {
  label: string; count: number; syncing: boolean; allSelected: boolean; filtersActive: boolean;
  onSelection: () => void; onClearFilters: () => void;
}) {
  return <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1">
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
      <h2 id="tasks-heading" className="text-sm font-semibold text-foreground">{label} tasks</h2>
      {count > 0 && <Button type="button" variant="ghost" onClick={onSelection} className="text-primary">
        <ActionIcon name={allSelected ? 'cancel' : 'select'} />{allSelected ? 'Clear selection' : 'Select visible'}
      </Button>}
    </div>
    <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
      <span role={syncing ? 'status' : undefined}>{syncing ? 'Saving…' : `${count} ${count === 1 ? 'item' : 'items'}`}</span>
      {filtersActive && <Button type="button" variant="ghost" onClick={onClearFilters} className="text-primary"><ActionIcon name="cancel" />Clear filters</Button>}
    </div>
  </div>;
}
