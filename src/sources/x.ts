import type { Item, Profile } from "../types.js";
import { USER_AGENT, assembleProfile, decodeEntities } from "./common.js";
import { followProfileWebsite } from "./web.js";

/**
 * X (Twitter) ingestion via the official X API v2 (https://docs.x.com/x-api).
 * Reading tweets needs a paid API plan; the bearer token comes from
 * `X_BEARER_TOKEN`. The user timeline endpoint returns at most the last 3,200
 * posts, so older history is out of reach here (use X's own archive for that).
 */

const BASE = "https://api.x.com/2";
const PAGE = 100;
const TIMELINE_CAP = 3200;

interface UrlEntity {
  url: string;
  expanded_url?: string;
}

interface XUser {
  id: string;
  username: string;
  name?: string;
  description?: string;
  location?: string;
  url?: string;
  created_at?: string;
  entities?: {
    url?: { urls?: UrlEntity[] };
    description?: { urls?: UrlEntity[] };
  };
}

interface Tweet {
  id: string;
  text: string;
  created_at?: string;
  in_reply_to_user_id?: string;
  referenced_tweets?: Array<{ type: string; id: string }>;
  entities?: { urls?: UrlEntity[] };
}

function bearerToken(): string {
  const token = process.env.X_BEARER_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "X_BEARER_TOKEN is not set. Create an app in the X developer portal (a paid plan is needed to read posts) and export its bearer token.",
    );
  }
  return token;
}

async function xGet<T>(
  path: string,
  params: Record<string, string>,
): Promise<T> {
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${bearerToken()}`,
      "User-Agent": USER_AGENT,
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    const hint =
      res.status === 401
        ? " (bearer token rejected)"
        : res.status === 403
          ? " (your API plan does not allow this endpoint)"
          : res.status === 429
            ? " (rate limited; wait and retry, or lower --max)"
            : "";
    throw new Error(
      `X API ${path} ${res.status}${hint} ${detail.slice(0, 300)}`,
    );
  }
  return (await res.json()) as T;
}

/** Replace t.co short links with the destination X recorded for them. */
function expandUrls(text: string, urls: UrlEntity[] | undefined): string {
  let out = text;
  for (const u of urls ?? []) {
    if (u.expanded_url) out = out.split(u.url).join(u.expanded_url);
  }
  return decodeEntities(out);
}

function toEpoch(iso: string | undefined): number {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

export async function fetchX(username: string, max: number): Promise<Profile> {
  const handle = username.trim().replace(/^@/, "");

  const { data: user } = await xGet<{ data?: XUser }>(
    `/users/by/username/${encodeURIComponent(handle)}`,
    { "user.fields": "description,location,url,created_at,entities,name" },
  );
  if (!user) throw new Error(`X user @${handle} not found`);

  const profileUrl = `https://x.com/${user.username}`;
  const items: Item[] = [];

  const website = user.entities?.url?.urls?.[0]?.expanded_url ?? user.url;
  const bioBits: string[] = [];
  if (user.name) bioBits.push(`Display name: ${user.name}`);
  if (user.location) bioBits.push(`Location: ${user.location}`);
  if (website) bioBits.push(`Website: ${website}`);
  if (user.description)
    bioBits.push(
      `Bio: ${expandUrls(user.description, user.entities?.description?.urls)}`,
    );
  const joinedUtc = toEpoch(user.created_at);
  if (bioBits.length > 0) {
    items.push({
      platform: "x",
      id: `profile-${user.id}`,
      kind: "post",
      context: "X profile",
      body: bioBits.join("\n"),
      createdUtc: joinedUtc,
      permalink: profileUrl,
    });
  }

  // Retweets are other people's words, so they are left out.
  const limit = Math.min(max, TIMELINE_CAP);
  let paginationToken: string | undefined;
  while (items.length < limit) {
    const params: Record<string, string> = {
      max_results: String(PAGE),
      exclude: "retweets",
      "tweet.fields":
        "created_at,entities,in_reply_to_user_id,referenced_tweets",
    };
    if (paginationToken) params.pagination_token = paginationToken;
    const page = await xGet<{
      data?: Tweet[];
      meta?: { next_token?: string };
    }>(`/users/${user.id}/tweets`, params);

    for (const t of page.data ?? []) {
      const isReply = Boolean(t.in_reply_to_user_id);
      const isQuote = t.referenced_tweets?.some((r) => r.type === "quoted");
      items.push({
        platform: "x",
        id: t.id,
        kind: isReply ? "comment" : "post",
        context: isReply ? "X reply" : isQuote ? "X quote post" : "X post",
        body: expandUrls(t.text, t.entities?.urls),
        createdUtc: toEpoch(t.created_at),
        permalink: `https://x.com/${user.username}/status/${t.id}`,
      });
    }
    paginationToken = page.meta?.next_token;
    if (!paginationToken || !page.data?.length) break;
  }

  const site = await followProfileWebsite({
    platform: "x",
    rawUrl: website,
    id: `site-${user.id}`,
    createdUtc: joinedUtc,
  });
  if (site) items.push(site);

  return assembleProfile(
    { platform: "x", username: user.username, profileUrl },
    items.slice(0, limit + 2),
  );
}
