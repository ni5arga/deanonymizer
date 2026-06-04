import type { Item, Profile } from "../types.js";

/**
 * Hacker News (YC) ingestion via the Algolia HN Search API
 * (https://hn.algolia.com/api). No auth required. We page by created_at to walk
 * the full author history.
 */

const BASE = "https://hn.algolia.com/api/v1";
const PAGE = 100;

interface Hit {
  objectID: string;
  author: string;
  comment_text?: string;
  title?: string;
  story_title?: string;
  story_url?: string;
  url?: string;
  created_at_i: number;
}

function decode(html: string): string {
  return html
    .replace(/<p>/g, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x2F;/g, "/")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .trim();
}

async function fetchTag(
  user: string,
  tag: "comment" | "story",
  max: number,
): Promise<Hit[]> {
  const out: Hit[] = [];
  let before: number | undefined;
  while (out.length < max) {
    const url = new URL(`${BASE}/search_by_date`);
    url.searchParams.set("tags", `${tag},author_${user}`);
    url.searchParams.set("hitsPerPage", String(PAGE));
    if (before)
      url.searchParams.set("numericFilters", `created_at_i<${before}`);

    const res = await fetch(url, {
      headers: { "User-Agent": "deanonymizer/0.1 (privacy self-audit)" },
    });
    if (!res.ok) throw new Error(`HN Algolia ${tag} ${res.status}`);
    const json = (await res.json()) as { hits?: Hit[] };
    const hits = json.hits ?? [];
    if (hits.length === 0) break;
    out.push(...hits);
    before = hits[hits.length - 1].created_at_i;
    if (hits.length < PAGE) break;
  }
  return out.slice(0, max);
}

export async function fetchHN(username: string, max: number): Promise<Profile> {
  const user = username.trim();

  const [comments, stories] = await Promise.all([
    fetchTag(user, "comment", max),
    fetchTag(user, "story", Math.ceil(max / 4)),
  ]);

  const items: Item[] = [];

  for (const c of comments) {
    if (!c.comment_text) continue;
    items.push({
      platform: "hn",
      id: c.objectID,
      kind: "comment",
      context: c.story_title ? `re: ${c.story_title}` : "HN thread",
      body: decode(c.comment_text),
      createdUtc: c.created_at_i,
      permalink: `https://news.ycombinator.com/item?id=${c.objectID}`,
    });
  }

  for (const s of stories) {
    const body = [s.title, s.url].filter(Boolean).join("\n");
    if (!body.trim()) continue;
    items.push({
      platform: "hn",
      id: s.objectID,
      kind: "post",
      context: "HN submission",
      title: s.title,
      body,
      createdUtc: s.created_at_i,
      permalink: `https://news.ycombinator.com/item?id=${s.objectID}`,
    });
  }

  items.sort((a, b) => b.createdUtc - a.createdUtc);

  return {
    platform: "hn",
    username: user,
    profileUrl: `https://news.ycombinator.com/user?id=${encodeURIComponent(user)}`,
    items,
    firstUtc: items.length ? items[items.length - 1].createdUtc : undefined,
    lastUtc: items.length ? items[0].createdUtc : undefined,
  };
}
