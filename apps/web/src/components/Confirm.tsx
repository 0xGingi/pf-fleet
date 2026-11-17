import { useState, type ReactNode } from "react";
import { Button } from "./ui/button";
import { Dialog } from "./ui/dialog";

/** A button that asks first. */
export function ConfirmButton({
  title,
  description,
  confirmLabel,
  onConfirm,
  children,
  variant = "danger",
  size = "sm",
}: {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<unknown> | unknown;
  children: ReactNode;
  variant?: "danger" | "secondary" | "ghost";
  size?: "sm" | "md" | "icon";
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button variant={variant} size={size} onClick={() => setOpen(true)}>
        {children}
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        description={description}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant={variant === "danger" ? "danger" : "primary"}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await onConfirm();
                  setOpen(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {confirmLabel}
            </Button>
          </>
        }
      />
    </>
  );
}
