import type { Item, Profile } from "../types.js";

/**
 * Reddit ingestion via the Arctic Shift API
 * (https://arctic-shift.photon-reddit.com). Arctic Shift is a community archive
 * that is more reliable and complete than the live Reddit API for historical
 * author history, and needs no auth. We paginate backwards in time.
 */

const BASE = "https://arctic-shift.photon-reddit.com/api";
const PAGE = 100;

interface RawComment {
  id: string;
  body: string;
  subreddit: string;
  created_utc: number;
  permalink: string;
  link_title?: string;
}

interface RawPost {
  id: string;
  title: string;
  selftext?: string;
  subreddit: string;
  created_utc: number;
  permalink: string;
  url?: string;
}

async function fetchPage<T>(
  endpoint: string,
  author: string,
  before?: number,
): Promise<T[]> {
  const url = new URL(`${BASE}/${endpoint}/search`);
  url.searchParams.set("author", author);
  url.searchParams.set("limit", String(PAGE));
  url.searchParams.set("sort", "desc");
  if (before) url.searchParams.set("before", String(before));

  const res = await fetch(url, {
    headers: { "User-Agent": "deanonymizer/0.1 (privacy self-audit)" },
  });
  if (res.status === 404) return [];
  if (!res.ok) {
    throw new Error(
      `Arctic Shift ${endpoint} ${res.status}: ${await res.text()}`,
    );
  }
  const json = (await res.json()) as { data?: T[] };
  return json.data ?? [];
}

async function fetchAll<T extends { created_utc: number }>(
  endpoint: string,
  author: string,
  max: number,
): Promise<T[]> {
  const out: T[] = [];
  let before: number | undefined;
  while (out.length < max) {
    const page = await fetchPage<T>(endpoint, author, before);
    if (page.length === 0) break;
    out.push(...page);
    const oldest = page[page.length - 1].created_utc;
    if (before !== undefined && oldest >= before) break; // no progress; stop
    before = oldest;
    if (page.length < PAGE) break; // last page
  }
  return out.slice(0, max);
}

export async function fetchReddit(
  username: string,
  max: number,
): Promise<Profile> {
  const user = username.replace(/^\/?u\//i, "").trim();

  const [comments, posts] = await Promise.all([
    fetchAll<RawComment>("comments", user, max),
    fetchAll<RawPost>("posts", user, Math.ceil(max / 4)),
  ]);

  const items: Item[] = [];

  for (const c of comments) {
    if (!c.body || c.body === "[deleted]" || c.body === "[removed]") continue;
    items.push({
      platform: "reddit",
      id: c.id,
      kind: "comment",
      context: `r/${c.subreddit}`,
      title: c.link_title,
      body: c.body,
      createdUtc: c.created_utc,
      permalink: `https://reddit.com${c.permalink}`,
    });
  }

  for (const p of posts) {
    const body = [p.title, p.selftext, p.url].filter(Boolean).join("\n");
    if (!body.trim()) continue;
    items.push({
      platform: "reddit",
      id: p.id,
      kind: "post",
      context: `r/${p.subreddit}`,
      title: p.title,
      body,
      createdUtc: p.created_utc,
      permalink: `https://reddit.com${p.permalink}`,
    });
  }

  items.sort((a, b) => b.createdUtc - a.createdUtc);

  return {
    platform: "reddit",
    username: user,
    profileUrl: `https://www.reddit.com/user/${encodeURIComponent(user)}`,
    items,
    firstUtc: items.length ? items[items.length - 1].createdUtc : undefined,
    lastUtc: items.length ? items[0].createdUtc : undefined,
  };
}
