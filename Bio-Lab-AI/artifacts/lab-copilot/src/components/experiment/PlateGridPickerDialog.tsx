import { useEffect, useMemo, useState } from "react";
import { Check, MousePointer2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

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
  onConfirm: (selection: ManualPlateSelection) => void;
  busy: boolean;
};

export function PlateGridPickerDialog({ open, filename, preview, onCancel, onConfirm, busy }: Props) {
  const [anchor, setAnchor] = useState<Cell | null>(null);
  const [focus, setFocus] = useState<Cell | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAnchor(null);
    setFocus(null);
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


        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
          <Button
            type="button"
            disabled={busy || !validSelection || !bounds}
            className="gap-2"
            onClick={() => bounds && onConfirm({
              start_row: bounds.top,
              start_column: bounds.left,
              transpose: selectedRows === 12,
            })}
          >
            <Check className="h-4 w-4" /> {busy ? "Importing…" : "Import selected plate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
