/**
 * Link-follower for external sites declared in platform profile fields
 * (e.g. GitHub `blog`, Stack Overflow `website_url`). Pulls the root page,
 * then up to 5 same-origin sub-paths that look identity-relevant
 * (about, cv, resume, contact, bio, me, portfolio, etc.), strips each to
 * text, and concatenates.
 *
 * Hard limits: text/* only, 10s per request, 2 MB body cap, errors
 * swallowed. JS-rendered SPAs won't work without a headless browser —
 * out of scope.
 */

import type { Item, Platform } from "../types.js";
import { MAX_SITE_BODY, decodeEntities } from "./common.js";

const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 10_000;
const MAX_EXTRA_PAGES = 5;
const MAX_TOTAL_TEXT = MAX_SITE_BODY;
const UA = "deanonymizer/0.1 (privacy self-audit; link-follower)";

const IDENTITY_PATH_RE =
  /\/(about|cv|resume|bio|contact|me|home|portfolio|profile|info)(\.html?|\/?$)/i;

export function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/.*)?$/i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return null;
}

function extractText(html: string): string {
  // Pull mailto: and http(s) hrefs BEFORE tag-stripping kills them. This is
  // the single biggest leak channel on personal sites — the email is in the
  // <a href="mailto:..."> attribute, not the visible link text.
  const linkRe = /\bhref\s*=\s*["']([^"']+)["']/gi;
  const links = new Set<string>();
  for (const m of html.matchAll(linkRe)) {
    const v = m[1].trim();
    if (/^mailto:/i.test(v) || /^https?:\/\//i.test(v)) {
      links.add(v);
    }
  }

  const withoutTags = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>(?!\n)/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  const stripped = decodeEntities(withoutTags)
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (links.size === 0) return stripped;
  return `${stripped}\n\nLinks found on page:\n${[...links].join("\n")}`;
}

async function fetchRaw(
  url: string,
): Promise<{ html: string; text: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,text/plain;q=0.9,*/*;q=0.1",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!/text\/(html|plain)/i.test(ct)) return null;

    const reader = res.body?.getReader();
    let html: string;
    if (!reader) {
      html = await res.text();
    } else {
      let received = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          received += value.byteLength;
          chunks.push(value);
          if (received >= MAX_BYTES) {
            await reader.cancel().catch(() => undefined);
            break;
          }
        }
      }
      const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      html = buf.toString("utf8");
    }
    return { html, text: extractText(html) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function sameOriginLinks(html: string, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const hrefRe = /<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["']/gi;
  const out = new Set<string>();
  for (const m of html.matchAll(hrefRe)) {
    try {
      const u = new URL(m[1], baseUrl);
      if (u.origin !== base.origin) continue;
      if (u.pathname === base.pathname) continue;
      if (
        /\.(png|jpe?g|gif|webp|svg|ico|css|js|pdf|zip|mp4|mp3)$/i.test(
          u.pathname,
        )
      )
        continue;
      u.hash = "";
      out.add(u.toString());
    } catch {
      // ignore unparseable hrefs
    }
  }
  return [...out];
}

/**
 * Fetch the page at `url`, then crawl up to MAX_EXTRA_PAGES same-origin
 * sub-paths, prioritizing identity-looking routes (/about, /cv, /resume,
 * /contact, …). Returns the concatenated text, or null if nothing useful
 * was reachable.
 */
export async function fetchAndExtractSite(url: string): Promise<string | null> {
  const root = await fetchRaw(url);
  if (!root) return null;

  const links = sameOriginLinks(root.html, url);
  // Prioritize identity-looking paths, then preserve the page's own order.
  links.sort((a, b) => {
    const aScore = IDENTITY_PATH_RE.test(a) ? 0 : 1;
    const bScore = IDENTITY_PATH_RE.test(b) ? 0 : 1;
    return aScore - bScore;
  });

  const parts: string[] = [`=== ${url} ===\n${root.text}`];
  let total = root.text.length;

  for (const sub of links.slice(0, MAX_EXTRA_PAGES)) {
    if (total >= MAX_TOTAL_TEXT) break;
    const r = await fetchRaw(sub);
    if (!r?.text) continue;
    const slice = r.text.slice(0, Math.max(0, MAX_TOTAL_TEXT - total));
    if (!slice) break;
    parts.push(`=== ${sub} ===\n${slice}`);
    total += slice.length;
  }

  return parts.join("\n\n");
}

/**
 * Shared one-hop follow of a platform profile's declared website. GitHub
 * (`blog`) and Stack Overflow (`website_url`) both expose a free-text URL that
 * is the single most useful identity signal beyond their APIs — personal
 * sites, resumes, and portfolios usually expose the real name. Returns a
 * ready-to-push Item, or null when the field is empty, unparseable, or yields
 * too little text to be worth including.
 */
export async function followProfileWebsite(opts: {
  platform: Platform;
  rawUrl: string | null | undefined;
  id: string;
  createdUtc: number;
}): Promise<Item | null> {
  if (!opts.rawUrl) return null;
  const url = normalizeUrl(opts.rawUrl);
  if (!url) return null;

  const text = await fetchAndExtractSite(url);
  if (!text || text.length <= 80) return null;

  return {
    platform: opts.platform,
    id: opts.id,
    kind: "post",
    context: `external site + sub-pages (linked from ${opts.platform} profile)`,
    body: text.slice(0, MAX_SITE_BODY),
    createdUtc: opts.createdUtc,
    permalink: url,
  };
}
