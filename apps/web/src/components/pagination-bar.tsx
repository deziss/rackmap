import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface PaginationBarProps {
  page: number;
  totalPages: number;
  totalItems: number;
  pageSize: number;
  onPageChange: (newPage: number) => void;
  onPageSizeChange?: (newPageSize: number) => void;
  pageSizeOptions?: number[];
  className?: string;
  disabled?: boolean;
}

export function PaginationBar({
  page,
  totalPages,
  totalItems,
  pageSize,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 25, 50, 100],
  className,
  disabled = false,
}: PaginationBarProps) {
  const safeTotalPages = Math.max(1, totalPages);
  const currentPage = Math.min(Math.max(1, page), safeTotalPages);

  const startItem = totalItems === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const endItem = Math.min(totalItems, currentPage * pageSize);

  // Generate numbered pages with smart ellipses
  const getPageNumbers = () => {
    const pages: (number | "ellipsis-start" | "ellipsis-end")[] = [];

    if (safeTotalPages <= 7) {
      for (let i = 1; i <= safeTotalPages; i++) {
        pages.push(i);
      }
    } else {
      pages.push(1);

      if (currentPage > 4) {
        pages.push("ellipsis-start");
      }

      const start = Math.max(2, currentPage - 1);
      const end = Math.min(safeTotalPages - 1, currentPage + 1);

      for (let i = start; i <= end; i++) {
        pages.push(i);
      }

      if (currentPage < safeTotalPages - 3) {
        pages.push("ellipsis-end");
      }

      pages.push(safeTotalPages);
    }

    return pages;
  };

  const pageNumbers = getPageNumbers();

  return (
    <div
      className={cn(
        "flex flex-col sm:flex-row items-center justify-between gap-3 py-3 text-xs text-muted-foreground",
        className
      )}
    >
      {/* Left: Summary & Rows per page */}
      <div className="flex items-center gap-4 flex-wrap">
        <span>
          Showing <strong className="text-foreground font-mono">{startItem}</strong>–
          <strong className="text-foreground font-mono">{endItem}</strong> of{" "}
          <strong className="text-foreground font-mono">{totalItems}</strong> items
        </span>

        {onPageSizeChange && (
          <div className="flex items-center gap-1.5">
            <span>Rows:</span>
            <Select
              value={String(pageSize)}
              onValueChange={(val) => onPageSizeChange(Number(val))}
              disabled={disabled}
            >
              <SelectTrigger className="h-7 w-[68px] text-xs font-mono">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pageSizeOptions.map((opt) => (
                  <SelectItem key={opt} value={String(opt)} className="text-xs font-mono">
                    {opt}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {/* Right: Page Navigation */}
      <div className="flex items-center gap-1">
        {/* First Page button (only if > 7 pages) */}
        {safeTotalPages > 7 && (
          <Button
            size="icon"
            variant="outline"
            className="h-7 w-7 p-0"
            onClick={() => onPageChange(1)}
            disabled={currentPage <= 1 || disabled}
            title="First Page"
          >
            <ChevronsLeft className="h-3.5 w-3.5" />
          </Button>
        )}

        {/* Previous */}
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 gap-1 text-xs"
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage <= 1 || disabled}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Previous</span>
        </Button>

        {/* Numbered Page Buttons */}
        <div className="flex items-center gap-1 mx-0.5">
          {pageNumbers.map((p, idx) => {
            if (p === "ellipsis-start" || p === "ellipsis-end") {
              return (
                <span
                  key={`${p}-${idx}`}
                  className="px-1.5 py-0.5 text-xs text-muted-foreground select-none"
                >
                  …
                </span>
              );
            }

            const isCurrent = p === currentPage;
            return (
              <Button
                key={p}
                size="icon"
                variant={isCurrent ? "default" : "outline"}
                className={cn(
                  "h-7 w-7 text-xs font-mono",
                  isCurrent && "font-bold shadow-sm"
                )}
                onClick={() => onPageChange(p)}
                disabled={disabled}
              >
                {p}
              </Button>
            );
          })}
        </div>

        {/* Next */}
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 gap-1 text-xs"
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage >= safeTotalPages || disabled}
        >
          <span className="hidden sm:inline">Next</span>
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>

        {/* Last Page button (only if > 7 pages) */}
        {safeTotalPages > 7 && (
          <Button
            size="icon"
            variant="outline"
            className="h-7 w-7 p-0"
            onClick={() => onPageChange(safeTotalPages)}
            disabled={currentPage >= safeTotalPages || disabled}
            title="Last Page"
          >
            <ChevronsRight className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}
