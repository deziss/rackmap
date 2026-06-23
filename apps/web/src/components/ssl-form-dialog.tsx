import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { SslStatusCreateInput, type SslStatusDto } from "@inv/shared";
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

interface SslFormDialogProps {
  ssl?: SslStatusDto;
  onSaved?: () => void;
}

export function SslFormDialog({ ssl, onSaved }: SslFormDialogProps) {
  const [open, setOpen] = useState(false);
  const isEdit = !!ssl;

  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm({
    resolver: zodResolver(SslStatusCreateInput),
    defaultValues: {
      domain: ssl?.domain ?? "",
      team: ssl?.team ?? "",
      project: ssl?.project ?? "",
      serverId: ssl?.server?.id ?? undefined,
      serviceId: ssl?.service?.id ?? undefined,
    },
  });

  async function onSubmit(data: Record<string, unknown>) {
    try {
      const url = isEdit ? `/api/v1/ssl/${ssl.id}` : "/api/v1/ssl";
      const method = isEdit ? "PATCH" : "POST";
      const cleaned = Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, v === "" ? undefined : v])
      );
      await apiFetch(url, { method, body: JSON.stringify(cleaned) });
      toast.success(isEdit ? "SSL entry updated" : "SSL entry created");
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
          <Button size="icon" variant="ghost" className="h-6 w-6" title="Edit SSL info">
            <Pencil className="h-3 w-3" />
          </Button>
        ) : (
          <Button size="sm">
            <Plus className="h-4 w-4 mr-1" /> Add Domain
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit SSL Info" : "Track SSL Domain"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4 mt-2">
          <div className="space-y-1">
            <Label>Domain *</Label>
            <Input {...register("domain")} placeholder="e.g. example.com" />
            {errors.domain && <p className="text-xs text-destructive">{errors.domain?.message?.toString()}</p>}
          </div>
          <div className="space-y-1">
            <Label>Team</Label>
            <Input {...register("team")} placeholder="e.g. Infrastructure" />
          </div>
          <div className="space-y-1">
            <Label>Project</Label>
            <Input {...register("project")} placeholder="e.g. Main API" />
          </div>
          <div className="space-y-1">
            <Label>Server ID (Optional)</Label>
            <Input type="number" {...register("serverId", { setValueAs: (v) => v === "" ? undefined : Number(v) })} placeholder="e.g. 1" />
          </div>
          <div className="space-y-1">
            <Label>Service ID (Optional)</Label>
            <Input type="number" {...register("serviceId", { setValueAs: (v) => v === "" ? undefined : Number(v) })} placeholder="e.g. 10" />
          </div>

          <div className="flex justify-end gap-2 pt-4">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Saving…" : isEdit ? "Update" : "Add"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
