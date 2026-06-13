import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Button } from "@/components/ui/button";
import { Maximize2, Minimize2, X, Terminal as TerminalIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import "@xterm/xterm/css/xterm.css";

interface SshTerminalProps {
  serverId: number;
  onClose: () => void;
}

export function SshTerminal({ serverId, onClose }: SshTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected" | "error">("connecting");
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
      fontSize: 14,
      theme: {
        background: "#09090b",
        foreground: "#fafafa",
        cursor: "#fafafa",
      },
    });
    termRef.current = term;

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);

    term.open(containerRef.current);
    fitAddon.fit();

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/api/v1/servers/${serverId}/ssh`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.binaryType = "arraybuffer";

    ws.onopen = () => {
      setStatus("connected");
      term.focus();
      // Send initial resize
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: "r", c: term.cols, r: term.rows }));
      }
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        term.write(new Uint8Array(event.data));
      } else {
        term.write(event.data);
      }
    };

    ws.onclose = () => setStatus("disconnected");
    ws.onerror = () => setStatus("error");

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: "d", d: data }));
      }
    });

    term.onResize((size) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: "r", c: size.cols, r: size.rows }));
      }
    });

    const handleResize = () => {
      fitAddon.fit();
    };

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      term.dispose();
    };
  }, [serverId]);

  useEffect(() => {
    // Re-fit when fullscreen toggles
    setTimeout(() => {
      fitAddonRef.current?.fit();
      termRef.current?.focus();
    }, 50);
  }, [fullscreen]);

  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden bg-zinc-950 border border-zinc-800 rounded-lg",
        fullscreen ? "fixed inset-4 z-50 shadow-2xl" : "relative h-[400px]"
      )}
    >
      {/* Terminal Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-zinc-900 border-b border-zinc-800 shrink-0">
        <div className="flex items-center gap-2">
          <TerminalIcon className="w-4 h-4 text-zinc-400" />
          <span className="text-sm font-mono font-medium text-zinc-200">
            SSH Session {status === "connecting" && "(Connecting...)"}
            {status === "disconnected" && "(Disconnected)"}
            {status === "error" && "(Error)"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="w-8 h-8 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
            onClick={() => setFullscreen(!fullscreen)}
            title={fullscreen ? "Restore" : "Maximize"}
          >
            {fullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="w-8 h-8 text-zinc-400 hover:text-red-400 hover:bg-zinc-800"
            onClick={onClose}
            title="Close"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Terminal Container */}
      <div className="flex-1 p-2 relative overflow-hidden bg-[#09090b]">
        <div ref={containerRef} className="absolute inset-0 p-2" />
      </div>
    </div>
  );
}
