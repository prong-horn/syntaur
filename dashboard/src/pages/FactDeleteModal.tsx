import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';

interface FactReference {
  factName: string;
  location: string;
  when: string;
}

interface FactDeleteModalProps {
  open: boolean;
  references: FactReference[];
  onConfirm: () => void;
  onCancel: () => void;
}

export function FactDeleteModal({
  open,
  references,
  onConfirm,
  onCancel,
}: FactDeleteModalProps) {
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => (!nextOpen ? onCancel() : undefined)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Delete fact — referenced by derive rules</DialogTitle>
          <DialogDescription>
            Removing this fact will break the following derive conditions. The
            doctor check will flag them as invalid until they are fixed.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border border-border/60 bg-background/80 p-3">
          <ul className="space-y-2 text-sm">
            {references.map((ref, i) => (
              <li key={i} className="font-mono text-xs text-muted-foreground">
                <span className="text-foreground">{ref.location}</span>
                <span className="mx-1">·</span>
                <span>{ref.when}</span>
              </li>
            ))}
          </ul>
        </div>

        <DialogFooter>
          <button type="button" onClick={onCancel} className="shell-action">
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="shell-action bg-error text-error-foreground hover:opacity-90"
          >
            Confirm delete — rules will become invalid
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
