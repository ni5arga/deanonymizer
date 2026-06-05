import pc from "picocolors";
import type { AuditResult, Finding } from "./types.js";

const RISK_COLOR = {
  low: pc.green,
  medium: pc.yellow,
  high: pc.red,
} as const;

const CONF_BADGE = {
  high: pc.bgRed(pc.white(pc.bold(" HIGH "))),
  medium: pc.bgYellow(pc.black(pc.bold("  MED "))),
  low: pc.bgBlack(pc.dim(" LOW  ")),
} as const;

const ORDER = { high: 0, medium: 1, low: 2 } as const;

const DEFAULT_WIDTH = 80;
const MAX_WIDTH = 120;

function getBoxWidth(): number {
  const cols = process.stdout.columns;
  if (!cols) return DEFAULT_WIDTH;
  return Math.max(10, Math.min(cols - 4, MAX_WIDTH));
}

function stripAnsi(s: string): string {
  return s.replace(
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    "",
  );
}

/** ANSI-aware word wrap. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  const words = text.trim().split(/\s+/);
  let current = "";
  let currentVisibleLen = 0;

  for (const word of words) {
    const wordVisibleLen = stripAnsi(word).length;

    // Hard-wrap long unstyled tokens (e.g., URLs) to avoid overflowing the box.
    if (stripAnsi(word) === word && wordVisibleLen > width) {
      if (current) lines.push(current);
      for (let i = 0; i < word.length; i += width) {
        lines.push(word.slice(i, i + width));
      }
      current = "";
      currentVisibleLen = 0;
      continue;
    }

    const space = current ? 1 : 0;
    if (currentVisibleLen + space + wordVisibleLen > width) {
      if (current) lines.push(current);
      current = word;
      currentVisibleLen = wordVisibleLen;
    } else {
      current = current ? current + " " + word : word;
      currentVisibleLen += space + wordVisibleLen;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function date(utc: number): string {
  return new Date(utc * 1000).toISOString().slice(0, 10);
}

/** A 10-cell meter that fills with the risk color, e.g. ██████░░░░ */
function riskMeter(risk: AuditResult["overallRisk"]): string {
  const filled = { low: 3, medium: 6, high: 10 }[risk];
  const color = RISK_COLOR[risk];
  return color("█".repeat(filled)) + pc.dim("░".repeat(10 - filled));
}

/** A boxed banner around a title line and any number of dim subtitle lines. */
function banner(title: string, subtitles: string[]): string[] {
  const w = getBoxWidth();
  const top = pc.dim("╭" + "─".repeat(w - 2) + "╮");
  const bottom = pc.dim("╰" + "─".repeat(w - 2) + "╯");
  return [top, "  " + title, ...subtitles.map((s) => "  " + s), bottom];
}

/** Wrap content lines in a colored box with the severity badge in the top border. */
function findingBox(
  f: Finding,
  _index: number,
  contentLines: string[],
): string[] {
  const color = RISK_COLOR[f.confidence];
  const badge = CONF_BADGE[f.confidence];
  const w = getBoxWidth();


  // Top border: ┌─ [badge] ─── ┐
  const dashes = Math.max(0, w - 10);
  const top = color("┌─ ") + badge + color("─".repeat(dashes) + "┐");
  const bottom = color("└" + "─".repeat(w - 2) + "┘");

  const boxed = contentLines.map((line) => {
    const visibleLen = stripAnsi(line).length;
    const padding = Math.max(0, w - visibleLen - 4);
    return color("│") + " " + line + " ".repeat(padding) + color(" │");
  });

  return [top, ...boxed, bottom];
}

export function renderText(r: AuditResult): string {
  const out: string[] = [];
  const counts = { high: 0, medium: 0, low: 0 };
  for (const f of r.findings) counts[f.confidence] += 1;

  const w = getBoxWidth();
  const innerW = w - 6;

  out.push("");
  out.push(
    ...banner(pc.bold("🔎 deanonymizer — exposure report"), [
      pc.dim(`${r.username} · ${r.platforms.join(", ")}`),
      pc.dim(
        `${r.itemCount} items` +
          (r.span
            ? ` · ${date(r.span.firstUtc)} → ${date(r.span.lastUtc)}`
            : ""),
      ),
    ]),
  );
  out.push("");

  const risk = r.overallRisk;
  out.push(
    `  Overall risk  ${riskMeter(risk)}  ` +
      RISK_COLOR[risk](pc.bold(risk.toUpperCase())),
  );
  out.push(
    `  Findings      ${pc.red(`${counts.high} high`)} · ` +
      `${pc.yellow(`${counts.medium} medium`)} · ` +
      `${pc.dim(`${counts.low} low`)}`,
  );
  out.push("");

  out.push(`  ${pc.bold("Exact user")}  ${r.identity.exactUser}`);
  
  const rationaleLines = wrap(r.identity.rationale, innerW - 10);
  rationaleLines.forEach((line, i) => {
    const prefix = i === 0 ? `  ${pc.dim("proof")}       ` : `               `;
    out.push(prefix + line);
  });

  if ((r.identity.publicProofUrls?.length ?? 0) > 0) {
    for (const url of r.identity.publicProofUrls) {
      out.push(`  ${pc.dim("·")} ${pc.blue(pc.underline(url))}`);
    }
  }
  out.push("");

  // Direct Identifiers (from maintainer's new main)
  const emails = r.directIdentifiers?.emails ?? [];
  const handles = r.directIdentifiers?.socialHandles ?? [];
  if (emails.length > 0 || handles.length > 0) {
    out.push(pc.dim("── direct identifiers extracted ".padEnd(w, "─")));
    out.push("");
    if (emails.length > 0) {
      out.push(`  ${pc.dim("emails")}`);
      for (const e of emails) out.push(`    ${pc.red("✉")}  ${pc.bold(e)}`);
      out.push("");
    }
    if (handles.length > 0) {
      out.push(`  ${pc.dim("cross-platform handles")}`);
      const padTo = Math.max(...handles.map((h) => h.platform.length));
      for (const h of handles) {
        const platformLabel = h.platform.padEnd(padTo);
        out.push(
          `    ${pc.cyan(platformLabel)}  ${pc.bold(h.handle)}  ${pc.dim("·")}  ${pc.blue(pc.underline(h.url))}`,
        );
      }
      out.push("");
    }
  }
  
  wrap(r.summary, w - 4).forEach(line => out.push("  " + line));
  out.push("");

  if (r.findings.length === 0) {
    out.push(pc.dim("─".repeat(w)));
    out.push(
      pc.green("  ✓ No identifying signals found in the analyzed window."),
    );
    return out.join("\n");
  }

  const sorted = [...r.findings].sort(
    (a, b) => ORDER[a.confidence] - ORDER[b.confidence],
  );

  sorted.forEach((f: Finding, i) => {
    const lines: string[] = [];
    const headerText = `${pc.dim(`#${i + 1}`)} ${pc.cyan(f.category)} — ${pc.bold(f.claim)}`;
    wrap(headerText, innerW).forEach(l => lines.push(l));

    const whyLines = wrap(f.rationale, innerW - 6);
    whyLines.forEach((l, idx) => {
      const prefix = idx === 0 ? `   ${pc.dim("why")}  ` : `         `;
      lines.push(prefix + l);
    });

    for (const e of f.evidence ?? []) {
      const quoteLines = wrap(`"${e.quote}"`, innerW - 6);
      quoteLines.forEach((l, idx) => {
        const prefix = idx === 0 ? `   ${pc.dim("┊")} ` : `     `;
        lines.push(prefix + l);
      });
      lines.push(`     ${pc.blue(pc.underline(e.permalink))}`);
    }

    const fixLines = wrap(f.remediation, innerW - 6);
    fixLines.forEach((l, idx) => {
      const prefix = idx === 0 ? `   ${pc.green("fix")}  ` : `         `;
      lines.push(prefix + l);
    });

    out.push(...findingBox(f, i, lines));
    out.push("");
  });

  out.push(pc.dim("─".repeat(w)));
  out.push(
    pc.dim(
      "  Prioritize HIGH-confidence findings. Edit or delete the cited items,\n" +
      "  remove leaked emails from commit history (git filter-repo), and avoid\n" +
      "  reusing the flagged handles or external links across platforms.",
    ),
  );

  return out.join("\n");
}

export function renderJson(r: AuditResult): string {
  return JSON.stringify(r, null, 2);
}
