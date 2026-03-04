"use strict";

const pty = require("node-pty");

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function parsePayload() {
  const encoded = process.argv[2];
  if (!encoded) throw new Error("Missing PTY payload");
  const raw = Buffer.from(encoded, "base64").toString("utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.cmd) || parsed.cmd.length === 0) {
    throw new Error("Invalid PTY payload: cmd is required");
  }
  return parsed;
}

function sanitizeEnv(env) {
  const out = {};
  if (!env || typeof env !== "object") return out;
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function wireInput(term) {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) break;
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      let cmd;
      try {
        cmd = JSON.parse(line);
      } catch {
        continue;
      }
      if (!cmd || typeof cmd !== "object") continue;
      if (cmd.type === "input" && typeof cmd.data === "string") {
        try {
          term.write(cmd.data);
        } catch {
          // ignore writes after exit
        }
      } else if (cmd.type === "resize" && Number.isFinite(cmd.cols) && Number.isFinite(cmd.rows)) {
        try {
          term.resize(cmd.cols, cmd.rows);
        } catch {
          // ignore invalid resize state
        }
      } else if (cmd.type === "kill") {
        try {
          term.kill();
        } catch {
          // ignore
        }
      }
    }
  });
}

function main() {
  try {
    const payload = parsePayload();
    const cmd = payload.cmd;
    const file = String(cmd[0]);
    const args = cmd.slice(1).map((arg) => String(arg));
    const term = pty.spawn(file, args, {
      name: "xterm-256color",
      cols: Number(payload.cols) || 80,
      rows: Number(payload.rows) || 24,
      cwd: typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd(),
      env: sanitizeEnv(payload.env),
      useConpty: true,
      useConptyDll: true,
    });

    term.onData((data) => {
      send({ type: "data", data });
    });

    term.onExit((event) => {
      send({ type: "exit", exitCode: event && typeof event.exitCode === "number" ? event.exitCode : 0 });
      setTimeout(() => process.exit(0), 20);
    });

    wireInput(term);

    process.stdin.on("end", () => {
      try {
        term.kill();
      } catch {
        // ignore
      }
    });

    process.on("SIGTERM", () => {
      try {
        term.kill();
      } catch {
        // ignore
      }
      process.exit(0);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send({ type: "error", message });
    process.exit(1);
  }
}

main();

