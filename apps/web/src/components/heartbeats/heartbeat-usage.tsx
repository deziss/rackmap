import { useState } from "react";
import type { HeartbeatDto } from "@inv/shared";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { copyText } from "./heartbeat-status";

/**
 * Copy-paste snippets for wiring a job to its heartbeat. `url` is the full ping
 * URL when the caller may see it, otherwise a placeholder.
 */

const CURL = "curl -fsS -m 10 --retry 3 -o /dev/null";
const WGET = "wget -q -T 10 -O /dev/null";

function snippets(url: string, hb: Pick<HeartbeatDto, "kind" | "schedule">) {
  const schedule = hb.kind === "cron" && hb.schedule && !hb.schedule.startsWith("@") ? hb.schedule : "0 2 * * *";
  return {
    curl: [
      "# Report success (any exit code → pass it on the path instead: /$rc)",
      `${CURL} ${url}`,
      "",
      "# In a script: record the duration and the exit code",
      `${CURL} ${url}/start`,
      "/usr/local/bin/backup.sh; rc=$?",
      `${CURL} ${url}/$rc`,
      "",
      "# Attach the job's output (kept up to 10 KB)",
      'out=$(/usr/local/bin/backup.sh 2>&1); rc=$?',
      `printf '%s' "$out" | curl -fsS -m 10 --retry 3 --data-binary @- -o /dev/null ${url}/$rc`,
      "",
      "# A crontab line",
      `${schedule} /usr/local/bin/backup.sh; ${CURL} ${url}/$?`,
    ].join("\n"),
    wget: [
      "# BusyBox and minimal images ship wget rather than curl",
      `${WGET} ${url}`,
      "",
      `${WGET} ${url}/start`,
      "/usr/local/bin/backup.sh; rc=$?",
      `${WGET} ${url}/$rc`,
    ].join("\n"),
    systemd: [
      "# backup.service — ping on start and on success",
      "[Unit]",
      "Description=Nightly backup",
      "OnFailure=backup-failed.service",
      "",
      "[Service]",
      "Type=oneshot",
      `ExecStartPre=-/usr/bin/${CURL} ${url}/start`,
      "ExecStart=/usr/local/bin/backup.sh",
      `ExecStartPost=-/usr/bin/${CURL} ${url}`,
      "",
      "# backup-failed.service — report the failure",
      "[Service]",
      "Type=oneshot",
      `ExecStart=/usr/bin/${CURL} ${url}/fail`,
    ].join("\n"),
    k8s: [
      "# kubectl create secret generic backup-heartbeat --from-literal=url=" + url,
      "apiVersion: batch/v1",
      "kind: CronJob",
      "metadata:",
      "  name: nightly-backup",
      "spec:",
      `  schedule: "${schedule}"`,
      "  jobTemplate:",
      "    spec:",
      "      template:",
      "        spec:",
      "          restartPolicy: Never",
      "          containers:",
      "            - name: backup",
      "              image: registry.example.com/backup:1.0",
      '              command: ["/bin/sh", "-c"]',
      "              args:",
      "                - |",
      '                  wget -q -T 10 -O /dev/null "$PING_URL/start"',
      "                  /app/backup.sh; rc=$?",
      '                  wget -q -T 10 -O /dev/null "$PING_URL/$rc"',
      "                  exit $rc",
      "              env:",
      "                - name: PING_URL",
      "                  valueFrom:",
      "                    secretKeyRef: { name: backup-heartbeat, key: url }",
    ].join("\n"),
  };
}

function Snippet({ text }: { text: string }) {
  return (
    <div className="relative">
      <pre className="rounded-lg border border-white/10 bg-black/40 p-3 pr-12 text-[11px] leading-relaxed font-mono overflow-x-auto whitespace-pre">{text}</pre>
      <Button
        size="icon"
        variant="ghost"
        className="absolute top-1.5 right-1.5 h-7 w-7"
        title="Copy"
        onClick={async () => {
          if (await copyText(text)) toast.success("Copied");
        }}
      >
        <Copy className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

export function HeartbeatUsage({ url, heartbeat }: { url: string | null; heartbeat: Pick<HeartbeatDto, "kind" | "schedule"> }) {
  const [tab, setTab] = useState("curl");
  const s = snippets(url ?? "<ping URL>", heartbeat);
  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList>
        <TabsTrigger value="curl">curl</TabsTrigger>
        <TabsTrigger value="wget">wget</TabsTrigger>
        <TabsTrigger value="systemd">systemd</TabsTrigger>
        <TabsTrigger value="k8s">Kubernetes</TabsTrigger>
      </TabsList>
      <TabsContent value="curl"><Snippet text={s.curl} /></TabsContent>
      <TabsContent value="wget"><Snippet text={s.wget} /></TabsContent>
      <TabsContent value="systemd"><Snippet text={s.systemd} /></TabsContent>
      <TabsContent value="k8s"><Snippet text={s.k8s} /></TabsContent>
    </Tabs>
  );
}
