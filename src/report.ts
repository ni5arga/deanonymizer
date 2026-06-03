import pc from "picocolors";
import type { AuditResult, Finding } from "./types.js";

const RISK_COLOR = {
  low: pc.green,
  medium: pc.yellow,
  high: pc.red,
} as const;

const CONF_BADGE = {
  high: pc.red("HIGH"),
  medium: pc.yellow("MED "),
  low: pc.dim("LOW "),
} as const;

function date(utc: number): string {
  return new Date(utc * 1000).toISOString().slice(0, 10);
}

export function renderText(r: AuditResult): string {
  const out: string[] = [];
  out.push("");
  out.push(pc.bold(`Exposure report — ${r.username} (${r.platforms.join(", ")})`));
  out.push(
    pc.dim(
      `${r.itemCount} items` +
        (r.span ? ` · ${date(r.span.firstUtc)} → ${date(r.span.lastUtc)}` : ""),
    ),
  );
  out.push(
    `Overall risk: ${RISK_COLOR[r.overallRisk](pc.bold(r.overallRisk.toUpperCase()))}`,
  );
  out.push(pc.bold(`Exact user: ${r.identity.exactUser}`));
  out.push(`${pc.dim("identity proof:")} ${r.identity.rationale}`);
  if ((r.identity.publicProofUrls?.length ?? 0) > 0) {
    out.push(pc.dim("Public profiles / proof URLs:"));
    for (const url of r.identity.publicProofUrls) {
      out.push(`  ${pc.blue(url)}`);
    }
  }
  out.push("");
  out.push(r.summary);
  out.push("");

  if (r.findings.length === 0) {
    out.push(pc.green("No identifying signals found in the analyzed window."));
    return out.join("\n");
  }

  const order = { high: 0, medium: 1, low: 2 } as const;
  const sorted = [...r.findings].sort(
    (a, b) => order[a.confidence] - order[b.confidence],
  );

  sorted.forEach((f: Finding, i) => {
    out.push(
      `${pc.bold(`${i + 1}.`)} [${CONF_BADGE[f.confidence]}] ` +
        `${pc.cyan(f.category)} — ${pc.bold(f.claim)}`,
    );
    out.push(`   ${pc.dim("why:")} ${f.rationale}`);
    for (const e of f.evidence ?? []) {
      out.push(`   ${pc.dim("·")} "${e.quote}"`);
      out.push(`     ${pc.blue(e.permalink)}`);
    }
    out.push(`   ${pc.green("fix:")} ${f.remediation}`);
    out.push("");
  });

  out.push(pc.dim("─".repeat(60)));
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
