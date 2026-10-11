"use client";

import { useState, type ComponentProps, type ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./dialog";

/** For dialogs opened by application state rather than a Radix trigger. */
export function ControlledDialog({ title, description, onClose, returnFocus, children, ...props }: Omit<ComponentProps<typeof DialogContent>, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  returnFocus?: HTMLElement | null;
}) {
  const [opener] = useState(() => typeof document === "undefined" ? null : document.activeElement);
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent {...props} {...(!description ? { "aria-describedby": undefined } : {})} onCloseAutoFocus={(event) => {
      props.onCloseAutoFocus?.(event);
      if (event.defaultPrevented) return;
      event.preventDefault();
      const target = returnFocus ?? opener;
      if (target instanceof HTMLElement && target.isConnected) target.focus({ preventScroll: true });
    }}>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description && <DialogDescription>{description}</DialogDescription>}
      </DialogHeader>
      {children}
    </DialogContent>
  </Dialog>;
}
