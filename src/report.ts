import pc from "picocolors";
import type { AuditResult, Finding } from "./types.js";

const RISK_COLOR = {
  low: pc.green,
  medium: pc.yellow,
  high: pc.red,
} as const;

const CONF_BADGE = {
  high: pc.bgRed(pc.white(" HIGH ")),
  medium: pc.bgYellow(pc.black(" MED  ")),
  low: pc.bgBlack(pc.dim(" LOW  ")),
} as const;

const ORDER = { high: 0, medium: 1, low: 2 } as const;

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
  const width = 64;
  const top = pc.dim("╭" + "─".repeat(width - 2) + "╮");
  const bottom = pc.dim("╰" + "─".repeat(width - 2) + "╯");
  return [top, "  " + title, ...subtitles.map((s) => "  " + s), bottom];
}

export function renderText(r: AuditResult): string {
  const out: string[] = [];
  const counts = { high: 0, medium: 0, low: 0 };
  for (const f of r.findings) counts[f.confidence] += 1;

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
  out.push(`  ${pc.dim("proof")}       ${r.identity.rationale}`);
  if ((r.identity.publicProofUrls?.length ?? 0) > 0) {
    for (const url of r.identity.publicProofUrls) {
      out.push(`  ${pc.dim("·")} ${pc.blue(pc.underline(url))}`);
    }
  }
  out.push("");
  out.push("  " + r.summary);
  out.push("");

  if (r.findings.length === 0) {
    out.push(
      pc.green("  ✓ No identifying signals found in the analyzed window."),
    );
    return out.join("\n");
  }

  const sorted = [...r.findings].sort(
    (a, b) => ORDER[a.confidence] - ORDER[b.confidence],
  );

  sorted.forEach((f: Finding, i) => {
    out.push(
      `${CONF_BADGE[f.confidence]} ${pc.dim(`#${i + 1}`)} ` +
        `${pc.cyan(f.category)} — ${pc.bold(f.claim)}`,
    );
    out.push(`     ${pc.dim("why")}  ${f.rationale}`);
    for (const e of f.evidence ?? []) {
      out.push(`     ${pc.dim("┊")} "${e.quote}"`);
      out.push(`       ${pc.blue(pc.underline(e.permalink))}`);
    }
    out.push(`     ${pc.green("fix")}  ${f.remediation}`);
    out.push("");
  });

  out.push(pc.dim("─".repeat(64)));
  out.push(
    pc.dim(
      "This is the exposure an attacker could derive from public text alone.\n" +
        "Prioritize HIGH-confidence findings: edit/delete the cited items,\n" +
        "and avoid reusing the flagged handles or links across platforms.",
    ),
  );

  return out.join("\n");
}

export function renderJson(r: AuditResult): string {
  return JSON.stringify(r, null, 2);
}
