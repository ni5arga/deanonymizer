import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deobfuscateEmails,
  extractEmails,
  extractSocialHandles,
} from "./extract.js";

describe("deobfuscateEmails", () => {
  it("leaves a normal email untouched", () => {
    assert.equal(deobfuscateEmails("alice@example.com"), "alice@example.com");
  });

  it("replaces [at] with @", () => {
    assert.equal(
      deobfuscateEmails("alice [at] example.com"),
      "alice@example.com",
    );
  });

  it("replaces (at) with @", () => {
    assert.equal(
      deobfuscateEmails("alice (at) example.com"),
      "alice@example.com",
    );
  });

  it("replaces [dot] with .", () => {
    assert.equal(
      deobfuscateEmails("alice@example [dot] com"),
      "alice@example.com",
    );
  });

  it("replaces (dot) with .", () => {
    assert.equal(
      deobfuscateEmails("alice@example (dot) com"),
      "alice@example.com",
    );
  });

  it("handles combined [at] and [dot] obfuscation", () => {
    assert.equal(
      deobfuscateEmails("alice [at] example [dot] com"),
      "alice@example.com",
    );
  });

  it("handles combined (at) and (dot) obfuscation", () => {
    assert.equal(
      deobfuscateEmails("alice (at) example (dot) com"),
      "alice@example.com",
    );
  });
});
describe("extractEmails", () => {
  it("returns empty array for empty string", () => {
    assert.deepEqual(extractEmails(""), []);
  });

  it("extracts a plain email", () => {
    assert.deepEqual(extractEmails("contact me at alice@protonmail.com please"), [
      "alice@protonmail.com",
    ]);
  });

  it("returns emails lowercase", () => {
    assert.deepEqual(extractEmails("Alice@ProtonMail.COM"), [
      "alice@protonmail.com",
    ]);
  });

  it("deduplicates the same email appearing twice", () => {
    assert.deepEqual(
      extractEmails("bob@fastmail.com and again bob@fastmail.com"),
      ["bob@fastmail.com"],
    );
  });

  it("extracts multiple distinct emails", () => {
    const result = extractEmails("a@foo.com and b@bar.org");
    assert.deepEqual(result.sort(), ["a@foo.com", "b@bar.org"]);
  });

  it("extracts obfuscated [at] emails", () => {
    assert.deepEqual(
      extractEmails("reach me at alice [at] protonmail.com"),
      ["alice@protonmail.com"],
    );
  });

  it("filters out @users.noreply.github.com addresses", () => {
    assert.deepEqual(
      extractEmails("12345+user@users.noreply.github.com"),
      [],
    );
  });

  it("filters out @example.com addresses", () => {
    assert.deepEqual(extractEmails("test@example.com"), []);
  });

  it("filters out @email.com addresses", () => {
    assert.deepEqual(extractEmails("test@email.com"), []);
  });

  it("filters out addresses with pure-numeric domains", () => {
    // e.g. version strings like 1.2.3 can accidentally match the email regex
    assert.deepEqual(extractEmails("version@1.2.3"), []);
  });
});
describe("extractSocialHandles", () => {
  it("returns empty array for empty string", () => {
    assert.deepEqual(extractSocialHandles(""), []);
  });

  it("extracts a LinkedIn profile URL", () => {
    const result = extractSocialHandles(
      "see https://www.linkedin.com/in/john-doe",
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].platform, "linkedin");
    assert.equal(result[0].handle, "john-doe");
  });

  it("extracts an X / Twitter profile URL", () => {
    const result = extractSocialHandles("follow me at https://x.com/janedoe");
    assert.equal(result.length, 1);
    assert.equal(result[0].platform, "x");
    assert.equal(result[0].handle, "janedoe");
  });

  it("rejects X utility paths like /home", () => {
    const result = extractSocialHandles("https://twitter.com/home");
    assert.equal(result.length, 0);
  });

  it("extracts a GitHub profile URL", () => {
    const result = extractSocialHandles("code at https://github.com/octocat");
    assert.equal(result.length, 1);
    assert.equal(result[0].platform, "github");
    assert.equal(result[0].handle, "octocat");
  });

  it("rejects GitHub utility paths like /issues", () => {
    const result = extractSocialHandles("https://github.com/issues");
    assert.equal(result.length, 0);
  });

  it("extracts a Reddit user URL", () => {
    const result = extractSocialHandles(
      "my old account https://www.reddit.com/u/throwaway99",
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].platform, "reddit");
    assert.equal(result[0].handle, "throwaway99");
  });

  it("extracts a Hacker News user URL", () => {
    const result = extractSocialHandles(
      "https://news.ycombinator.com/user?id=pg",
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].platform, "hackernews");
    assert.equal(result[0].handle, "pg");
  });

  it("extracts a Bluesky profile URL", () => {
    const result = extractSocialHandles(
      "find me on https://bsky.app/profile/alice.bsky.social",
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].platform, "bluesky");
    assert.equal(result[0].handle, "alice.bsky.social");
  });

  it("extracts a Stack Overflow user URL", () => {
    const result = extractSocialHandles(
      "my SO profile https://stackoverflow.com/users/1234567",
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].platform, "stackoverflow");
    assert.equal(result[0].handle, "1234567");
  });

  it("extracts a Telegram URL and rejects /joinchat paths", () => {
    const valid = extractSocialHandles("https://t.me/myhandle");
    assert.equal(valid.length, 1);
    assert.equal(valid[0].platform, "telegram");

    const invalid = extractSocialHandles("https://t.me/joinchat");
    assert.equal(invalid.length, 0);
  });

  it("deduplicates the same handle appearing twice", () => {
    const text =
      "https://github.com/octocat and again https://github.com/octocat";
    const result = extractSocialHandles(text);
    assert.equal(result.length, 1);
  });

  it("extracts multiple platforms from one block of text", () => {
    const text =
      "github: https://github.com/alice reddit: https://reddit.com/u/alice2";
    const result = extractSocialHandles(text);
    assert.equal(result.length, 2);
    const platforms = result.map((r) => r.platform).sort();
    assert.deepEqual(platforms, ["github", "reddit"]);
  });
});
