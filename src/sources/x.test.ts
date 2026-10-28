import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fetchX } from "./x.js";

type Route = (url: URL) => { status: number; body: unknown };

const realFetch = globalThis.fetch;
const realToken = process.env.X_BEARER_TOKEN;

/** Answer X API calls from `route`; any other host (the website follow) 404s. */
function fakeFetch(route: Route): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const { status, body } =
      url.host === "api.x.com" ? route(url) : { status: 404, body: "" };
    return new Response(
      typeof body === "string" ? body : JSON.stringify(body),
      {
        status,
      },
    );
  }) as typeof fetch;
}

const USER = {
  id: "42",
  username: "jane",
  name: "Jane Doe",
  location: "Lisbon",
  description: "Builder. More at https://t.co/abc",
  created_at: "2015-06-12T00:00:00.000Z",
  entities: {
    description: {
      urls: [{ url: "https://t.co/abc", expanded_url: "https://jane.example" }],
    },
  },
};

describe("fetchX", () => {
  beforeEach(() => {
    process.env.X_BEARER_TOKEN = "test-token";
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (realToken === undefined) delete process.env.X_BEARER_TOKEN;
    else process.env.X_BEARER_TOKEN = realToken;
  });

  it("maps the profile and posts, expands t.co links and pages", async () => {
    fakeFetch((url) => {
      if (url.pathname === "/2/users/by/username/jane")
        return { status: 200, body: { data: USER } };
      if (url.pathname === "/2/users/42/tweets") {
        assert.equal(url.searchParams.get("exclude"), "retweets");
        if (!url.searchParams.get("pagination_token"))
          return {
            status: 200,
            body: {
              data: [
                {
                  id: "2",
                  text: "Shipped it https://t.co/x1",
                  created_at: "2026-01-02T00:00:00.000Z",
                  entities: {
                    urls: [
                      {
                        url: "https://t.co/x1",
                        expanded_url: "https://ship.example",
                      },
                    ],
                  },
                },
              ],
              meta: { next_token: "p2" },
            },
          };
        return {
          status: 200,
          body: {
            data: [
              {
                id: "1",
                text: "@bob agreed",
                created_at: "2025-01-01T00:00:00.000Z",
                in_reply_to_user_id: "7",
              },
            ],
            meta: {},
          },
        };
      }
      return { status: 404, body: {} };
    });

    const profile = await fetchX("@jane", 300);

    assert.equal(profile.platform, "x");
    assert.equal(profile.profileUrl, "https://x.com/jane");
    const bio = profile.items.find((i) => i.context === "X profile");
    assert.ok(bio?.body.includes("Display name: Jane Doe"));
    assert.ok(bio?.body.includes("https://jane.example"));

    const post = profile.items.find((i) => i.id === "2");
    assert.equal(post?.body, "Shipped it https://ship.example");
    assert.equal(post?.permalink, "https://x.com/jane/status/2");

    const reply = profile.items.find((i) => i.id === "1");
    assert.equal(reply?.kind, "comment");
    assert.equal(reply?.context, "X reply");
  });

  it("fails clearly without a bearer token", async () => {
    delete process.env.X_BEARER_TOKEN;
    await assert.rejects(fetchX("jane", 10), /X_BEARER_TOKEN is not set/);
  });

  it("explains a plan that cannot read posts", async () => {
    fakeFetch(() => ({ status: 403, body: { title: "Forbidden" } }));
    await assert.rejects(
      fetchX("jane", 10),
      /403 \(your API plan does not allow/,
    );
  });
});
