import pc from "picocolors";
import type { AuditResult, Finding } from "./types.js";

const RISK_COLOR = {
  low: pc.green,
  medium: pc.yellow,
  high: pc.red,
} as const;

const CONF_TAG = {
  high: pc.red(pc.bold("HIGH")),
  medium: pc.yellow(pc.bold("MED")),
  low: pc.dim(pc.bold("LOW")),
} as const;

const ORDER = { high: 0, medium: 1, low: 2 } as const;

function date(utc: number): string {
  return new Date(utc * 1000).toISOString().slice(0, 10);
}

function rule(): string {
  return pc.dim("─".repeat(72));
}

function sectionHead(label: string): string {
  return pc.dim(`── ${label} ` + "─".repeat(Math.max(0, 68 - label.length)));
}

function riskMeter(risk: AuditResult["overallRisk"]): string {
  const filled = { low: 3, medium: 6, high: 10 }[risk];
  return RISK_COLOR[risk]("█".repeat(filled)) + pc.dim("·".repeat(10 - filled));
}

function wrapBlock(text: string, indent: string, width = 70): string {
  const limit = Math.max(20, width - indent.length);
  const lines: string[] = [];
  for (const para of text.split(/\n+/)) {
    let current = "";
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      if (current && current.length + 1 + word.length > limit) {
        lines.push(indent + current);
        current = word;
      } else {
        current = current ? `${current} ${word}` : word;
      }
    }
    if (current) lines.push(indent + current);
  }
  return lines.join("\n");
}

function findingBlock(f: Finding, n: number): string[] {
  const out: string[] = [];
  out.push(
    `  ${CONF_TAG[f.confidence]}  ${pc.dim(`#${n}`)} ${pc.cyan(f.category)}`,
  );
  out.push(wrapBlock(pc.bold(f.claim), "        "));
  out.push("");
  out.push(
    `        ${pc.dim("why")}  ${wrapBlock(f.rationale, "             ").trimStart()}`,
  );
  for (const e of f.evidence ?? []) {
    out.push(
      `        ${pc.dim("┊")}    ${pc.italic(`"${e.quote.replace(/\s+/g, " ").slice(0, 240)}"`)}`,
    );
    out.push(`             ${pc.blue(pc.underline(e.permalink))}`);
  }
  out.push(
    `        ${pc.green("fix")}  ${wrapBlock(f.remediation, "             ").trimStart()}`,
  );
  out.push("");
  return out;
}

export function renderText(r: AuditResult): string {
  const out: string[] = [];
  const counts = { high: 0, medium: 0, low: 0 };
  for (const f of r.findings) counts[f.confidence] += 1;
  const risk = r.overallRisk;

  out.push("");
  out.push(`  ${pc.bold("deanonymizer")} ${pc.dim("· exposure report")}`);
  out.push(
    `  ${pc.dim(r.platformProfiles.map((p) => `${p.platform}:${p.username}`).join("  "))}` +
      `  ${pc.dim(`· ${r.itemCount} items`)}` +
      (r.span
        ? `  ${pc.dim(`· ${date(r.span.firstUtc)} → ${date(r.span.lastUtc)}`)}`
        : ""),
  );
  out.push("");
  out.push(
    `  ${pc.dim("risk")}      ${riskMeter(risk)}  ${RISK_COLOR[risk](pc.bold(risk.toUpperCase()))}`,
  );
  out.push(
    `  ${pc.dim("findings")}  ` +
      `${counts.high ? pc.red(`${counts.high} high`) : pc.dim("0 high")}` +
      `  ${counts.medium ? pc.yellow(`${counts.medium} med`) : pc.dim("0 med")}` +
      `  ${counts.low ? `${counts.low} low` : pc.dim("0 low")}`,
  );
  out.push("");

  // Identity block
  out.push(sectionHead("identity"));
  out.push("");
  out.push(`  ${pc.bold(r.identity.exactUser)}`);
  out.push(wrapBlock(pc.dim(r.identity.rationale), "  "));
  if ((r.identity.publicProofUrls?.length ?? 0) > 0) {
    out.push("");
    for (const url of r.identity.publicProofUrls) {
      out.push(`    ${pc.dim("·")} ${pc.blue(pc.underline(url))}`);
    }
  }
  out.push("");

  // Direct identifiers (deterministic extraction — bypasses model)
  const emails = r.directIdentifiers?.emails ?? [];
  const handles = r.directIdentifiers?.socialHandles ?? [];
  if (emails.length > 0 || handles.length > 0) {
    out.push(sectionHead("direct identifiers extracted"));
    out.push("");
    if (emails.length > 0) {
      out.push(`  ${pc.dim("emails")}`);
      for (const e of emails) {
        out.push(`    ${pc.red("✉")}  ${pc.bold(e)}`);
      }
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
    out.push(
      pc.dim(
        "  Pulled by regex (post-HTML-strip) from item bodies, commit author\n" +
          "  lines, and links scraped from the audited profile's external sites.\n" +
          "  These are concrete, citable leaks — scrub them first.",
      ),
    );
    out.push("");
  }

  // Summary
  if (r.summary) {
    out.push(sectionHead("summary"));
    out.push("");
    out.push(wrapBlock(r.summary, "  "));
    out.push("");
  }

  if (r.findings.length === 0) {
    out.push(rule());
    out.push(
      pc.green("  ✓ No identifying signals found in the analyzed window."),
    );
    return out.join("\n");
  }

  // Findings grouped by confidence
  const sorted = [...r.findings].sort(
    (a, b) => ORDER[a.confidence] - ORDER[b.confidence],
  );

  let currentGroup: Finding["confidence"] | null = null;
  sorted.forEach((f, i) => {
    if (f.confidence !== currentGroup) {
      const label =
        f.confidence === "high"
          ? "high-confidence findings"
          : f.confidence === "medium"
            ? "medium-confidence findings"
            : "low-confidence findings";
      out.push(sectionHead(label));
      out.push("");
      currentGroup = f.confidence;
    }
    out.push(...findingBlock(f, i + 1));
  });

  out.push(rule());
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
