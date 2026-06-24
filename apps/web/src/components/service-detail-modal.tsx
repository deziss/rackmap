import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useQuery } from "@tanstack/react-query";
import { fetchService, serviceKeys } from "@/lib/queries";
import { StatusDot } from "@/components/status-dot";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Server, Activity, Lock, Database, Globe, Tag, ExternalLink } from "lucide-react";

function InfoRow({ label, value, icon: Icon }: { label: string; value: React.ReactNode; icon?: React.ElementType }) {
  return (
    <div className="flex py-3 border-b border-border/50 last:border-0 items-start">
      <div className="w-1/3 text-muted-foreground text-sm flex items-center gap-2">
        {Icon && <Icon className="h-4 w-4" />}
        {label}
      </div>
      <div className="w-2/3 text-sm font-medium break-all">
        {value || <span className="text-muted-foreground/50 italic">—</span>}
      </div>
    </div>
  );
}

interface ServiceDetailModalProps {
  serviceId: number | null;
  onClose: () => void;
}

export function ServiceDetailModal({ serviceId, onClose }: ServiceDetailModalProps) {
  const id = Number(serviceId);

  const { data: service, isLoading, isError, error } = useQuery({
    queryKey: serviceKeys.detail(id),
    queryFn: () => fetchService(id),
    enabled: serviceId != null,
  });

  return (
    <Dialog open={serviceId != null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-[96vw] md:max-w-4xl w-full h-[94vh] md:h-auto md:max-h-[85vh] flex flex-col p-0 gap-0 overflow-hidden [&>button:last-child]:top-3 [&>button:last-child]:right-3">
        {/* Header */}
        <DialogHeader className="shrink-0 px-5 py-4 border-b border-border bg-card/80 backdrop-blur-sm">
          <div className="flex items-center gap-3 flex-wrap pr-8">
            <Globe className="h-4 w-4 text-muted-foreground shrink-0" />
            <DialogTitle className="font-mono text-base flex items-center gap-2">
              {service && (
                <StatusDot
                  status={service.lastStatus as "up" | "down" | "unknown"}
                  latencyMs={service.lastLatencyMs}
                  ip={service.serverIp || ""}
                  port={Number(service.port)}
                />
              )}
              {service?.serviceName ?? `Service #${serviceId}`}
            </DialogTitle>
            {service?.project && <Badge variant="secondary" className="text-xs">{service.project}</Badge>}
            {service?.type && <Badge variant="outline" className="text-xs">{service.type}</Badge>}
          </div>
        </DialogHeader>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto p-5">
          {isLoading && <p className="text-sm text-muted-foreground">Loading service details...</p>}
          {isError && (
            <p className="text-sm text-destructive">
              Error loading service details: {error instanceof Error ? error.message : "Unknown error"}
            </p>
          )}

          {service && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Connection & Network */}
              <Card className="border-border/60 bg-card/50">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Server className="h-4 w-4 text-primary" /> Connection Details
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <InfoRow label="Server IP" value={service.serverIp} />
                  <InfoRow label="Port" value={service.port} />
                  <InfoRow label="DB Name" value={service.dbName} icon={Database} />
                </CardContent>
              </Card>

              {/* Identity & Access */}
              <Card className="border-border/60 bg-card/50">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Lock className="h-4 w-4 text-primary" /> Identity & Access
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0">
                  <InfoRow label="Managed By" value={service.managedBy} />
                  <InfoRow label="Auth User" value={service.authUser} />
                  <InfoRow
                    label="Password"
                    value={
                      service.hasPassword ? (
                        <span className="text-muted-foreground italic tracking-widest text-xs font-mono">
                          ••••••••
                        </span>
                      ) : (
                        "—"
                      )
                    }
                  />
                </CardContent>
              </Card>

              {/* Resources & Information */}
              <Card className="border-border/60 bg-card/50 md:col-span-2">
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Activity className="h-4 w-4 text-primary" /> Resources & Information
                  </CardTitle>
                </CardHeader>
                <CardContent className="pt-0 grid grid-cols-1 md:grid-cols-2 gap-x-6">
                  <InfoRow
                    label="Documentation"
                    value={
                      service.documentLink ? (
                        <a href={service.documentLink} target="_blank" rel="noreferrer" className="text-primary hover:underline flex items-center gap-1.5">
                          {service.documentLink} <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : null
                    }
                  />
                  <InfoRow
                    label="Health Endpoint"
                    value={
                      service.healthUrl ? (
                        <a href={service.healthUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline flex items-center gap-1.5">
                          {service.healthUrl} <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : null
                    }
                  />
                  <div className="md:col-span-2">
                    <InfoRow
                      label="Remark"
                      value={
                        service.remark ? (
                          <span className="whitespace-pre-wrap">{service.remark}</span>
                        ) : null
                      }
                    />
                  </div>
                </CardContent>
              </Card>

              {/* Tags Section */}
              {service.tags && service.tags.length > 0 && (
                <div className="md:col-span-2 space-y-3">
                  <h3 className="text-sm font-semibold flex items-center gap-2 text-muted-foreground">
                    <Tag className="h-4 w-4" /> Attached Tags
                  </h3>
                  <div className="flex flex-wrap gap-2">
                    {service.tags.map((t: any) => (
                      <Badge
                        key={t.id}
                        variant="outline"
                        className="px-2 py-0.5"
                        style={
                          t.color
                            ? { backgroundColor: t.color + "22", borderColor: t.color + "55", color: t.color }
                            : {}
                        }
                      >
                        {t.name}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
