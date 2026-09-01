import { useEffect, useMemo, useState } from "react";
import { Check, MousePointer2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { ROLE_COLOR, ROLE_LABEL, type WellRole } from "@/lib/plateMetrics";

type Cell = { row: number; column: number };

export type ManualPlateSelection = {
  start_row: number;
  start_column: number;
  transpose: boolean;
};

type Props = {
  open: boolean;
  filename: string;
  preview: string[][];
  onCancel: () => void;
  onConfirm: (selection: ManualPlateSelection, roles: Record<string, WellRole>) => void;
};

const ROLE_ORDER: WellRole[] = ["pos", "neg", "blank", "sample"];
const ROWS = ["A", "B", "C", "D", "E", "F", "G", "H"];

export function PlateGridPickerDialog({ open, filename, preview, onCancel, onConfirm }: Props) {
  const [anchor, setAnchor] = useState<Cell | null>(null);
  const [focus, setFocus] = useState<Cell | null>(null);
  const [dragging, setDragging] = useState(false);
  const [activeRole, setActiveRole] = useState<WellRole>("pos");
  const [roles, setRoles] = useState<Record<string, WellRole>>({});

  useEffect(() => {
    if (!open) return;
    setAnchor(null);
    setFocus(null);
    setRoles({});
    setActiveRole("pos");
  }, [open, filename]);

  useEffect(() => {
    if (!dragging) return;
    const stop = () => setDragging(false);
    window.addEventListener("mouseup", stop);
    return () => window.removeEventListener("mouseup", stop);
  }, [dragging]);

  const bounds = useMemo(() => {
    if (!anchor || !focus) return null;
    return {
      top: Math.min(anchor.row, focus.row),
      bottom: Math.max(anchor.row, focus.row),
      left: Math.min(anchor.column, focus.column),
      right: Math.max(anchor.column, focus.column),
    };
  }, [anchor, focus]);
  const selectedRows = bounds ? bounds.bottom - bounds.top + 1 : 0;
  const selectedColumns = bounds ? bounds.right - bounds.left + 1 : 0;
  const validSelection = (selectedRows === 8 && selectedColumns === 12) || (selectedRows === 12 && selectedColumns === 8);
  const maxColumns = Math.max(1, ...preview.map((row) => row.length));

  const isSelected = (row: number, column: number) => Boolean(bounds
    && row >= bounds.top && row <= bounds.bottom
    && column >= bounds.left && column <= bounds.right);

  const assignRole = (well: string) => setRoles((current) => {
    const next = { ...current };
    if (next[well] === activeRole) delete next[well];
    else next[well] = activeRole;
    return next;
  });

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="flex max-h-[92vh] max-w-[min(96vw,1100px)] flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><MousePointer2 className="h-5 w-5 text-primary" /> Select the 96-well plate</DialogTitle>
          <DialogDescription>
            We could read {filename}, but could not identify its plate automatically. Drag across exactly 8 rows × 12 columns. A transposed 12 × 8 block also works.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-auto pr-1">
          <div className="rounded-xl border bg-muted/20 p-2">
            <div className="mb-2 flex items-center justify-between gap-3 px-1 text-xs text-muted-foreground">
              <span>File preview</span>
              <span className={cn("font-mono", validSelection ? "text-emerald-500" : "text-amber-500")}>
                {selectedRows || 0} × {selectedColumns || 0} selected
              </span>
            </div>
            <div className="max-h-[310px] overflow-auto rounded-lg border bg-background select-none">
              <table className="border-separate border-spacing-0 text-[10px]">
                <thead className="sticky top-0 z-10 bg-muted">
                  <tr>
                    <th className="sticky left-0 z-20 min-w-10 border-b border-r px-2 py-1 text-muted-foreground">#</th>
                    {Array.from({ length: maxColumns }, (_, column) => (
                      <th key={column} className="min-w-16 border-b border-r px-2 py-1 font-mono text-muted-foreground">{column + 1}</th>
                    ))}
                  </tr>
                </thead>
                <tbody onMouseLeave={() => dragging && setDragging(false)}>
                  {preview.map((row, rowIndex) => (
                    <tr key={rowIndex}>
                      <th className="sticky left-0 z-[5] border-b border-r bg-muted px-2 py-1 font-mono text-muted-foreground">{rowIndex + 1}</th>
                      {Array.from({ length: maxColumns }, (_, columnIndex) => (
                        <td
                          key={columnIndex}
                          className={cn(
                            "h-7 max-w-32 cursor-crosshair truncate border-b border-r px-2 py-1 font-mono",
                            isSelected(rowIndex, columnIndex) && "bg-primary/25 text-primary ring-1 ring-inset ring-primary/30",
                          )}
                          title={row[columnIndex] ?? ""}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            const point = { row: rowIndex, column: columnIndex };
                            setAnchor(point);
                            setFocus(point);
                            setDragging(true);
                          }}
                          onMouseEnter={() => dragging && setFocus({ row: rowIndex, column: columnIndex })}
                        >
                          {row[columnIndex] ?? ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {validSelection && (
            <div className="rounded-xl border bg-muted/20 p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Tag controls (optional)</p>
                  <p className="text-xs text-muted-foreground">Choose a role, then click wells. This lets Z′ and control-normalized metrics work immediately.</p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {ROLE_ORDER.map((role) => (
                    <Button
                      key={role}
                      type="button"
                      size="sm"
                      variant={activeRole === role ? "default" : "outline"}
                      className="h-8 gap-1.5 text-xs"
                      onClick={() => setActiveRole(role)}
                    >
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: ROLE_COLOR[role] }} />
                      {ROLE_LABEL[role]}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="mt-3 overflow-auto">
                <div className="grid min-w-[610px] grid-cols-[28px_repeat(12,minmax(42px,1fr))] gap-1">
                  <span />
                  {Array.from({ length: 12 }, (_, column) => <span key={column} className="text-center font-mono text-[10px] text-muted-foreground">{column + 1}</span>)}
                  {ROWS.flatMap((row) => [
                    <span key={`${row}-label`} className="flex items-center justify-center font-mono text-[10px] text-muted-foreground">{row}</span>,
                    ...Array.from({ length: 12 }, (_, column) => {
                      const well = `${row}${column + 1}`;
                      const role = roles[well];
                      return (
                        <button
                          key={well}
                          type="button"
                          className="h-8 rounded border bg-background text-[10px] transition hover:border-primary"
                          style={role ? { borderColor: ROLE_COLOR[role], boxShadow: `inset 0 0 0 1px ${ROLE_COLOR[role]}` } : undefined}
                          title={role ? `${well}: ${ROLE_LABEL[role]}` : well}
                          onClick={() => assignRole(well)}
                        >
                          {well}{role && <span className="ml-1" style={{ color: ROLE_COLOR[role] }}>●</span>}
                        </button>
                      );
                    }),
                  ])}
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
          <Button
            type="button"
            disabled={!validSelection || !bounds}
            className="gap-2"
            onClick={() => bounds && onConfirm({
              start_row: bounds.top,
              start_column: bounds.left,
              transpose: selectedRows === 12,
            }, roles)}
          >
            <Check className="h-4 w-4" /> Import selected plate
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
