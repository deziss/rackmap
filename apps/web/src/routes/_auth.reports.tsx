import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FileText, Download, Printer, Filter } from "lucide-react";
import { format } from "date-fns";

export const Route = createFileRoute("/_auth/reports")({
  component: ReportsPage,
});

function ReportsPage() {
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [dateRange, setDateRange] = useState<string>("30d");

  // Calculate dates
  const to = new Date();
  const from = new Date();
  if (dateRange === "7d") from.setDate(from.getDate() - 7);
  else if (dateRange === "30d") from.setDate(from.getDate() - 30);
  else if (dateRange === "90d") from.setDate(from.getDate() - 90);

  const queryParams = new URLSearchParams({
    limit: "100",
    ...(actionFilter !== "all" ? { action: actionFilter } : {}),
    ...(dateRange !== "all" ? { from: from.toISOString(), to: to.toISOString() } : {}),
  });

  const { data, isLoading } = useQuery({
    queryKey: ["reports", queryParams.toString()],
    queryFn: () => apiFetch<{ items: any[] }>(`/api/v1/audit?${queryParams.toString()}`),
  });

  const printReport = () => {
    window.print();
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
    <div className="flex h-full flex-col">
      {/* Header - Hidden when printing */}
      <div className="print:hidden flex items-center justify-between border-b border-white/10 px-6 py-4 bg-card/40 backdrop-blur-sm">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
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

      <div className="flex-1 overflow-auto p-6 space-y-6">
        {/* Filters - Hidden when printing */}
        <div className="print:hidden flex items-center gap-4 p-4 rounded-lg bg-card border border-white/10 shadow-sm flex-wrap">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Filter className="h-4 w-4" /> Filters:
          </div>
          
          <Select value={actionFilter} onValueChange={setActionFilter}>
            <SelectTrigger className="w-[220px] h-9">
              <SelectValue placeholder="Action Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Actions</SelectItem>
              <SelectItem value="server.update_network">Network Shifts (DMZ/Local)</SelectItem>
              <SelectItem value="server.reassign">Project Reassignments</SelectItem>
              <SelectItem value="server.create">Server Creations</SelectItem>
              <SelectItem value="auth.sign_in">Logins</SelectItem>
            </SelectContent>
          </Select>

          <Select value={dateRange} onValueChange={setDateRange}>
            <SelectTrigger className="w-[180px] h-9">
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
        <div className="rounded-xl border border-white/10 print:border-gray-300 bg-card/60 backdrop-blur-md shadow-xl overflow-hidden print:shadow-none print:bg-white print:text-black">
          <table className="w-full text-sm">
            <thead>
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
                <tr key={log.id} className="border-b border-white/5 print:border-gray-200 last:border-0 hover:bg-white/4 print:hover:bg-transparent">
                  <td className="px-4 py-3 whitespace-nowrap text-xs text-muted-foreground print:text-gray-600">
                    {format(new Date(log.createdAt), "PP p")}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    <span className="font-medium text-foreground print:text-black">{log.actorEmail || "System"}</span>
                    {log.ip && <span className="block text-[10px] text-muted-foreground print:text-gray-500">{log.ip}</span>}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="outline" className="print:border-gray-300 print:text-gray-800">
                      {log.entity} #{log.entityId}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-xs font-mono text-primary print:text-blue-600">
                    {log.action}
                  </td>
                  <td className="px-4 py-3 text-xs max-w-xs truncate" title={log.afterJson || log.diffJson || log.beforeJson}>
                    {log.afterJson ? (
                      <span className="text-muted-foreground print:text-gray-600">{log.afterJson}</span>
                    ) : log.diffJson ? (
                      <span className="text-muted-foreground print:text-gray-600">Diff: {log.diffJson}</span>
                    ) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
