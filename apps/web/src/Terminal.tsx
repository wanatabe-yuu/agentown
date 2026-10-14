import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";

/**
 * Terminal into an agent runtime. The server mints a one-time ticket only after
 * checking runtime.exec for the current actor on this exact agent; the session
 * is bound to the runtime generation and closed server-side if the permission
 * or the runtime changes.
 */
export function Terminal({ agentId }: { agentId: string }) {
  const el = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState("connecting…");

  useEffect(() => {
    const term = new XTerm({ fontSize: 13, cursorBlink: true, convertEol: true, theme: { background: "#0b1220" } });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(el.current!);
    fitAddon.fit();
    let ws: WebSocket | null = null;
    let closed = false;

    (async () => {
      try {
        const s = await api<{ sessionId: string; ticket: string; generation: number }>("POST", `/api/agents/${agentId}/terminal-sessions`);
        if (closed) return;
        const proto = location.protocol === "https:" ? "wss" : "ws";
        ws = new WebSocket(`${proto}://${location.host}/api/terminal-sessions/${s.sessionId}/attach?ticket=${encodeURIComponent(s.ticket)}`);
        ws.onopen = () => {
          setStatus(`session ${s.sessionId} · runtime g${s.generation}`);
          ws!.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        };
        ws.onmessage = (m) => {
          const msg = JSON.parse(m.data);
          if (msg.type === "output") term.write(msg.data);
          if (msg.type === "exit") {
            term.write(`\r\n\x1b[33m[session closed: ${msg.reason}]\x1b[0m\r\n`);
            setStatus(`closed: ${msg.reason}`);
          }
        };
        ws.onclose = () => setStatus((st) => (st.startsWith("closed") ? st : "disconnected"));
        term.onData((data) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "input", data })));
        term.onResize(({ cols, rows }) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "resize", cols, rows })));
      } catch (err) {
        setStatus(`denied: ${(err as Error).message}`);
        term.write(`\x1b[31m${(err as Error).message}\x1b[0m\r\n`);
      }
    })();

    const ro = new ResizeObserver(() => fitAddon.fit());
    ro.observe(el.current!);
    return () => {
      closed = true;
      ro.disconnect();
      ws?.close();
      term.dispose();
    };
  }, [agentId]);

  return (
    <div className="terminal">
      <div className="terminal-status">{status}</div>
      <div ref={el} className="terminal-body" />
    </div>
  );
}
