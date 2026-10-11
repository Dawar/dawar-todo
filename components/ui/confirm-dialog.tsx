"use client";

import { Button } from "./button";
import { ControlledDialog } from "./controlled-dialog";
import { DialogFooter } from "./dialog";

export function ConfirmDialog({ title, description, confirmLabel, onConfirm, onCancel, destructive = false }: {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  destructive?: boolean;
}) {
  return <ControlledDialog title={title} description={description} onClose={onCancel}>
    <DialogFooter>
      <Button variant="outline" autoFocus onClick={onCancel}>Cancel</Button>
      <Button variant={destructive ? "destructive" : "default"} onClick={onConfirm}>{confirmLabel}</Button>
    </DialogFooter>
  </ControlledDialog>;
}
