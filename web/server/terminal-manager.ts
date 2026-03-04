import type { ServerWebSocket } from "bun";
import { existsSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SocketData } from "./ws-bridge.js";

const textEncoder = new TextEncoder();
const __dirname = dirname(fileURLToPath(import.meta.url));
const WINDOWS_PTY_HOST_PATH = resolve(__dirname, "windows-pty-host.cjs");

/** Bun's PTY terminal handle exposed on proc when spawned with `terminal` option */
interface BunTerminalHandle {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

interface TerminalProcess {
  pid: number;
  kill(signal?: number): void;
  exited: Promise<number>;
}

interface TerminalInstance {
  id: string;
  cwd: string;
  containerId?: string;
  proc: TerminalProcess;
  terminal: BunTerminalHandle;
  browserSockets: Set<ServerWebSocket<SocketData>>;
  cols: number;
  rows: number;
  orphanTimer: ReturnType<typeof setTimeout> | null;
}

interface HostShellSpec {
  binary: string;
  args: string[];
  label: string;
  env: Record<string, string | undefined>;
}

function isAbsoluteOrQualifiedPath(value: string): boolean {
  return value.includes("\\") || value.includes("/") || value.includes(":");
}

function shellBinaryExists(binary: string): boolean {
  if (!binary.trim()) return false;
  if (process.platform !== "win32") return existsSync(binary);
  if (isAbsoluteOrQualifiedPath(binary)) return existsSync(binary);
  return true;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function resolveSpawnCwd(requestedCwd: string): string {
  if (isDirectory(requestedCwd)) return requestedCwd;
  const fallback = process.cwd();
  if (isDirectory(fallback)) {
    console.warn(
      `[terminal] Requested cwd does not exist: ${requestedCwd}. Falling back to process.cwd(): ${fallback}`,
    );
    return fallback;
  }
  throw new Error(`Terminal working directory does not exist: ${requestedCwd}`);
}

function resolveNodeBinary(): string {
  const candidates = [
    process.env.COMPANION_NODE_BINARY?.trim(),
    process.env.NODE_BINARY?.trim(),
    "node",
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!isAbsoluteOrQualifiedPath(candidate)) return candidate;
    if (existsSync(candidate)) return candidate;
  }
  return "node";
}

function toStringEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function sendBridgeCommand(
  proc: ReturnType<typeof Bun.spawn>,
  command: Record<string, unknown>,
): void {
  if (!proc.stdin || typeof proc.stdin === "number") return;
  try {
    (proc.stdin as { write: (chunk: string) => unknown }).write(`${JSON.stringify(command)}\n`);
  } catch {
    // helper may have already exited
  }
}

function readBridgeMessages(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
  onMessage: (msg: Record<string, unknown>) => void,
): void {
  if (!stream || typeof stream === "number") return;
  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        buffer += decoder.decode(value, { stream: true });
        while (true) {
          const newlineIndex = buffer.indexOf("\n");
          if (newlineIndex < 0) break;
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (!line) continue;
          try {
            onMessage(JSON.parse(line) as Record<string, unknown>);
          } catch {
            // ignore malformed helper output lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  })();
}

function readBridgeStderr(
  stream: ReadableStream<Uint8Array> | number | null | undefined,
): void {
  if (!stream || typeof stream === "number") return;
  const decoder = new TextDecoder();
  void (async () => {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        const chunk = decoder.decode(value, { stream: true }).trim();
        if (chunk) console.error(`[terminal][pty-host] ${chunk}`);
      }
    } finally {
      reader.releaseLock();
    }
  })();
}

function resolveHostShell(): HostShellSpec {
  if (process.platform === "win32") {
    const candidates = [
      process.env.COMSPEC?.trim(),
      "pwsh.exe",
      "powershell.exe",
      "cmd.exe",
    ].filter(Boolean) as string[];
    const binary = candidates.find(shellBinaryExists) || "cmd.exe";
    const lower = binary.toLowerCase();

    if (lower.includes("pwsh")) {
      return {
        binary,
        args: ["-NoLogo"],
        label: "pwsh",
        env: { SHELL: "pwsh.exe", MSYSTEM: undefined, MINGW_PREFIX: undefined },
      };
    }
    if (lower.includes("powershell")) {
      return {
        binary,
        args: ["-NoLogo"],
        label: "powershell",
        env: { SHELL: "powershell.exe", MSYSTEM: undefined, MINGW_PREFIX: undefined },
      };
    }
    return {
      binary,
      args: [],
      label: "cmd.exe",
      env: { SHELL: undefined, MSYSTEM: undefined, MINGW_PREFIX: undefined },
    };
  }

  const shell = [
    process.env.SHELL,
    "/bin/bash",
    "/usr/bin/bash",
    "/bin/zsh",
    "/usr/bin/zsh",
    "/bin/sh",
    "/usr/bin/sh",
  ].find((candidate) => !!candidate && existsSync(candidate));
  if (shell) {
    return {
      binary: shell,
      args: ["-l"],
      label: shell,
      env: { SHELL: shell },
    };
  }
  return {
    binary: "sh",
    args: [],
    label: "sh",
    env: {},
  };
}

function broadcastBinary(
  sockets: Set<ServerWebSocket<SocketData>>,
  data: Uint8Array,
): void {
  for (const ws of sockets) {
    try {
      ws.sendBinary(data);
    } catch {
      // socket may have closed
    }
  }
}

export class TerminalManager {
  private instances = new Map<string, TerminalInstance>();

  /** Spawn a terminal in the given directory (host or container). */
  spawn(cwd: string, cols = 80, rows = 24, options?: { containerId?: string }): string {
    const id = randomUUID();
    const containerId = options?.containerId?.trim() || undefined;
    const sockets = new Set<ServerWebSocket<SocketData>>();
    const hostShell = resolveHostShell();
    const resolvedCwd = containerId ? cwd : resolveSpawnCwd(cwd);
    const isWindows = process.platform === "win32";
    const cmd = containerId
      ? [
          "docker",
          "exec",
          "-i",
          "-t",
          "-w",
          cwd,
          containerId,
          "sh",
          "-lc",
          "if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi",
        ]
      : [hostShell.binary, ...hostShell.args];

    const spawnEnv = {
      ...process.env,
      ...(containerId ? {} : hostShell.env),
      TERM: "xterm-256color",
      CLAUDECODE: undefined,
    };

    let proc: TerminalProcess;
    let terminal: BunTerminalHandle;
    try {
      if (isWindows) {
        if (!existsSync(WINDOWS_PTY_HOST_PATH)) {
          throw new Error(`Missing Windows PTY host script: ${WINDOWS_PTY_HOST_PATH}`);
        }
        const helperPayload = Buffer.from(JSON.stringify({
          cmd,
          cwd: containerId ? process.cwd() : resolvedCwd,
          cols,
          rows,
          env: toStringEnv(spawnEnv),
        }), "utf8").toString("base64");
        const bridgeProc = Bun.spawn(
          [resolveNodeBinary(), WINDOWS_PTY_HOST_PATH, helperPayload],
          {
            cwd: process.cwd(),
            env: toStringEnv(process.env as Record<string, string | undefined>),
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
          },
        );

        let bridgeExitCode: number | null = null;
        readBridgeMessages(bridgeProc.stdout, (msg) => {
          const kind = typeof msg.type === "string" ? msg.type : "";
          if (kind === "data" && typeof msg.data === "string") {
            broadcastBinary(sockets, textEncoder.encode(msg.data));
          } else if (kind === "exit" && typeof msg.exitCode === "number") {
            bridgeExitCode = msg.exitCode;
          } else if (kind === "error" && typeof msg.message === "string") {
            console.error(`[terminal][pty-host] ${msg.message}`);
          }
        });
        readBridgeStderr(bridgeProc.stderr);

        proc = {
          pid: bridgeProc.pid,
          kill(signal?: number) {
            try {
              bridgeProc.kill(signal);
            } catch {
              // already exited
            }
          },
          exited: bridgeProc.exited.then((code) => bridgeExitCode ?? code ?? 0),
        };

        terminal = {
          write(data: string) {
            sendBridgeCommand(bridgeProc, { type: "input", data });
          },
          resize(nextCols: number, nextRows: number) {
            sendBridgeCommand(bridgeProc, { type: "resize", cols: nextCols, rows: nextRows });
          },
          close() {
            sendBridgeCommand(bridgeProc, { type: "kill" });
            try {
              bridgeProc.kill();
            } catch {
              // already exited
            }
          },
        };
      } else {
        const bunProc = Bun.spawn(cmd, {
          cwd: containerId ? undefined : resolvedCwd,
          env: spawnEnv,
          terminal: {
            cols,
            rows,
            data: (_terminal, data) => broadcastBinary(sockets, data),
          },
        });
        proc = {
          pid: bunProc.pid,
          kill(signal?: number) {
            bunProc.kill(signal);
          },
          exited: bunProc.exited,
        };
        terminal = (bunProc as any).terminal as BunTerminalHandle;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to spawn terminal with ${containerId ? "docker-shell" : hostShell.label}: ${message}`,
      );
    }
    this.instances.set(id, {
      id,
      cwd: resolvedCwd,
      containerId,
      proc,
      terminal,
      browserSockets: sockets,
      cols,
      rows,
      orphanTimer: null,
    });
    console.log(
      `[terminal] Spawned terminal ${id} in ${resolvedCwd}${containerId ? ` (container ${containerId.slice(0, 12)})` : ""} (${containerId ? "docker-shell" : hostShell.label}, ${cols}x${rows})`,
    );

    // Handle process exit
    proc.exited.then((exitCode) => {
      const inst = this.instances.get(id);
      if (!inst) return;
      const exitMsg = JSON.stringify({ type: "exit", exitCode: exitCode ?? 0 });
      for (const ws of inst.browserSockets) {
        try {
          ws.send(exitMsg);
        } catch {
          // socket may have closed
        }
      }
      console.log(`[terminal] Terminal ${id} exited with code ${exitCode}`);
      this.cleanupInstance(id);
    });

    return id;
  }

  private getTerminalIdFromSocket(ws: ServerWebSocket<SocketData>): string | null {
    const data = ws.data;
    if (data.kind !== "terminal") return null;
    return data.terminalId;
  }

  private cleanupInstance(terminalId: string): void {
    const inst = this.instances.get(terminalId);
    if (!inst) return;
    if (inst.orphanTimer) clearTimeout(inst.orphanTimer);
    this.instances.delete(terminalId);
  }

  /** Handle a message from a browser WebSocket */
  handleBrowserMessage(ws: ServerWebSocket<SocketData>, msg: string | Buffer): void {
    const terminalId = this.getTerminalIdFromSocket(ws);
    if (!terminalId) return;
    const inst = this.instances.get(terminalId);
    if (!inst) return;
    try {
      const str = typeof msg === "string" ? msg : msg.toString();
      const parsed = JSON.parse(str);
      if (parsed.type === "input" && typeof parsed.data === "string") {
        inst.terminal.write(parsed.data);
      } else if (parsed.type === "resize" && typeof parsed.cols === "number" && typeof parsed.rows === "number") {
        this.resize(terminalId, parsed.cols, parsed.rows);
      }
    } catch {
      // Malformed message, ignore
    }
  }

  /** Resize the PTY */
  resize(terminalId: string, cols: number, rows: number): void {
    const inst = this.instances.get(terminalId);
    if (!inst) return;
    inst.cols = cols;
    inst.rows = rows;
    try {
      inst.terminal.resize(cols, rows);
    } catch {
      // resize not available or failed
    }
  }

  private killInstance(inst: TerminalInstance): void {
    if (inst.orphanTimer) clearTimeout(inst.orphanTimer);
    this.instances.delete(inst.id);

    try {
      inst.proc.kill();
    } catch {
      // process may have already exited
    }

    // SIGKILL fallback if SIGTERM doesn't work within 2 seconds
    const pid = inst.proc.pid;
    setTimeout(() => {
      try {
        process.kill(pid, 0); // check if still alive
        inst.proc.kill(9); // SIGKILL
      } catch {
        // already dead, good
      }
    }, 2_000);

    console.log(`[terminal] Killed terminal ${inst.id}`);
  }

  /** Kill one terminal instance. */
  kill(terminalId: string): void {
    const inst = this.instances.get(terminalId);
    if (!inst) return;
    this.killInstance(inst);
  }

  /** Get current terminal info */
  getInfo(terminalId?: string): { id: string; cwd: string; containerId?: string } | null {
    if (terminalId) {
      const inst = this.instances.get(terminalId);
      if (!inst) return null;
      return { id: inst.id, cwd: inst.cwd, containerId: inst.containerId };
    }
    const first = this.instances.values().next().value as TerminalInstance | undefined;
    if (!first) return null;
    return { id: first.id, cwd: first.cwd, containerId: first.containerId };
  }

  /** Attach a browser WebSocket to the terminal */
  addBrowserSocket(ws: ServerWebSocket<SocketData>): void {
    const terminalId = this.getTerminalIdFromSocket(ws);
    if (!terminalId) return;
    const inst = this.instances.get(terminalId);
    if (!inst) return;

    // Cancel orphan kill timer if any
    if (inst.orphanTimer) {
      clearTimeout(inst.orphanTimer);
      inst.orphanTimer = null;
    }

    inst.browserSockets.add(ws);
  }

  /** Remove a browser WebSocket from the terminal */
  removeBrowserSocket(ws: ServerWebSocket<SocketData>): void {
    const terminalId = this.getTerminalIdFromSocket(ws);
    if (!terminalId) return;
    const inst = this.instances.get(terminalId);
    if (!inst) return;
    inst.browserSockets.delete(ws);

    // If no browsers remain, start a grace timer to kill the orphaned terminal
    if (inst.browserSockets.size === 0) {
      const id = inst.id;
      inst.orphanTimer = setTimeout(() => {
        const alive = this.instances.get(id);
        if (alive && alive.browserSockets.size === 0) {
          console.log(`[terminal] No browsers connected, killing orphaned terminal ${id}`);
          this.kill(id);
        }
      }, 5_000);
    }
  }
}
