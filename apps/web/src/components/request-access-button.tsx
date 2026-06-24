import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { KeyRound } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { toast } from "sonner";

export function RequestAccessButton({ 
  entityId, 
  entityType, 
  type, 
  label 
}: { 
  entityId: number; 
  entityType: "server" | "service";
  type: "ssh" | "password_reveal" | "service_password_reveal"; 
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await apiFetch("/api/v1/access-requests", {
        method: "POST",
        body: JSON.stringify({ 
          [entityType === "server" ? "serverId" : "serviceId"]: entityId, 
          type, 
          note: note || undefined 
        }),
      });
      toast.success("Access request submitted — await admin approval");
      setOpen(false);
      setNote("");
    } catch (err: unknown) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7 text-amber-500 hover:text-amber-400"
            onClick={() => setOpen(true)}
          >
            <KeyRound className="h-3.5 w-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Request {label} access</TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Request {label} Access</DialogTitle></DialogHeader>
          <form onSubmit={submit} className="space-y-4 mt-2">
            <p className="text-sm text-muted-foreground">Your request will be reviewed by an admin. You'll be notified when approved.</p>
            <div className="space-y-1">
              <Label>Reason (optional)</Label>
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Briefly describe why you need access…" className="h-8 text-sm" />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={loading}>{loading ? "Sending…" : "Submit Request"}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
