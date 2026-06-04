import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import pc from "picocolors";

/**
 * This tool is deliberately the *defensive* mirror of the deanonymization
 * research in arXiv:2602.16800. It only ever analyzes a subject you assert
 * you are authorized to audit — your own account, or one inside an explicit
 * red-team / pentest scope. It reports what is *inferable* about that subject
 * so they can scrub it. It does NOT search outward to identify a stranger and
 * does NOT cross-match non-consenting people across databases.
 *
 * The consent gate below is intentional friction, not theater.
 */

export const CONSENT_BANNER = `
${pc.bold("deanonymizer")} — authorization check

Run only on accounts you own or are explicitly authorized to assess.
Unauthorized identity targeting is out of scope.
`;

export async function requireConsent(opts: {
  username: string;
  assumeYes: boolean;
}): Promise<void> {
  if (opts.assumeYes) {
    // --i-am-authorized provided non-interactively (CI / scripted self-audit).
    return;
  }

  // No interactive terminal (piped/redirected stdin, CI, etc.). Don't try to
  // read a line — that's what lets unconsumed input spill back to the shell.
  // Require the explicit flag instead and exit cleanly.
  if (!stdin.isTTY) {
    console.error(
      pc.red(
        "\nAborted — authorization prompt needs an interactive terminal.",
      ) +
        "\nRe-run with --i-am-authorized to assert you own/are authorized for the target.",
    );
    process.exit(1);
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(
      pc.yellow(
        `\nDo you confirm you own "${opts.username}" or are explicitly authorized ` +
          `to audit it? [y/N]: `,
      ),
    );
    const normalized = answer.trim().toLowerCase();
    if (normalized !== "y" && normalized !== "yes") {
      console.error(pc.red("\nAborted — no authorization confirmed."));
      process.exit(1);
    }
  } catch {
    // EOF (Ctrl-D) or a closed stream rejects the question promise. Treat as a
    // decline and exit cleanly rather than crashing or hanging.
    console.error(pc.red("\nAborted — no authorization confirmed."));
    process.exit(1);
  } finally {
    rl.close();
  }
}
