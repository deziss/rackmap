import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { authClient } from "@/lib/auth-client";
import { ServerCreateInput, type ServerDto } from "@inv/shared";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Plus, Pencil } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

interface ServerFormDialogProps {
  server?: ServerDto;
  onSaved?: () => void;
}

interface LookupEntry { id: number; name: string }

function LookupSelect({ label, type, value, onChange, filterPredicate }: { label: string; type: string; value: number | null | undefined; onChange: (v: number | null) => void, filterPredicate?: (d: LookupEntry) => boolean }) {
  const { data = [], refetch } = useQuery<LookupEntry[]>({
    queryKey: ["lookups", type],
    queryFn: () => apiFetch(`/api/v1/lookups/${type}`),
  });

  const filteredData = filterPredicate ? data.filter(filterPredicate) : data;

  const [isAdding, setIsAdding] = useState(false);
  const [newValue, setNewValue] = useState("");
  const { data: session } = authClient.useSession();
  const role = (session?.user as { role?: string })?.role ?? "viewer";
  const canAdd = role === "admin" || role === "editor";

  const handleAdd = async () => {
    if (!newValue.trim()) { setIsAdding(false); return; }
    try {
      const res = await apiFetch<{ id: number }>(`/api/v1/lookups/${type}`, {
        method: "POST",
        body: JSON.stringify({ name: newValue.trim() }),
      });
      await refetch();
      onChange(res.id);
      setIsAdding(false);
      setNewValue("");
      toast.success(`Added new ${label}`);
    } catch (e: any) {
      toast.error(e.message || "Failed to add");
    }
  };

  if (isAdding) {
    return (
      <div className="space-y-1">
        <Label>{label}</Label>
        <div className="flex gap-2">
          <Input
            autoFocus
            value={newValue}
            onChange={e => setNewValue(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAdd(); } if (e.key === 'Escape') setIsAdding(false); }}
            className="h-9"
          />
          <Button type="button" size="sm" onClick={handleAdd}>Add</Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setIsAdding(false)}>Cancel</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <Label>{label}</Label>
      <select
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        value={value ?? ""}
        onChange={(e) => {
          if (e.target.value === "ADD_NEW") {
            setIsAdding(true);
          } else {
            onChange(e.target.value ? Number(e.target.value) : null);
          }
        }}
      >
        <option value="">— None —</option>
        {filteredData.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        {canAdd && <option value="ADD_NEW" className="text-primary font-medium">+ Add new...</option>}
      </select>
    </div>
  );
}

export function ServerFormDialog({ server, onSaved }: ServerFormDialogProps) {
  const [open, setOpen] = useState(false);
  const isEdit = !!server;

  const { register, handleSubmit, setValue, watch, formState: { errors, isSubmitting } } = useForm({
    resolver: zodResolver(ServerCreateInput),
    defaultValues: {
      hostname: server?.hostname ?? "",
      ip: server?.ip ?? "",
      username: server?.username ?? "",
      password: undefined,
      sshPort: server?.sshPort ?? 22,
      cpu: server?.cpu ?? "",
      ram: server?.ram ?? "",
      gpuCount: server?.gpuCount ?? undefined,
      remark: server?.remark ?? "",
      domain: server?.domain ?? "",
      environment: (server?.environment as "on-premise" | "cloud" | undefined) ?? "on-premise",
      cloudProviderId: server?.cloudProvider?.id ?? undefined,
      gpuTypeId: server?.gpuType?.id ?? undefined,
      allocatedToId: server?.allocatedTo?.id ?? undefined,
      locationId: server?.location?.id ?? undefined,
      serverTypeId: server?.serverType?.id ?? undefined,
      networkTypeId: server?.networkType?.id ?? undefined,
      osType: server?.osType ?? "",
      isPrivateIp: server?.isPrivateIp ?? false,
      purpose: server?.purpose ?? "",
      createdBy: server?.createdBy ?? "",
    },
  });

  const cloudProviderId = watch("cloudProviderId");
  const gpuTypeId = watch("gpuTypeId");
  const allocatedToId = watch("allocatedToId");
  const locationId = watch("locationId");
  const networkTypeId = watch("networkTypeId");
  const environment = watch("environment");

  async function onSubmit(data: Record<string, unknown>) {
    try {
      const url = isEdit ? `/api/v1/servers/${server.id}` : "/api/v1/servers";
      const method = isEdit ? "PATCH" : "POST";
      const cleaned = Object.fromEntries(
        Object.entries(data)
          .map(([k, v]) => [k, v === "" ? null : v]) // Convert empty strings to null for clearing
          .filter(([k, v]) => v !== undefined) // Drop undefined to avoid overwriting unchanged fields like password
      );

      // Auto-assign Server Type
      try {
        const serverTypes = await apiFetch<LookupEntry[]>('/api/v1/lookups/server-types');
        const hasGpu = Number(data.gpuCount) > 0 || data.gpuTypeId != null;
        const typeStr = hasGpu ? "gpu" : "cpu";
        const matchedType = serverTypes.find(t => t.name.toLowerCase().includes(typeStr));
        if (matchedType) {
          cleaned.serverTypeId = matchedType.id;
        }
      } catch (e) {
        console.error("Failed to auto-assign server type", e);
      }

      await apiFetch(url, { method, body: JSON.stringify(cleaned) });
      toast.success(isEdit ? "Server updated" : "Server created");
      setOpen(false);
      onSaved?.();
    } catch (e: unknown) {
      toast.error((e as Error).message);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {isEdit ? (
          <Button size="icon" variant="ghost" className="h-6 w-6" title="Edit server">
            <Pencil className="h-3 w-3" />
          </Button>
        ) : (
          <Button size="sm">
            <Plus className="h-4 w-4 mr-1" /> Add Server
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Server" : "Add Server"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 mt-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Hostname *</Label>
              <Input {...register("hostname")} />
              {errors.hostname && <p className="text-xs text-destructive">{errors.hostname.message}</p>}
            </div>
            <div className="space-y-1">
              <Label>IP Address *</Label>
              <Input {...register("ip")} />
            </div>
            <div className="space-y-1">
              <Label>Username *</Label>
              <Input {...register("username")} />
            </div>
            <div className="space-y-1">
              <Label>SSH Port</Label>
              <Input type="number" {...register("sshPort", { valueAsNumber: true })} />
            </div>
            <div className="space-y-1 col-span-2">
              <Label>Password {isEdit ? "(leave blank to keep existing)" : ""}</Label>
              <Input type="password" autoComplete="new-password" {...register("password", { setValueAs: (v) => v === "" ? undefined : v })} placeholder={isEdit ? "Unchanged" : ""} />
            </div>
            <div className="space-y-1">
              <Label>CPU</Label>
              <Input {...register("cpu")} />
            </div>
            <div className="space-y-1">
              <Label>RAM</Label>
              <Input {...register("ram")} placeholder="512GB" />
            </div>
            <div className="space-y-1">
              <Label>GPU Count</Label>
              <Input type="number" {...register("gpuCount", { setValueAs: (v) => v === "" ? undefined : Number(v) })} />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 mt-4">
            <div className="space-y-1">
              <Label>Domain</Label>
              <Input {...register("domain")} placeholder="e.g. example.com" />
            </div>
            <div className="space-y-1">
              <Label>Environment</Label>
              <select className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" {...register("environment")}>
                <option value="on-premise">On Premise</option>
                <option value="cloud">Cloud</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label>OS Type</Label>
              <Input {...register("osType")} placeholder="e.g. Ubuntu 22.04" />
            </div>
            <div className="space-y-1">
              <Label>Purpose</Label>
              <Input {...register("purpose")} placeholder="e.g. Database Server" />
            </div>
            <div className="space-y-1">
              <Label>Created By</Label>
              <Input {...register("createdBy")} placeholder="e.g. Alice" />
            </div>
            <div className="space-y-1 flex flex-row items-center gap-2 mt-6">
              <input type="checkbox" id="isPrivateIp" {...register("isPrivateIp")} className="h-4 w-4 rounded border-gray-300" />
              <Label htmlFor="isPrivateIp" className="m-0">Is Private IP?</Label>
            </div>
          </div>

          {environment === "cloud" && (
            <LookupSelect
              label="Cloud Provider"
              type="cloud-providers"
              value={cloudProviderId ?? undefined}
              onChange={(v) => setValue("cloudProviderId", v)}
              filterPredicate={(d) => !d.name.toLowerCase().includes("premise")}
            />
          )}
          <LookupSelect label="GPU Type" type="gpu-types" value={gpuTypeId ?? undefined} onChange={(v) => setValue("gpuTypeId", v)} />
          <LookupSelect label="Allocated To" type="allocated-to" value={allocatedToId ?? undefined} onChange={(v) => setValue("allocatedToId", v)} />
          <LookupSelect label="Location" type="locations" value={locationId ?? undefined} onChange={(v) => setValue("locationId", v)} />
          <LookupSelect label="Network Type" type="network-types" value={networkTypeId ?? undefined} onChange={(v) => setValue("networkTypeId", v)} />

          <div className="space-y-1">
            <Label>Remark</Label>
            <Input {...register("remark")} />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Saving…" : isEdit ? "Update" : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
