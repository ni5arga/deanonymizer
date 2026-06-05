import { spawn } from "node:child_process";
import type { LLMClient, LLMCompleteParams } from "./types.js";

/**
 * Claude Code CLI backend. Shells out to `claude -p` (print/non-interactive
 * mode) so the analysis runs against the user's existing Claude Code session
 * — no API key required in the environment.
 *
 * Tradeoffs vs. the native Anthropic SDK path: no prompt caching, no
 * max_tokens control, slower startup per call (CLI cold start). The
 * caller's JSON-repair fallback in analyze.ts compensates for the lack of a
 * `response_format: json_object` equivalent.
 */
export class ClaudeCodeClient implements LLMClient {
  readonly label = "claude-code";
  readonly model: string;
  /** Claude Code CLI cold-start + analysis dwarfs the API path; give it 8 min. */
  readonly requestTimeoutMs = 480_000;
  private readonly bin: string;
  private readonly explicitModel: boolean;

  constructor(config: { bin?: string; model?: string }) {
    this.bin = config.bin ?? "claude";
    this.explicitModel = Boolean(config.model);
    this.model = config.model ?? "(claude-code default)";
  }

  async complete(params: LLMCompleteParams): Promise<string> {
    const args = ["-p"];
    if (this.explicitModel) args.push("--model", this.model);
    if (params.system) args.push("--append-system-prompt", params.system);

    return new Promise<string>((resolve, reject) => {
      const child = spawn(this.bin, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      const timeout = setTimeout(() => {
        child.kill();
        reject(
          new Error(
            `claude-code request timed out after ${this.requestTimeoutMs}ms`,
          ),
        );
      }, this.requestTimeoutMs);
      timeout.unref();

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (b: Buffer) => {
        stdout += b.toString("utf8");
      });
      child.stderr.on("data", (b: Buffer) => {
        stderr += b.toString("utf8");
      });

      child.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT") {
          reject(
            new Error(
              `claude-code provider: '${this.bin}' not found in PATH. ` +
                `Install Claude Code (https://claude.com/claude-code) or pick another --provider.`,
            ),
          );
        } else {
          reject(new Error(`claude-code spawn failed: ${err.message}`));
        }
      });

      child.on("close", (code) => {
        if (code !== 0) {
          reject(
            new Error(
              `claude-code exited with code ${code}` +
                (stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""),
            ),
          );
          return;
        }
        resolve(stdout);
      });

      child.stdin.write(params.user);
      child.stdin.end();
    });
  }
}
