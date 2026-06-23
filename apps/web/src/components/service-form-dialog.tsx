import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ServiceCreateInput, type ServiceDto } from "@inv/shared";
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

interface ServiceFormDialogProps {
  service?: ServiceDto;
  onSaved?: () => void;
}

export function ServiceFormDialog({ service, onSaved }: ServiceFormDialogProps) {
  const [open, setOpen] = useState(false);
  const isEdit = !!service;

  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm({
    resolver: zodResolver(ServiceCreateInput),
    defaultValues: {
      serviceName: service?.serviceName ?? "",
      serviceType: service?.serviceType ?? "",
      serverIp: service?.serverIp ?? "",
      port: service?.port ?? "",
      domain: service?.domain ?? "",
      username: service?.username ?? "",
      password: undefined,
      documentLink: service?.documentLink ?? "",
      project: service?.project ?? "",
      version: service?.version ?? "",
      environment: service?.environment ?? "",
      dbName: service?.dbName ?? "",
      managedBy: service?.managedBy ?? "",
      remark: service?.remark ?? "",
      healthUrl: service?.healthUrl ?? "",
      status: (service?.status as "working" | "not_working" | undefined) ?? "working",
    },
  });

  async function onSubmit(data: Record<string, unknown>) {
    try {
      const url = isEdit ? `/api/v1/services/${service.id}` : "/api/v1/services";
      const method = isEdit ? "PATCH" : "POST";
      const cleaned = Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, v === "" ? undefined : v])
      );
      await apiFetch(url, { method, body: JSON.stringify(cleaned) });
      toast.success(isEdit ? "Service updated" : "Service created");
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
          <Button size="icon" variant="ghost" className="h-6 w-6" title="Edit service">
            <Pencil className="h-3 w-3" />
          </Button>
        ) : (
          <Button size="sm">
            <Plus className="h-4 w-4 mr-1" /> Add Service
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Service" : "Add Service"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 mt-2">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Service Name *</Label>
              <Input {...register("serviceName")} />
              {errors.serviceName && <p className="text-xs text-destructive">{errors.serviceName?.message?.toString()}</p>}
            </div>
            <div className="space-y-1">
              <Label>Service Type</Label>
              <Input {...register("serviceType")} placeholder="e.g. Database, API, Cache" />
            </div>
            
            <div className="space-y-1">
              <Label>Server IP</Label>
              <Input {...register("serverIp")} />
            </div>
            <div className="space-y-1">
              <Label>Port</Label>
              <Input {...register("port")} />
            </div>

            <div className="space-y-1">
              <Label>Domain / URL</Label>
              <Input {...register("domain")} />
            </div>
            <div className="space-y-1">
              <Label>Health Check URL</Label>
              <Input {...register("healthUrl")} placeholder="https://api.example.com/health" />
            </div>

            <div className="space-y-1">
              <Label>Username</Label>
              <Input {...register("username")} />
            </div>
            <div className="space-y-1">
              <Label>Password {isEdit ? "(leave blank to keep existing)" : ""}</Label>
              <Input type="password" autoComplete="new-password" {...register("password", { setValueAs: (v) => v === "" ? undefined : v })} placeholder={isEdit ? "Unchanged" : ""} />
            </div>

            <div className="space-y-1">
              <Label>Environment</Label>
              <Input {...register("environment")} placeholder="e.g. Production, Staging" />
            </div>
            <div className="space-y-1">
              <Label>Version</Label>
              <Input {...register("version")} placeholder="e.g. v1.2.0" />
            </div>

            <div className="space-y-1">
              <Label>Project</Label>
              <Input {...register("project")} />
            </div>
            <div className="space-y-1">
              <Label>Database Name</Label>
              <Input {...register("dbName")} />
            </div>

            <div className="space-y-1">
              <Label>Managed By</Label>
              <Input {...register("managedBy")} placeholder="Team or Email" />
            </div>
            <div className="space-y-1">
              <Label>Status</Label>
              <select className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" {...register("status")}>
                <option value="working">Working</option>
                <option value="not_working">Not Working</option>
              </select>
            </div>
            
            <div className="space-y-1 col-span-2">
              <Label>Documentation Link</Label>
              <Input {...register("documentLink")} />
            </div>
            <div className="space-y-1 col-span-2">
              <Label>Remark</Label>
              <Input {...register("remark")} />
            </div>
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
