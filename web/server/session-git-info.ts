import { execSync } from "node:child_process";
import { resolve } from "node:path";
import type { SessionState } from "./session-types.js";
import { containerManager } from "./container-manager.js";

function stripWindowsLongPathPrefix(path: string): string {
  if (process.platform !== "win32") return path;
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice("\\\\?\\UNC\\".length)}`;
  if (path.startsWith("\\\\?\\")) return path.slice("\\\\?\\".length);
  return path;
}

function normalizeCommandCwd(cwd: string): string {
  return stripWindowsLongPathPrefix(resolve(cwd));
}

function shellEscapeSingle(value: string): string {
  return value.replace(/'/g, "'\\''");
}

function runGitCommand(sessionId: string, state: SessionState, command: string): string {
  if (state.is_containerized) {
    const container = containerManager.getContainer(sessionId);
    if (container?.containerId) {
      const containerCwd = container.containerCwd || "/workspace";
      const inner = `cd '${shellEscapeSingle(containerCwd)}' && ${command}`;
      const dockerCmd = `docker exec ${container.containerId} sh -lc ${JSON.stringify(inner)}`;
      return execSync(dockerCmd, { encoding: "utf-8", timeout: 3000 }).trim();
    }
    throw new Error("container not tracked");
  }

  return execSync(command, {
    cwd: normalizeCommandCwd(state.cwd),
    encoding: "utf-8",
    timeout: 3000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function mapContainerPathToHost(sessionId: string, state: SessionState, pathValue: string): string {
  if (!state.is_containerized || !pathValue) return pathValue;
  const container = containerManager.getContainer(sessionId);
  const containerCwd = (container?.containerCwd || "/workspace").replace(/\/+$/, "") || "/";
  const hostCwd = (container?.hostCwd || state.cwd || "").replace(/\/+$/, "") || "/";

  if (pathValue === containerCwd) return hostCwd;
  if (containerCwd !== "/" && pathValue.startsWith(`${containerCwd}/`)) {
    return `${hostCwd}${pathValue.slice(containerCwd.length)}`;
  }
  return pathValue;
}

export function resolveSessionGitInfo(sessionId: string, state: SessionState): void {
  if (!state.cwd) return;
  const wasContainerized = state.is_containerized;
  const previous = {
    git_branch: state.git_branch,
    is_worktree: state.is_worktree,
    repo_root: state.repo_root,
    git_ahead: state.git_ahead,
    git_behind: state.git_behind,
  };
  try {
    state.git_branch = runGitCommand(sessionId, state, "git rev-parse --abbrev-ref HEAD");

    try {
      const gitDir = runGitCommand(sessionId, state, "git rev-parse --git-dir");
      state.is_worktree = gitDir.replace(/\\/g, "/").includes("/worktrees/");
    } catch {
      state.is_worktree = false;
    }

    try {
      if (state.is_worktree) {
        const commonDir = runGitCommand(sessionId, state, "git rev-parse --git-common-dir");
        state.repo_root = resolve(normalizeCommandCwd(state.cwd), commonDir, "..");
      } else {
        state.repo_root = runGitCommand(sessionId, state, "git rev-parse --show-toplevel");
      }
      state.repo_root = mapContainerPathToHost(sessionId, state, state.repo_root);
    } catch {
      // Ignore repo root resolution failures
    }

    try {
      const counts = runGitCommand(
        sessionId,
        state,
        "git rev-list --left-right --count @{upstream}...HEAD",
      );
      const [behind, ahead] = counts.split(/\s+/).map(Number);
      state.git_ahead = ahead || 0;
      state.git_behind = behind || 0;
    } catch {
      state.git_ahead = 0;
      state.git_behind = 0;
    }
  } catch (error) {
    if (state.is_containerized && error instanceof Error && error.message === "container not tracked") {
      state.git_branch = previous.git_branch;
      state.is_worktree = previous.is_worktree;
      state.repo_root = previous.repo_root;
      state.git_ahead = previous.git_ahead;
      state.git_behind = previous.git_behind;
      state.is_containerized = wasContainerized;
      return;
    }
    state.git_branch = "";
    state.is_worktree = false;
    state.repo_root = "";
    state.git_ahead = 0;
    state.git_behind = 0;
  }
  state.is_containerized = wasContainerized;
}
