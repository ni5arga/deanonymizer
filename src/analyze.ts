import type { LLMClient } from "./llm/index.js";
import type { AuditResult, Finding, Item, Profile } from "./types.js";

export interface AnalyzeProgress {
  phase: "preparing" | "analyzing" | "reducing" | "done";
  percent: number;
  message: string;
  currentChunk?: number;
  totalChunks?: number;
}

type ParsedChunk = {
  overallRisk: AuditResult["overallRisk"];
  summary: string;
  identity?: {
    exactUser?: string;
    rationale?: string;
    publicProofUrls?: string[];
  };
  findings: Finding[];
};

/**
 * The LLM stage. This mirrors step (1) of the paper's attack — "extract
 * identity-relevant features" — but points it at a consenting subject and
 * frames the output as *exposure to be remediated*, not a dossier to act on.
 * We deliberately ask the model to reason over the subject's own words and
 * cite the leaking comments, so the owner can find and delete them.
 */

const SYSTEM = `You are a privacy auditor performing a CONSENT-BASED self-doxx assessment.
The user is auditing their own (or an explicitly authorized) account. Your job is
to show them how exposed their pseudonymous footprint is, so they can scrub it.

Analyze the supplied PUBLIC posts/comments and identify every piece of personal,
identifying, or linkable information that an attacker could infer. Think like the
deanonymization agent in the literature: aggregate weak signals (a timezone here,
a sports team there, a "my company" aside) into stronger conclusions.

Cover at minimum: real name, location (down to city/neighborhood), employer or
school, age/DOB, gender, family/relationships, financial details, health, daily
routine/timezone, reused usernames or handles on other platforms, external links
(personal sites, GitHub, LinkedIn), and distinctive writing-style fingerprints.

You must point to the exact user identity represented by the provided footprint.
Include public-facing proof URLs when present in the text or directly inferable
from the supplied account profiles (for example LinkedIn, GitHub, personal site,
portfolio, or the platform profile pages themselves).

For each finding give: the inferred claim, a calibrated confidence, the reasoning
chain, the specific quotes + permalinks that leak it, and concrete remediation.

Be rigorous and honest about confidence. Do NOT fabricate a real-world identity,
do NOT guess a specific named person, and do NOT perform outward lookups — only
report what the TEXT ITSELF reveals or makes linkable. Output ONLY the requested
JSON.`;

const SCHEMA_HINT = `Return a JSON object of exactly this shape:
{
  "overallRisk": "low" | "medium" | "high",
  "summary": "2-4 sentence plain-language exposure summary",
  "identity": {
    "exactUser": "single string naming the exact audited user or linked real identity",
    "rationale": "short explanation of why this is the same user",
    "publicProofUrls": ["https://..."]
  },
  "findings": [
    {
      "category": "location" | "employer_or_school" | "real_name" | "age_or_dob" | "gender" | "relationships_or_family" | "financial" | "health" | "schedule_or_routine" | "cross_platform_handle" | "external_link" | "writing_fingerprint" | "other",
      "claim": "what an attacker concludes",
      "confidence": "low" | "medium" | "high",
      "rationale": "the reasoning chain over the evidence",
      "evidence": [ { "quote": "verbatim snippet", "permalink": "https://..." } ],
      "remediation": "concrete action to reduce this exposure"
    }
  ]
}`;

/** Compact items into a token-bounded transcript the model can reason over. */
function renderItems(items: Item[], maxChars: number): string {
  const lines: string[] = [];
  let used = 0;
  for (const it of items) {
    const when = new Date(it.createdUtc * 1000).toISOString().slice(0, 10);
    const body = it.body.replace(/\s+/g, " ").slice(0, 420);
    const line = `[${it.platform} ${it.kind} | ${it.context} | ${when}] ${body}\n(${it.permalink})`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length;
  }
  return lines.join("\n\n");
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

function safeJsonSlice(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return raw;
  }
  return raw.slice(start, end + 1);
}

function chunkSignalStats(items: Item[]): {
  posts: number;
  comments: number;
  urlMentions: number;
  handleMentions: number;
} {
  let posts = 0;
  let comments = 0;
  let urlMentions = 0;
  let handleMentions = 0;
  const urlRe = /https?:\/\//g;
  const handleRe = /(?:^|\s)@?[A-Za-z0-9_]{3,}(?=\s|$)/g;

  for (const it of items) {
    if (it.kind === "post") posts += 1;
    if (it.kind === "comment") comments += 1;
    const body = it.body ?? "";
    urlMentions += body.match(urlRe)?.length ?? 0;
    handleMentions += body.match(handleRe)?.length ?? 0;
  }

  return { posts, comments, urlMentions, handleMentions };
}

function findingStats(findings: Finding[]): {
  total: number;
  high: number;
  medium: number;
  low: number;
} {
  let high = 0;
  let medium = 0;
  let low = 0;
  for (const f of findings) {
    if (f.confidence === "high") high += 1;
    else if (f.confidence === "medium") medium += 1;
    else low += 1;
  }
  return { total: findings.length, high, medium, low };
}

function emptyChunk(): ParsedChunk {
  return {
    overallRisk: "low",
    summary: "Chunk parse failed; no findings emitted for this chunk.",
    identity: undefined,
    findings: [],
  };
}

async function parseChunkOrRepair(
  llm: LLMClient,
  text: string,
): Promise<{ parsed: ParsedChunk; repaired: boolean }> {
  const firstTry = safeJsonSlice(text);
  try {
    return { parsed: JSON.parse(firstTry) as ParsedChunk, repaired: false };
  } catch {
    const repairPrompt = `The text below should contain a JSON object but is malformed.
Repair it into valid JSON that matches this schema exactly, preserving meaning.
Return ONLY valid JSON.

${SCHEMA_HINT}

Malformed text:
${text.slice(0, 120000)}`;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const repairedText = await llm.complete({
          user: repairPrompt,
          maxTokens: 4000,
          json: true,
        });
        const sliced = safeJsonSlice(repairedText);
        return { parsed: JSON.parse(sliced) as ParsedChunk, repaired: true };
      } catch {
        // The completion errored (e.g. an endpoint returned empty content) or
        // the response was still invalid JSON. Retry once more; if it never
        // succeeds we degrade to an empty chunk below rather than aborting the
        // whole run.
      }
    }

    return { parsed: emptyChunk(), repaired: true };
  }
}

/** Estimate the rendered transcript size of one item (mirrors chunkItemsByChars). */
function itemRenderSize(it: Item): number {
  const when = new Date(it.createdUtc * 1000).toISOString().slice(0, 10);
  const body = it.body.replace(/\s+/g, " ").slice(0, 800);
  const line = `[${it.platform} ${it.kind} | ${it.context} | ${when}] ${body}\n(${it.permalink})`;
  return line.length + 2;
}

/**
 * Cap items to a total character budget. `--max-chars` is documented as the
 * total transcript sent to the model; we enforce it here so the analysis does
 * not silently balloon to many chunks (the dominant cost). Items are
 * already sorted newest-first, so this keeps the most recent footprint.
 */
function capItemsToCharBudget(items: Item[], maxChars: number): Item[] {
  const out: Item[] = [];
  let used = 0;
  for (const it of items) {
    const size = itemRenderSize(it);
    if (used + size > maxChars && out.length > 0) break;
    out.push(it);
    used += size;
  }
  return out;
}

function chunkItemsByChars(items: Item[], chunkChars: number): Item[][] {
  if (items.length === 0) return [];
  const chunks: Item[][] = [];
  let current: Item[] = [];
  let used = 0;

  for (const it of items) {
    const when = new Date(it.createdUtc * 1000).toISOString().slice(0, 10);
    const body = it.body.replace(/\s+/g, " ").slice(0, 800);
    const line = `[${it.platform} ${it.kind} | ${it.context} | ${when}] ${body}\n(${it.permalink})`;
    const size = line.length + 2;

    if (current.length > 0 && used + size > chunkChars) {
      chunks.push(current);
      current = [];
      used = 0;
    }

    current.push(it);
    used += size;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

export async function analyze(
  profiles: Profile[],
  opts: {
    llm: LLMClient;
    maxChars: number;
    chunkChars?: number;
    chunkConcurrency?: number;
    onProgress?: (p: AnalyzeProgress) => void;
  },
): Promise<AuditResult> {
  const llm = opts.llm;

  const allItems = profiles.flatMap((p) => p.items);
  const username = profiles[0]?.username ?? "(unknown)";
  const platforms = profiles.map((p) => p.platform);
  const platformProfiles = profiles.map((p) => ({
    platform: p.platform,
    username: p.username,
    profileUrl: p.profileUrl,
  }));

  opts.onProgress?.({
    phase: "preparing",
    percent: 5,
    message: `Preparing analysis for ${allItems.length} items`,
  });

  const chunkChars = Math.min(
    Math.max(opts.chunkChars ?? 24000, 8000),
    opts.maxChars,
  );
  const budgetedItems = capItemsToCharBudget(allItems, opts.maxChars);
  const dropped = allItems.length - budgetedItems.length;
  if (dropped > 0) {
    opts.onProgress?.({
      phase: "preparing",
      percent: 7,
      message: `Trimmed ${dropped} oldest item(s) to fit the ${opts.maxChars}-char budget (raise --max-chars to include more)`,
    });
  }
  const chunks = chunkItemsByChars(budgetedItems, chunkChars);
  const parsedByIndex: Array<ParsedChunk | undefined> = new Array(
    chunks.length,
  );
  const totalChunks = chunks.length;
  // Default to running every chunk concurrently (capped to avoid API rate
  // limits). Chunk analysis is independent, so serial rounds were the main
  // source of wall-clock latency.
  const maxConcurrency = Math.max(
    1,
    Math.min(opts.chunkConcurrency ?? 8, totalChunks || 1),
  );
  let nextIndex = 0;
  let completed = 0;

  async function analyzeOneChunk(i: number): Promise<void> {
    const currentChunk = i + 1;
    opts.onProgress?.({
      phase: "analyzing",
      percent: Math.round(10 + (completed / Math.max(totalChunks, 1)) * 80),
      currentChunk,
      totalChunks,
      message: `Analyzing chunk ${currentChunk}/${totalChunks}`,
    });

    const preStats = chunkSignalStats(chunks[i]);
    opts.onProgress?.({
      phase: "analyzing",
      percent: Math.round(10 + (completed / Math.max(totalChunks, 1)) * 80),
      currentChunk,
      totalChunks,
      message:
        `Signals: ${chunks[i].length} items (${preStats.posts} posts, ${preStats.comments} comments), ` +
        `${preStats.urlMentions} URLs, ${preStats.handleMentions} handle-like tokens`,
    });

    const transcript = renderItems(chunks[i], chunkChars);
    const userMsg = `Subject handle(s): ${username} on ${platforms.join(", ")}
Items analyzed in this chunk: ${chunks[i].length}

Subject profile URLs:
${platformProfiles.map((p) => `- ${p.platform}: ${p.profileUrl}`).join("\n")}

=== PUBLIC FOOTPRINT CHUNK ${currentChunk}/${totalChunks} ===
${transcript}

=== END FOOTPRINT CHUNK ===

${SCHEMA_HINT}`;

    const started = Date.now();
    const heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - started) / 1000);
      opts.onProgress?.({
        phase: "analyzing",
        percent: Math.round(10 + (completed / Math.max(totalChunks, 1)) * 80),
        currentChunk,
        totalChunks,
        message: `Waiting on model response (${elapsed}s elapsed)`,
      });
    }, 8000);

    let text = "";
    try {
      text = await withTimeout(
        llm.complete({
          system: SYSTEM,
          user: userMsg,
          maxTokens: 2200,
          json: true,
        }),
        70000,
        `chunk ${currentChunk}/${totalChunks}`,
      );
    } catch {
      opts.onProgress?.({
        phase: "analyzing",
        percent: Math.round(10 + (completed / Math.max(totalChunks, 1)) * 80),
        currentChunk,
        totalChunks,
        message: "Primary pass slow/failed, retrying with compressed chunk",
      });

      const compressedTranscript = renderItems(
        chunks[i].slice(0, 28),
        Math.min(chunkChars, 12000),
      );
      const compressedMsg = `Subject handle(s): ${username} on ${platforms.join(", ")}
Items analyzed in this compressed chunk: ${Math.min(chunks[i].length, 28)}

Subject profile URLs:
${platformProfiles.map((p) => `- ${p.platform}: ${p.profileUrl}`).join("\n")}

=== PUBLIC FOOTPRINT CHUNK ${currentChunk}/${totalChunks} (COMPRESSED) ===
${compressedTranscript}

=== END FOOTPRINT CHUNK ===

${SCHEMA_HINT}`;

      text = await withTimeout(
        llm.complete({
          system: SYSTEM,
          user: compressedMsg,
          maxTokens: 1100,
          json: true,
        }),
        45000,
        `compressed chunk ${currentChunk}/${totalChunks}`,
      );
    } finally {
      clearInterval(heartbeat);
    }

    const { parsed, repaired } = await parseChunkOrRepair(llm, text);
    parsedByIndex[i] = parsed;
    completed += 1;

    const out = findingStats(parsed.findings ?? []);
    opts.onProgress?.({
      phase: "analyzing",
      percent: Math.round(10 + (completed / Math.max(totalChunks, 1)) * 80),
      currentChunk,
      totalChunks,
      message:
        `Chunk outcome: ${out.total} findings (high ${out.high}, medium ${out.medium}, low ${out.low})` +
        (repaired ? " [json-repair path]" : ""),
    });
  }

  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= totalChunks) return;
      await analyzeOneChunk(i);
    }
  }

  await Promise.all(Array.from({ length: maxConcurrency }, () => worker()));
  const parsedChunks = parsedByIndex.filter((c): c is ParsedChunk =>
    Boolean(c),
  );

  opts.onProgress?.({
    phase: "reducing",
    percent: 92,
    message: "Reducing chunk outputs",
  });

  const overallRisk: AuditResult["overallRisk"] = parsedChunks.some(
    (c) => c.overallRisk === "high",
  )
    ? "high"
    : parsedChunks.some((c) => c.overallRisk === "medium")
      ? "medium"
      : "low";

  const parsed = {
    overallRisk,
    summary:
      parsedChunks
        .map((c) => c.summary?.trim())
        .filter(Boolean)
        .slice(0, 3)
        .join(" ") ||
      `Analyzed ${allItems.length} items across ${chunks.length} chunk(s).`,
    identity: parsedChunks.find(
      (c) => c.identity?.exactUser || c.identity?.rationale,
    )?.identity,
    findings: parsedChunks.flatMap((c) => c.findings ?? []),
  };

  const knownProofUrls = new Set(platformProfiles.map((p) => p.profileUrl));
  for (const f of parsed.findings ?? []) {
    for (const e of f.evidence ?? []) {
      if (typeof e?.quote === "string") {
        for (const m of e.quote.matchAll(/https?:\/\/\S+/g)) {
          knownProofUrls.add(m[0].replace(/[),.;!?]+$/, ""));
        }
      }
    }
  }

  for (const url of parsed.identity?.publicProofUrls ?? []) {
    if (typeof url === "string" && /^https?:\/\//i.test(url)) {
      knownProofUrls.add(url.trim());
    }
  }

  const span =
    allItems.length > 0
      ? {
          firstUtc: Math.min(...allItems.map((i) => i.createdUtc)),
          lastUtc: Math.max(...allItems.map((i) => i.createdUtc)),
        }
      : undefined;

  opts.onProgress?.({
    phase: "done",
    percent: 100,
    message: `Analysis complete (${chunks.length} chunk${chunks.length === 1 ? "" : "s"})`,
  });

  return {
    username,
    platforms,
    platformProfiles,
    itemCount: allItems.length,
    span,
    overallRisk: parsed.overallRisk ?? "low",
    summary: parsed.summary ?? "",
    identity: {
      exactUser: parsed.identity?.exactUser?.trim() || username,
      rationale:
        parsed.identity?.rationale?.trim() ||
        "Matched from provided platform handles and public posting footprint.",
      publicProofUrls: [...knownProofUrls],
    },
    findings: parsed.findings ?? [],
  };
}
