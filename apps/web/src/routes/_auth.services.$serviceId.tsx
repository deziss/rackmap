import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { fetchService, serviceKeys } from "@/lib/queries";
import { StatusDot } from "@/components/status-dot";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Server, Activity, Lock, Database, Globe, Tag, ExternalLink } from "lucide-react";

export const Route = createFileRoute("/_auth/services/$serviceId")({
  component: ServiceDetailPage,
});

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

function ServiceDetailPage() {
  const { serviceId } = Route.useParams();
  const id = Number(serviceId);

  const { data: service, isLoading, isError, error } = useQuery({
    queryKey: serviceKeys.detail(id),
    queryFn: () => fetchService(id),
  });

  if (isLoading) {
    return <div className="p-8 text-center text-muted-foreground animate-pulse">Loading service details...</div>;
  }

  if (isError || !service) {
    return (
      <div className="p-8 text-center text-destructive">
        Error loading service: {error instanceof Error ? error.message : "Unknown error"}
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <Link to="/services">
          <Button size="sm" variant="ghost" className="gap-1.5">
            <ArrowLeft className="h-4 w-4" /> Services
          </Button>
        </Link>
        <div className="flex items-center gap-2">
          <StatusDot status={service.lastStatus as "up" | "down" | "unknown"} latencyMs={service.lastLatencyMs} ip={service.serverIp || ""} port={Number(service.port)} />
          <h1 className="text-xl font-semibold">{service.serviceName}</h1>
        </div>
        {service.version && <Badge variant="secondary" className="font-mono">v{service.version}</Badge>}
        {service.environment && <Badge variant="outline" className="uppercase">{service.environment}</Badge>}
        {service.serviceType && <Badge variant="secondary">{service.serviceType}</Badge>}
        
        <div className="ml-auto text-sm text-muted-foreground flex items-center gap-2">
          {service.lastCheckedAt && <span>Last checked: {new Date(service.lastCheckedAt).toLocaleString()}</span>}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Connection Details */}
        <Card>
          <CardHeader className="pb-3 border-b border-white/5">
            <CardTitle className="text-base flex items-center gap-2">
              <Globe className="h-4 w-4 text-primary" /> Connection Details
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-3 p-0 px-4 pb-2">
            <InfoRow label="Server IP" value={service.serverIp} icon={Server} />
            <InfoRow label="Port" value={<span className="font-mono">{service.port}</span>} />
            <InfoRow label="Domain" value={service.domain} />
            <InfoRow label="DB Name" value={service.dbName} icon={Database} />
          </CardContent>
        </Card>

        {/* Identity & Access */}
        <Card>
          <CardHeader className="pb-3 border-b border-white/5">
            <CardTitle className="text-base flex items-center gap-2">
              <Lock className="h-4 w-4 text-primary" /> Identity & Access
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-3 p-0 px-4 pb-2">
            <InfoRow label="Username" value={<span className="font-mono">{service.username}</span>} />
            <InfoRow label="Has Password" value={service.hasPassword ? <Badge variant="outline" className="border-emerald-500/30 text-emerald-500">Yes</Badge> : "No"} />
            <InfoRow label="Project" value={service.project} />
            <InfoRow label="Managed By" value={service.managedBy} />
          </CardContent>
        </Card>

        {/* External Resources */}
        <Card className="md:col-span-2">
          <CardHeader className="pb-3 border-b border-white/5">
            <CardTitle className="text-base flex items-center gap-2">
              <Activity className="h-4 w-4 text-primary" /> Resources & Information
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-3 p-0 px-4 pb-2">
            <InfoRow 
              label="Document Link" 
              value={service.documentLink ? (
                <a href={service.documentLink} target="_blank" rel="noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
                  {service.documentLink} <ExternalLink className="h-3 w-3" />
                </a>
              ) : null} 
            />
            <InfoRow 
              label="Health URL" 
              value={service.healthUrl ? (
                <a href={service.healthUrl} target="_blank" rel="noreferrer" className="text-primary hover:underline inline-flex items-center gap-1">
                  {service.healthUrl} <ExternalLink className="h-3 w-3" />
                </a>
              ) : null} 
            />
            <InfoRow label="Tags" value={
              service.tags && service.tags.length > 0 ? (
                <div className="flex gap-2 flex-wrap">
                  {service.tags.map((t: any) => (
                    <Badge key={t.id} variant="outline" className="text-xs" style={{ borderColor: t.color || undefined }}>
                      {t.name}
                    </Badge>
                  ))}
                </div>
              ) : null
            } icon={Tag} />
            <InfoRow label="Remark / Notes" value={<div className="whitespace-pre-wrap">{service.remark}</div>} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
