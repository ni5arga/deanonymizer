/**
 * Deterministic identifier extraction. The LLM stage sometimes paraphrases
 * obvious leaks away ("the bio shows an email" instead of citing the email),
 * so we run a regex pass over every item body in parallel and surface the
 * raw hits in the report. This guarantees that any concrete email or
 * cross-platform handle present in the data ends up visible to the user.
 */

export interface SocialHandle {
  platform: string;
  handle: string;
  url: string;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const SOCIAL_PATTERNS: Array<{
  platform: string;
  pattern: RegExp;
  reject?: RegExp;
}> = [
  {
    platform: "linkedin",
    pattern: /https?:\/\/(?:[\w-]+\.)?linkedin\.com\/in\/([A-Za-z0-9_-]+)/gi,
  },
  {
    platform: "x",
    pattern:
      /https?:\/\/(?:www\.|mobile\.)?(?:twitter\.com|x\.com)\/([A-Za-z0-9_]+)(?=\b|\/|$)/gi,
    reject:
      /^(home|search|explore|intent|share|hashtag|notifications|messages|settings|i|compose|login|signup|tos|privacy|about)$/i,
  },
  {
    platform: "github",
    pattern:
      /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9][A-Za-z0-9-]{0,38})(?=\b|\/|$)/gi,
    reject:
      /^(issues|pull|search|trending|marketplace|orgs|topics|collections|notifications|settings|new|features|pricing|enterprise|sponsors|readme|about|contact|login|join|signup|security|nonprofit|customer-stories|events|codespaces|copilot)$/i,
  },
  {
    platform: "youtube",
    pattern:
      /https?:\/\/(?:www\.)?youtube\.com\/(?:@|channel\/|user\/|c\/)([A-Za-z0-9_-]+)/gi,
  },
  {
    platform: "instagram",
    pattern:
      /https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9_.]+)(?=\b|\/|$)/gi,
    reject: /^(p|reel|tv|accounts|explore|stories|about|developer)$/i,
  },
  {
    platform: "bluesky",
    pattern: /https?:\/\/(?:www\.)?bsky\.app\/profile\/([A-Za-z0-9_.:-]+)/gi,
  },
  {
    platform: "reddit",
    pattern:
      /https?:\/\/(?:www\.|old\.)?reddit\.com\/(?:u|user)\/([A-Za-z0-9_-]+)/gi,
  },
  {
    platform: "hackernews",
    pattern: /https?:\/\/news\.ycombinator\.com\/user\?id=([A-Za-z0-9_-]+)/gi,
  },
  {
    platform: "telegram",
    pattern: /https?:\/\/(?:www\.)?t\.me\/([A-Za-z0-9_]+)/gi,
    reject: /^(joinchat|s)$/i,
  },
  {
    platform: "gitlab",
    pattern:
      /https?:\/\/(?:www\.)?gitlab\.com\/([A-Za-z0-9][A-Za-z0-9_-]+)(?=\b|\/|$)/gi,
    reject: /^(explore|help|users|projects|search|public|dashboard|admin)$/i,
  },
  {
    platform: "stackoverflow",
    pattern: /https?:\/\/stackoverflow\.com\/users\/(\d+)/gi,
  },
  {
    platform: "mastodon",
    pattern:
      /https?:\/\/(mastodon\.[a-z.]+|mstdn\.[a-z.]+|fosstodon\.org|hachyderm\.io|infosec\.exchange)\/@([A-Za-z0-9_]+)/gi,
  },
];

/** Replace common email obfuscation patterns with the canonical form. */
export function deobfuscateEmails(input: string): string {
  return input
    .replace(/\s*\[\s*at\s*\]\s*/gi, "@")
    .replace(/\s*\(\s*at\s*\)\s*/gi, "@")
    .replace(/\s+at\s+(?=[A-Za-z0-9.-]+\s*(?:\[|\()?\s*dot)/gi, "@")
    .replace(/\s*\[\s*dot\s*\]\s*/gi, ".")
    .replace(/\s*\(\s*dot\s*\)\s*/gi, ".")
    .replace(/\s+dot\s+/gi, ".");
}

/** Pull every email from `text`, de-obfuscated, lowercase, deduped. */
export function extractEmails(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  const canon = deobfuscateEmails(text);
  for (const m of canon.matchAll(EMAIL_RE)) {
    const e = m[0].toLowerCase();
    if (e.endsWith("@users.noreply.github.com")) continue;
    if (e.endsWith("@example.com")) continue;
    if (e.endsWith("@email.com")) continue;
    // Reject domain literals like 0.0.0 or 1.2.3 — common false positives.
    if (/^\d+(\.\d+)*$/.test(e.split("@")[1])) continue;
    out.add(e);
  }
  return [...out];
}

/** Pull cross-platform social handles from URLs in `text`. */
export function extractSocialHandles(text: string): SocialHandle[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: SocialHandle[] = [];
  for (const { platform, pattern, reject } of SOCIAL_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    for (const m of text.matchAll(re)) {
      // For mastodon the user is in m[2], otherwise m[1].
      const handle = platform === "mastodon" ? `${m[2]}@${m[1]}` : m[1];
      const baseHandle = platform === "mastodon" ? m[2] : m[1];
      if (reject?.test(baseHandle)) continue;
      const key = `${platform}:${handle.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ platform, handle, url: m[0] });
    }
  }
  return out;
}
