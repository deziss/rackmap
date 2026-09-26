import { PaginationBar } from "@/components/pagination-bar";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { FileText, Download, Printer, Filter, Copy } from "lucide-react";
import { useDebounce } from "@/hooks/use-debounce";
import { Input } from "@/components/ui/input";
import { format } from "date-fns";
import jsPDF from "jspdf";
import { autoTable } from "jspdf-autotable";
import { toast } from "sonner";

export const Route = createFileRoute("/_auth/reports")({
  component: ReportsPage,
});

function getHumanReadableEntity(log: any): string {
  if (log.entityName) {
    return `${log.entity}: ${log.entityName}`;
  }
  return `${log.entity} #${log.entityId}`;
}

function getLogDetailsText(log: any, networks?: any[], projects?: any[]): string {
  try {
    const parseData = (jsonStr: string) => {
      const data = JSON.parse(jsonStr);
      if (data.old !== undefined && data.new !== undefined) {
        return `Changed from ${data.old} to ${data.new}`;
      }
      
      const parts = [];
      if (data.hostname) parts.push(`Hostname: ${data.hostname}`);
      if (data.domain) parts.push(`Domain: ${data.domain}`);
      if (data.ip) parts.push(`IP: ${data.ip}`);
      if (data.port) parts.push(`Port: ${data.port}`);
      if (data.sshPort) parts.push(`SSH Port: ${data.sshPort}`);
      if (data.email) parts.push(`Email: ${data.email}`);
      if (data.name) parts.push(`Name: ${data.name}`);
      if (data.role) parts.push(`Role: ${data.role}`);
      
      if (data.networkTypeId !== undefined) {
        const networkLookup = networks?.find(l => l.id === data.networkTypeId);
        parts.push(`Network: ${networkLookup ? networkLookup.name : data.networkTypeId}`);
      }
      if (data.allocatedToId !== undefined) {
        const projectLookup = projects?.find(l => l.id === data.allocatedToId);
        parts.push(`Project: ${projectLookup ? projectLookup.name : data.allocatedToId}`);
      }
      
      if (data.hasPassword !== undefined) parts.push(`Password Updated: ${data.hasPassword}`);
      
      if (parts.length > 0) {
        return parts.join(" | ");
      }
      
      return null;
    };

    if (log.afterJson) {
      const parsed = parseData(log.afterJson);
      if (parsed) return parsed;
      return log.afterJson;
    }
    
    if (log.diffJson) {
      const parsed = parseData(log.diffJson);
      if (parsed) return `Updates: ${parsed}`;
      return `Updates: ${log.diffJson}`;
    }
  } catch (e) {
    // If not JSON, fallthrough
  }
  
  return log.afterJson || log.diffJson || log.beforeJson || "—";
}

function formatLogDetails(log: any, networks?: any[], projects?: any[]) {
  const text = getLogDetailsText(log, networks, projects);
  return <span className="text-muted-foreground print:text-gray-800">{text}</span>;
}

function ReportsPage() {
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [dateRange, setDateRange] = useState<string>("30d");
  const [auditSearch, setAuditSearch] = useState("");
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(25);
  const [selectedLog, setSelectedLog] = useState<any | null>(null);
  const debouncedAuditSearch = useDebounce(auditSearch, 300);

  const { data: networksData } = useQuery({
    queryKey: ["lookups", "network-types"],
    queryFn: () => apiFetch<any[]>("/api/v1/lookups/network-types"),
  });
  
  const { data: projectsData } = useQuery({
    queryKey: ["lookups", "allocated-to"],
    queryFn: () => apiFetch<any[]>("/api/v1/lookups/allocated-to"),
  });

  const networks = networksData || [];
  const projects = projectsData || [];

  const { data, isLoading } = useQuery({
    queryKey: ["reports", actionFilter, dateRange, debouncedAuditSearch, page, pageSize],
    queryFn: () => {
      const to = new Date();
      const from = new Date();
      if (dateRange === "7d") from.setDate(from.getDate() - 7);
      else if (dateRange === "30d") from.setDate(from.getDate() - 30);
      else if (dateRange === "90d") from.setDate(from.getDate() - 90);

      const queryParams = new URLSearchParams({
        page: String(page),
        limit: String(pageSize),
        ...(actionFilter !== "all" ? { action: actionFilter } : {}),
        ...(dateRange !== "all" ? { from: from.toISOString(), to: to.toISOString() } : {}),
        ...(debouncedAuditSearch ? { search: debouncedAuditSearch } : {}),
      });

      return apiFetch<{ items: any[]; total: number; totalPages: number; page: number }>(`/api/v1/audit?${queryParams.toString()}`);
    },
  });

  const printReport = () => {
    if (!data?.items) return;

    const doc = new jsPDF({ orientation: "landscape" });
    
    doc.setFontSize(16);
    doc.text("Audit History Report", 14, 20);
    
    doc.setFontSize(10);
    doc.text(`Generated on: ${format(new Date(), "PPpp")}`, 14, 28);
    doc.text(`Filters: ${actionFilter === "all" ? "All Actions" : actionFilter} | ${dateRange === "all" ? "All Time" : `Last ${dateRange}`}`, 14, 34);

    const tableColumn = ["Date", "Actor", "Entity", "Action", "Details"];
    const tableRows = (data?.items || []).map((log) => [
      format(new Date(log.createdAt), "PP p"),
      `${log.actorEmail || "System"}${log.ip ? ` (${log.ip})` : ''}`,
      getHumanReadableEntity(log),
      log.action,
      getLogDetailsText(log, networks, projects),
    ]);

    autoTable(doc, {
      head: [tableColumn],
      body: tableRows,
      startY: 40,
      styles: { fontSize: 8, cellPadding: 3 },
      headStyles: { fillColor: [41, 128, 185], textColor: 255 },
      alternateRowStyles: { fillColor: [245, 245, 245] },
      columnStyles: {
        0: { cellWidth: 35 },
        1: { cellWidth: 40 },
        2: { cellWidth: 35 },
        3: { cellWidth: 35 },
        4: { cellWidth: 'auto' },
      },
      margin: { top: 40 },
    });

    doc.save(`audit-report-${format(new Date(), "yyyy-MM-dd")}.pdf`);
  };

  const downloadJson = () => {
    if (!data?.items) return;
    const blob = new Blob([JSON.stringify(data.items, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-report-${Date.now()}.json`;
    a.click();
  };

  return (
    <div className="flex h-full flex-col print:h-auto print:block">
      {/* Sticky Header & Filters Container */}
      <div className="sticky top-[-24px] z-30 print:hidden -mx-6 px-6 pt-[24px] pb-4 bg-background/95 backdrop-blur-md border-b border-white/10 mb-6 flex flex-col gap-4">
        
        {/* Top Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-foreground flex items-center gap-2">
              <FileText className="h-5 w-5 text-primary" /> Reports & Audit
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Generate history logs for network shifts, assignments, and infrastructure changes.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button size="sm" variant="outline" className="gap-2" onClick={downloadJson}>
              <Download className="h-4 w-4" /> Export JSON
            </Button>
            <Button size="sm" variant="default" className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90" onClick={printReport}>
              <Printer className="h-4 w-4" /> Save as PDF
            </Button>
          </div>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-4 flex-wrap mt-2">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Filter className="h-4 w-4" /> Filters:
          </div>

          <Input
            placeholder="Search IP, Hostname, Domain, Project..."
            className="w-75 h-9 bg-card border-white/10"
            value={auditSearch}
            onChange={(e) => { setAuditSearch(e.target.value); setPage(1); }}
          />

          <Select value={actionFilter} onValueChange={(val) => { setActionFilter(val); setPage(1); }}>
            <SelectTrigger className="w-[220px] h-9 bg-card border-white/10">
              <SelectValue placeholder="Action Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Actions</SelectItem>
              <SelectItem value="server.update_network">Network Shifts (DMZ/Local)</SelectItem>
              <SelectItem value="server.reassign">Project Reassignments</SelectItem>
              <SelectItem value="server.create">Server Creations</SelectItem>
              <SelectItem value="server.update">Server Updates</SelectItem>
              <SelectItem value="auth.sign_in">Logins</SelectItem>
            </SelectContent>
          </Select>

          <Select value={dateRange} onValueChange={(val) => { setDateRange(val); setPage(1); }}>
            <SelectTrigger className="w-[180px] h-9 bg-card border-white/10">
              <SelectValue placeholder="Date Range" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7d">Last 7 Days</SelectItem>
              <SelectItem value="30d">Last 30 Days</SelectItem>
              <SelectItem value="90d">Last 90 Days</SelectItem>
              <SelectItem value="all">All Time</SelectItem>
            </SelectContent>
          </Select>
          
          <div className="ml-auto flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => { setActionFilter("server.update_network"); setDateRange("30d"); }}>
              Recent Network Shifts
            </Button>
            <Button size="sm" variant="secondary" onClick={() => { setActionFilter("server.reassign"); setDateRange("30d"); }}>
              Project Reassignments
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto space-y-6 print:overflow-visible print:p-0">

        {/* Print Header - Only visible when printing */}
        <div className="hidden print:block mb-6">
          <h1 className="text-2xl font-bold text-black mb-2">Audit History Report</h1>
          <p className="text-sm text-gray-600">
            Generated on: {format(new Date(), "PPpp")}
            <br />
            Filters: {actionFilter === "all" ? "All Actions" : actionFilter} | {dateRange === "all" ? "All Time" : `Last ${dateRange}`}
          </p>
        </div>

        {/* Table */}
        <div className="rounded-xl border border-white/10 print:border-gray-300 bg-card/60 backdrop-blur-md shadow-xl overflow-hidden print:overflow-visible print:shadow-none print:bg-white print:text-black">
          <table className="w-full text-sm print:break-inside-auto">
            <thead className="print:table-header-group">
              <tr className="border-b border-white/8 print:border-gray-300 bg-white/3 print:bg-gray-100">
                <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground print:text-gray-700 uppercase tracking-wider">Date</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground print:text-gray-700 uppercase tracking-wider">Actor</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground print:text-gray-700 uppercase tracking-wider">Entity</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground print:text-gray-700 uppercase tracking-wider">Action</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-muted-foreground print:text-gray-700 uppercase tracking-wider">Details</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} className="border-b border-white/5 print:hidden">
                    {Array.from({ length: 5 }).map((__, j) => (
                      <td key={j} className="px-4 py-4"><Skeleton className="h-4 w-full" /></td>
                    ))}
                  </tr>
                ))
              )}
              {!isLoading && data?.items?.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-muted-foreground print:text-gray-500 text-sm">
                    No logs found for the selected criteria.
                  </td>
                </tr>
              )}
              {data?.items?.map((log) => (
                <tr key={log.id} className="border-b border-white/5 print:border-gray-200 last:border-0 hover:bg-white/4 print:hover:bg-transparent print:break-inside-avoid cursor-pointer" onClick={() => setSelectedLog(log)}>
                  <td className="px-4 py-3 whitespace-nowrap text-xs text-muted-foreground print:text-gray-600">
                    {format(new Date(log.createdAt), "PP p")}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <span className="font-medium text-foreground print:text-black">{log.actorEmail || "System"}</span>
                    {log.ip && <span className="block text-[10px] text-muted-foreground print:text-gray-500">{log.ip}</span>}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="outline" className="print:border-gray-300 print:text-gray-800">
                      {getHumanReadableEntity(log)}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-xs font-mono text-primary print:text-blue-600">
                    {log.action}
                  </td>
                  <td className="px-4 py-3 text-xs max-w-xs print:max-w-none print:whitespace-normal print:overflow-visible print:break-words">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate">{formatLogDetails(log, networks, projects)}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-1.5 text-[10px] text-muted-foreground hover:text-foreground shrink-0 print:hidden"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedLog(log);
                        }}
                      >
                        View
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <PaginationBar
        page={data?.page ?? page}
        totalPages={data?.totalPages ?? 1}
        totalItems={data?.total ?? (data?.items?.length || 0)}
        pageSize={pageSize}
        onPageChange={(p) => setPage(p)}
        onPageSizeChange={(s) => {
          setPageSize(s);
          setPage(1);
        }}
        disabled={isLoading}
      />

      {/* Audit Log Details Dialog Popup */}
      <Dialog open={!!selectedLog} onOpenChange={(open) => !open && setSelectedLog(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="text-base flex items-center gap-2">
              <FileText className="h-4 w-4 text-primary" />
              Audit Log Details
              {selectedLog?.action && (
                <Badge variant="outline" className="text-[11px] font-mono">
                  {selectedLog.action}
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription className="text-xs">
              Complete audit event record, applied changes, and entity attribution.
            </DialogDescription>
          </DialogHeader>

          {selectedLog && (
            <div className="space-y-3 overflow-y-auto flex-1 pr-1 text-xs">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 p-3 rounded-lg bg-muted/40 border">
                <div>
                  <span className="text-[10px] text-muted-foreground uppercase">Timestamp</span>
                  <div className="font-mono text-foreground font-semibold mt-0.5">
                    {format(new Date(selectedLog.createdAt), "PPpp")}
                  </div>
                </div>
                <div>
                  <span className="text-[10px] text-muted-foreground uppercase">Actor</span>
                  <div className="font-mono text-foreground font-semibold mt-0.5 truncate" title={selectedLog.actorEmail}>
                    {selectedLog.actorEmail || "System"}
                  </div>
                  {selectedLog.ip && (
                    <div className="text-[10px] text-muted-foreground">IP: {selectedLog.ip}</div>
                  )}
                </div>
                <div>
                  <span className="text-[10px] text-muted-foreground uppercase">Entity</span>
                  <div className="font-semibold text-foreground mt-0.5 truncate">
                    {getHumanReadableEntity(selectedLog)}
                  </div>
                  <div className="text-[10px] text-muted-foreground font-mono">
                    ID: {selectedLog.entityId}
                  </div>
                </div>
              </div>

              {(selectedLog.afterJson || selectedLog.after) && (
                <div className="space-y-1">
                  <div className="text-[11px] font-semibold text-foreground">
                    Applied Changes / State (After):
                  </div>
                  <pre className="p-3 rounded-lg bg-black/60 border font-mono text-[11px] text-emerald-400 overflow-x-auto whitespace-pre-wrap max-h-56">
                    {(() => {
                      try {
                        const val = selectedLog.afterJson ? JSON.parse(selectedLog.afterJson) : selectedLog.after;
                        return JSON.stringify(val, null, 2);
                      } catch {
                        return selectedLog.afterJson || String(selectedLog.after);
                      }
                    })()}
                  </pre>
                </div>
              )}

              {(selectedLog.beforeJson || selectedLog.before) && (
                <div className="space-y-1">
                  <div className="text-[11px] font-semibold text-foreground">
                    Previous State (Before):
                  </div>
                  <pre className="p-3 rounded-lg bg-black/60 border font-mono text-[11px] text-zinc-400 overflow-x-auto whitespace-pre-wrap max-h-44">
                    {(() => {
                      try {
                        const val = selectedLog.beforeJson ? JSON.parse(selectedLog.beforeJson) : selectedLog.before;
                        return JSON.stringify(val, null, 2);
                      } catch {
                        return selectedLog.beforeJson || String(selectedLog.before);
                      }
                    })()}
                  </pre>
                </div>
              )}

              {(selectedLog.diffJson || selectedLog.diff) && (
                <div className="space-y-1">
                  <div className="text-[11px] font-semibold text-foreground">
                    Modifications / Diff:
                  </div>
                  <pre className="p-3 rounded-lg bg-black/60 border font-mono text-[11px] text-amber-400 overflow-x-auto whitespace-pre-wrap max-h-44">
                    {(() => {
                      try {
                        const val = selectedLog.diffJson ? JSON.parse(selectedLog.diffJson) : selectedLog.diff;
                        return JSON.stringify(val, null, 2);
                      } catch {
                        return selectedLog.diffJson || String(selectedLog.diff);
                      }
                    })()}
                  </pre>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2 border-t">
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1 text-xs"
                  onClick={() => {
                    navigator.clipboard.writeText(JSON.stringify(selectedLog, null, 2));
                    toast.success("Full audit record JSON copied to clipboard");
                  }}
                >
                  <Copy className="h-3.5 w-3.5" /> Copy JSON
                </Button>
                <Button size="sm" onClick={() => setSelectedLog(null)}>
                  Close
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
