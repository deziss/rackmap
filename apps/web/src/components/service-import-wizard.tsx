import { useState, useRef } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Upload, CheckCircle, XCircle, AlertCircle } from "lucide-react";
import { toast } from "sonner";

const KNOWN_COLUMNS = [
  { key: "serviceName", label: "Service Name", required: true },
  { key: "serviceType", label: "Service Type", required: false },
  { key: "serverIp", label: "Server IP", required: false },
  { key: "port", label: "Port", required: false },
  { key: "domain", label: "Domain", required: false },
  { key: "username", label: "Username", required: false },
  { key: "password", label: "Password", required: false },
  { key: "documentLink", label: "Document Link", required: false },
  { key: "project", label: "Project", required: false },
  { key: "version", label: "Version", required: false },
  { key: "environment", label: "Environment", required: false },
  { key: "dbName", label: "DB Name", required: false },
  { key: "managedBy", label: "Managed By", required: false },
  { key: "healthUrl", label: "Health URL", required: false },
  { key: "remark", label: "Remark", required: false },
] as const;

type MappingKey = (typeof KNOWN_COLUMNS)[number]["key"];

interface RowResult {
  row: number;
  serviceName: string;
  status: "ok" | "error" | "skip";
  message?: string;
}

interface ImportResult {
  total: number;
  created: number;
  skipped: number;
  errors: RowResult[];
}

interface ServiceImportWizardProps {
  onImported: () => void;
}

type Step = "upload" | "map" | "preview" | "done";

export function ServiceImportWizard({ onImported }: ServiceImportWizardProps) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Partial<Record<MappingKey, string>>>({});
  const [dryResult, setDryResult] = useState<ImportResult | null>(null);
  const [loading, setLoading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function reset() {
    setStep("upload"); setFile(null); setHeaders([]); setMapping({}); setDryResult(null);
  }

  async function parseHeaders(f: File) {
    const { read, utils } = await import("xlsx");
    const buf = await f.arrayBuffer();
    const wb = read(buf, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0] ?? ""];
    if (!ws) { toast.error("No worksheet found"); return; }
    const rows = utils.sheet_to_json(ws, { header: 1 }) as string[][];
    const h = (rows[0] as string[]) ?? [];
    setHeaders(h);
    // Auto-map obvious matches
    const auto: Partial<Record<MappingKey, string>> = {};
    for (const col of KNOWN_COLUMNS) {
      const match = h.find((hdr) => hdr.toLowerCase().replace(/[^a-z0-9]/g, "") === col.key.toLowerCase().replace(/[^a-z0-9]/g, "") || hdr.toUpperCase() === col.label.toUpperCase().replace(/ /g, "_"));
      if (match) auto[col.key] = match;
    }
    setMapping(auto);
    setStep("map");
  }

  async function runDry() {
    if (!file) return;
    setLoading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("mapping", JSON.stringify(mapping));
      fd.append("dryRun", "true");
      const res = await fetch("/api/v1/services/import", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "Failed to parse import preview");
      setDryResult(data as ImportResult);
      setStep("preview");
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function commit() {
    if (!file) return;
    setLoading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("mapping", JSON.stringify(mapping));
      fd.append("dryRun", "false");
      const res = await fetch("/api/v1/services/import", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "Failed to run import");
      
      const result = data as ImportResult;
      toast.success(`Imported ${result.created} services`);
      setStep("done");
      onImported();
    } catch (e: unknown) {
      toast.error((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1.5">
          <Upload className="h-3.5 w-3.5" /> Import
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import Services</DialogTitle>
        </DialogHeader>

        {/* Step: Upload */}
        {step === "upload" && (
          <div className="space-y-4 py-2">
            <div
              className="border-2 border-dashed border-border rounded-lg p-10 text-center cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) { setFile(f); parseHeaders(f); } }}
            >
              <Upload className="h-8 w-8 mx-auto mb-2 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">Drop .xlsx or .csv file here, or click to browse</p>
              <input ref={fileRef} type="file" accept=".xlsx,.csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) { setFile(f); parseHeaders(f); } }} />
            </div>
            {file && <p className="text-sm text-muted-foreground text-center">Selected: {file.name}</p>}
          </div>
        )}

        {/* Step: Map columns */}
        {step === "map" && (
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">Map your file columns to service fields. Required: Service Name.</p>
            <div className="grid grid-cols-2 gap-2 max-h-72 overflow-y-auto pr-1">
              {KNOWN_COLUMNS.map((col) => (
                <div key={col.key} className="flex items-center gap-2">
                  <Label className="w-28 shrink-0 text-xs">
                    {col.label}
                    {col.required && <span className="text-destructive ml-0.5">*</span>}
                  </Label>
                  <select
                    className="flex-1 rounded border border-input bg-background px-2 py-1 text-xs"
                    value={mapping[col.key] ?? ""}
                    onChange={(e) => setMapping((m) => ({ ...m, [col.key]: e.target.value || undefined }))}
                  >
                    <option value="">(skip)</option>
                    {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>
              ))}
            </div>
            <div className="flex justify-between">
              <Button variant="outline" size="sm" onClick={() => setStep("upload")}>Back</Button>
              <Button size="sm" onClick={runDry} disabled={loading || !mapping.serviceName}>
                {loading ? "Validating…" : "Preview"}
              </Button>
            </div>
          </div>
        )}

        {/* Step: Preview dry-run results */}
        {step === "preview" && dryResult && (
          <div className="space-y-3 py-2">
            <div className="flex gap-4 text-sm">
              <span className="flex items-center gap-1 text-green-600"><CheckCircle className="h-4 w-4" />{dryResult.created} to create</span>
              <span className="flex items-center gap-1 text-yellow-600"><AlertCircle className="h-4 w-4" />{dryResult.skipped} skipped</span>
              <span className="flex items-center gap-1 text-red-600"><XCircle className="h-4 w-4" />{dryResult.errors.filter((e) => e.status === "error").length} errors</span>
            </div>
            <div className="max-h-52 overflow-y-auto rounded border divide-y divide-border text-xs font-mono">
              {dryResult.errors.map((r) => (
                <div key={r.row} className={`px-3 py-1.5 flex items-center gap-2 ${r.status === "error" ? "bg-red-50 dark:bg-red-950/20" : r.status === "skip" ? "bg-yellow-50 dark:bg-yellow-950/20" : ""}`}>
                  <span className="text-muted-foreground w-8">#{r.row}</span>
                  <span className="flex-1 truncate">{r.serviceName}</span>
                  {r.status === "ok" && <Badge variant="secondary" className="text-xs">OK</Badge>}
                  {r.status === "skip" && <Badge variant="outline" className="text-xs text-yellow-700">skip</Badge>}
                  {r.status === "error" && <Badge variant="destructive" className="text-xs">{r.message}</Badge>}
                </div>
              ))}
            </div>
            <div className="flex justify-between">
              <Button variant="outline" size="sm" onClick={() => setStep("map")}>Back</Button>
              <Button size="sm" onClick={commit} disabled={loading || dryResult.created === 0}>
                {loading ? "Importing…" : `Import ${dryResult.created} services`}
              </Button>
            </div>
          </div>
        )}

        {/* Step: Done */}
        {step === "done" && (
          <div className="py-8 text-center space-y-3">
            <CheckCircle className="h-10 w-10 mx-auto text-green-600" />
            <p className="text-sm">Import complete.</p>
            <Button size="sm" onClick={() => { setOpen(false); reset(); }}>Close</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
