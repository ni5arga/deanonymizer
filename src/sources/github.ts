import type { Item, Profile } from "../types.js";
import { USER_AGENT, assembleProfile } from "./common.js";
import { followProfileWebsite } from "./web.js";

/**
 * GitHub ingestion via the public REST API. No auth required for low-volume
 * audit runs (60 req/hr per IP). Set GITHUB_TOKEN to lift the limit to 5000.
 *
 * Identity signal here is dense: the `/users/{name}` payload alone leaks
 * real name, employer, location, website, public email, and a linked X
 * handle. Public-events feed adds commit messages, issue/PR text, and
 * review comments from the last ~90 days.
 */

const BASE = "https://api.github.com";

interface GHUser {
  login: string;
  name?: string | null;
  company?: string | null;
  blog?: string | null;
  location?: string | null;
  email?: string | null;
  bio?: string | null;
  twitter_username?: string | null;
  created_at: string;
}

interface GHEvent {
  id: string;
  type: string;
  repo?: { name?: string };
  created_at: string;
  payload?: {
    commits?: Array<{
      sha: string;
      message: string;
      author?: { name?: string; email?: string };
    }>;
    issue?: { title?: string; body?: string; html_url?: string };
    comment?: { body?: string; html_url?: string };
    pull_request?: { title?: string; body?: string; html_url?: string };
  };
}

async function ghFetch<T>(path: string, token?: string): Promise<T | null> {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GitHub ${path} ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as T;
}

async function fetchEvents(
  user: string,
  max: number,
  token?: string,
): Promise<GHEvent[]> {
  const out: GHEvent[] = [];
  let page = 1;
  // GitHub caps the public events feed at ~300 events / 10 pages, last 90 days.
  while (out.length < max && page <= 10) {
    const events = await ghFetch<GHEvent[]>(
      `/users/${encodeURIComponent(user)}/events/public?per_page=100&page=${page}`,
      token,
    );
    if (!events || events.length === 0) break;
    out.push(...events);
    if (events.length < 100) break;
    page += 1;
  }
  return out.slice(0, max);
}

function eventToItems(e: GHEvent): Item[] {
  const t = Math.floor(new Date(e.created_at).getTime() / 1000);
  const repo = e.repo?.name ?? "";
  const items: Item[] = [];

  switch (e.type) {
    case "PushEvent": {
      for (const c of e.payload?.commits ?? []) {
        if (!c.message && !c.author?.email && !c.author?.name) continue;
        // Author name/email from commit metadata is a top-tier identity leak
        // — many users leak a real email here while keeping the GitHub UI
        // pointed at a noreply address. Prepend it to the body so the
        // analyzer sees it as part of the commit content.
        const authorLine =
          c.author?.email || c.author?.name
            ? `Commit author: ${c.author?.name ?? "(no name)"} <${c.author?.email ?? "(no email)"}>`
            : "";
        const body = [authorLine, c.message].filter(Boolean).join("\n");
        items.push({
          platform: "github",
          id: `${e.id}-${c.sha}`,
          kind: "post",
          context: `commit ${repo}`,
          body,
          createdUtc: t,
          permalink: `https://github.com/${repo}/commit/${c.sha}`,
        });
      }
      break;
    }
    case "IssuesEvent": {
      const issue = e.payload?.issue;
      if (issue && (issue.title || issue.body)) {
        items.push({
          platform: "github",
          id: `${e.id}-issue`,
          kind: "post",
          context: `issue ${repo}`,
          title: issue.title,
          body: [issue.title, issue.body].filter(Boolean).join("\n"),
          createdUtc: t,
          permalink: issue.html_url ?? `https://github.com/${repo}`,
        });
      }
      break;
    }
    case "IssueCommentEvent":
    case "PullRequestReviewCommentEvent":
    case "CommitCommentEvent": {
      const c = e.payload?.comment;
      if (c?.body) {
        items.push({
          platform: "github",
          id: `${e.id}-comment`,
          kind: "comment",
          context: `comment ${repo}`,
          body: c.body,
          createdUtc: t,
          permalink: c.html_url ?? `https://github.com/${repo}`,
        });
      }
      break;
    }
    case "PullRequestEvent": {
      const pr = e.payload?.pull_request;
      if (pr && (pr.title || pr.body)) {
        items.push({
          platform: "github",
          id: `${e.id}-pr`,
          kind: "post",
          context: `pr ${repo}`,
          title: pr.title,
          body: [pr.title, pr.body].filter(Boolean).join("\n"),
          createdUtc: t,
          permalink: pr.html_url ?? `https://github.com/${repo}`,
        });
      }
      break;
    }
  }
  return items;
}

export async function fetchGitHub(
  username: string,
  max: number,
): Promise<Profile> {
  const user = username.replace(/^@/, "").trim();
  const token = process.env.GITHUB_TOKEN;

  const profile = await ghFetch<GHUser>(
    `/users/${encodeURIComponent(user)}`,
    token,
  );

  const items: Item[] = [];

  // The profile fields themselves are the highest-signal identity surface on
  // GitHub. Fold them into a synthetic item so the analyzer treats them as
  // first-class evidence with a cite-able permalink.
  if (profile) {
    const bioBits: string[] = [];
    if (profile.name) bioBits.push(`Display name: ${profile.name}`);
    if (profile.company) bioBits.push(`Company: ${profile.company}`);
    if (profile.location) bioBits.push(`Location: ${profile.location}`);
    if (profile.blog) bioBits.push(`Website: ${profile.blog}`);
    if (profile.email) bioBits.push(`Public email: ${profile.email}`);
    if (profile.twitter_username)
      bioBits.push(`X / Twitter: @${profile.twitter_username}`);
    if (profile.bio) bioBits.push(`Bio: ${profile.bio}`);

    if (bioBits.length > 0) {
      items.push({
        platform: "github",
        id: `${user}-profile`,
        kind: "post",
        context: "profile",
        body: bioBits.join("\n"),
        createdUtc: Math.floor(new Date(profile.created_at).getTime() / 1000),
        permalink: `https://github.com/${encodeURIComponent(user)}`,
      });
    }
  }

  const events = await fetchEvents(user, max, token);
  for (const e of events) items.push(...eventToItems(e));

  // Best-effort shallow follow of the profile's declared website (one hop).
  const website = await followProfileWebsite({
    platform: "github",
    rawUrl: profile?.blog,
    id: `${user}-blog`,
    createdUtc: Math.floor(Date.now() / 1000),
  });
  if (website) items.push(website);

  return assembleProfile(
    {
      platform: "github",
      username: user,
      profileUrl: `https://github.com/${encodeURIComponent(user)}`,
    },
    items,
  );
}
