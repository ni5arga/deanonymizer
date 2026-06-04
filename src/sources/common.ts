import type { Item, Platform, Profile } from "../types.js";

/** Sent on every outbound source request so operators can identify the tool. */
export const USER_AGENT = "deanonymizer/0.1 (privacy self-audit)";

/** Max characters of fetched external-site text folded into a single Item. */
export const MAX_SITE_BODY = 24_000;

/**
 * Decode the small set of HTML entities our source bodies actually contain.
 * `&amp;` is decoded last so an encoded entity like `&amp;lt;` resolves to the
 * literal `&lt;` rather than being double-decoded into `<`.
 */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x2F;/g, "/")
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

/**
 * Sort items newest-first and wrap them in a Profile, deriving the inclusive
 * epoch-seconds span from the sorted ends. Every source ends with this exact
 * shape, so it lives here.
 */
export function assembleProfile(
  base: Pick<Profile, "platform" | "username" | "profileUrl">,
  items: Item[],
): Profile {
  items.sort((a, b) => b.createdUtc - a.createdUtc);
  return {
    ...base,
    items,
    firstUtc: items.length ? items[items.length - 1].createdUtc : undefined,
    lastUtc: items.length ? items[0].createdUtc : undefined,
  };
}
