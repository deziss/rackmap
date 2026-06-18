import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Maximize2, Minimize2, X, Terminal as TerminalIcon, Eye, EyeOff, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import "@xterm/xterm/css/xterm.css";

interface SshTerminalProps {
  serverId: number;
  onClose: () => void;
  className?: string;
}

export function SshTerminal({ serverId, onClose, className }: SshTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected" | "error">("connecting");
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  // Password prompt state — set when server sends {"t":"need_password"} or {"t":"auth_error"}
  const [passwordPrompt, setPasswordPrompt] = useState<{ message: string } | null>(null);
  const [passwordInput, setPasswordInput] = useState("");
  const [showPw, setShowPw] = useState(false);

  // Incrementing this key re-runs the useEffect, triggering a reconnect
  const [reconnectKey, setReconnectKey] = useState(0);

  useEffect(() => {
    if (!containerRef.current) return;

    setStatus("connecting");
    setPasswordPrompt(null);
    setPasswordInput("");
    setShowPw(false);

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
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: "r", c: term.cols, r: term.rows }));
      }
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        // Binary = raw terminal data
        term.write(new Uint8Array(event.data));
      } else {
        // String = control message JSON from server
        try {
          const msg = JSON.parse(event.data as string) as { t?: string; message?: string };
          if (msg.t === "need_password") {
            setPasswordPrompt({ message: msg.message ?? "Enter SSH password:" });
            setStatus("connected"); // keep "connected" label while waiting
          } else if (msg.t === "auth_error") {
            setPasswordPrompt({ message: msg.message ?? "Wrong password — try again:" });
          } else {
            term.write(event.data as string);
          }
        } catch {
          term.write(event.data as string);
        }
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

    const handleResize = () => { fitAddon.fit(); };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      term.dispose();
    };
  }, [serverId, reconnectKey]);

  useEffect(() => {
    setTimeout(() => {
      fitAddonRef.current?.fit();
      termRef.current?.focus();
    }, 50);
  }, [fullscreen]);

  function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !passwordInput.trim()) return;
    ws.send(JSON.stringify({ t: "p", p: passwordInput }));
    setPasswordPrompt(null);
    setPasswordInput("");
    setShowPw(false);
  }

  const isDisconnected = status === "disconnected" || status === "error";

  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden bg-zinc-950 border border-zinc-800 rounded-lg",
        fullscreen ? "fixed inset-4 z-50 shadow-2xl" : "relative h-100",
        !fullscreen && className,
      )}
    >
      {/* Terminal Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-zinc-900 border-b border-zinc-800 shrink-0">
        <div className="flex items-center gap-2">
          <TerminalIcon className="w-4 h-4 text-zinc-400" />
          <span className="text-sm font-mono font-medium text-zinc-200">
            SSH Session{" "}
            {status === "connecting" && <span className="text-zinc-400">(Connecting…)</span>}
            {status === "disconnected" && <span className="text-red-400">(Disconnected)</span>}
            {status === "error" && <span className="text-red-400">(Error)</span>}
            {passwordPrompt && <span className="text-yellow-400">(Awaiting password)</span>}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {isDisconnected && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 gap-1"
              onClick={() => setReconnectKey((k) => k + 1)}
              title="Reconnect"
            >
              <RefreshCw className="w-3 h-3" />
              Reconnect
            </Button>
          )}
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
      <div className="flex-1 relative overflow-hidden bg-[#09090b]">
        <div ref={containerRef} className="absolute inset-0 p-2" />

        {/* Password prompt overlay */}
        {passwordPrompt && (
          <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/90 backdrop-blur-sm z-10">
            <div className="w-80 rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl p-5">
              <p className="text-sm font-mono text-zinc-200 mb-4">{passwordPrompt.message}</p>
              <form onSubmit={submitPassword} className="space-y-3">
                <div className="relative">
                  <Input
                    type={showPw ? "text" : "password"}
                    value={passwordInput}
                    onChange={(e) => setPasswordInput(e.target.value)}
                    placeholder="SSH password"
                    autoFocus
                    className="bg-zinc-800 border-zinc-600 text-zinc-100 pr-9 font-mono"
                    autoComplete="current-password"
                  />
                  <button
                    type="button"
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200"
                    onClick={() => setShowPw((v) => !v)}
                    tabIndex={-1}
                  >
                    {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <div className="flex gap-2">
                  <Button type="submit" size="sm" className="flex-1" disabled={!passwordInput.trim()}>
                    Connect
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="border-zinc-600 text-zinc-300 hover:bg-zinc-800"
                    onClick={() => { setPasswordPrompt(null); onClose(); }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
