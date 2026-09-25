import { Hash, Mail, MessageSquare, Send, Siren, Users, Webhook } from "lucide-react";
import type { AlertChannelType, AlertChannelHealth, AlertDeliveryStatus } from "@inv/shared";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Generic (non-brand) glyph per channel type. */
export function ChannelTypeIcon({ type, className }: { type: AlertChannelType; className?: string }) {
  const Icon = { slack: Hash, teams: Users, discord: MessageSquare, pagerduty: Siren, telegram: Send, webhook: Webhook, email: Mail }[type] ?? Webhook;
  return <Icon className={cn("text-muted-foreground", className)} />;
}

export function HealthBadge({ status, title }: { status: AlertChannelHealth["status"]; title?: string }) {
  if (status === "failing") {
    return (
      <Badge variant="destructive" className="text-[10px]" title={title}>
        Failing
      </Badge>
    );
  }
  if (status === "ok") {
    return (
      <Badge variant="success" className="text-[10px]" title={title}>
        Healthy
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[10px] text-muted-foreground" title={title}>
      No sends yet
    </Badge>
  );
}

const STATUS_VARIANT: Record<AlertDeliveryStatus, "success" | "destructive" | "warning" | "outline" | "secondary"> = {
  succeeded: "success",
  failed: "destructive",
  expired: "destructive",
  retrying: "warning",
  sending: "warning",
  pending: "secondary",
  suppressed: "outline",
};

export function DeliveryStatusBadge({ status }: { status: AlertDeliveryStatus }) {
  return (
    <Badge variant={STATUS_VARIANT[status] ?? "outline"} className="text-[10px] capitalize">
      {status}
    </Badge>
  );
}
