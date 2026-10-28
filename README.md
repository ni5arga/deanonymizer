# deanonymizer

people leak a surprising amount of themselves online, one harmless crumb at a time. a timezone here. a "back when I worked at $COMPANY" there. the same username on four different sites. none of it looks like much on its own. but stack the crumbs up and cross-reference them, and suddenly you can point at a person.

deanonymizer is a command-line tool that measures how big that pile of crumbs is for a given handle. you point it at public sources — Reddit, Hacker News, GitHub, Stack Overflow, and now whatever website those profiles link to — and it pulls the weak signals together, scores how confidently they could be linked back to a real identity, and produces a report that says, in effect, *"here's what you're accidentally telling the internet, and here's where you said it."*

it's a defensive tool. the idea is to run it on yourself (or someone who's asked you to), see the exposed parts, and fix them before someone less friendly runs the same exercise. it is not an identity oracle, and it'll tell you so — repeatedly, in the limitations section — because I'd rather you trust it than be impressed by it.

I built this because I got curious about the "crumbs add up" idea and wanted to actually measure it instead of just nodding along. turns out the answer is "yeah, kind of a lot."

## research basis

the inference setting it leans on is laid out here:

- [arXiv:2602.16800](https://arxiv.org/abs/2602.16800)

the one-line version of the premise: a disclosure that looks non-identifying on its own can become identifying once you fuse it across posts and across platforms. low entropy alone, high entropy together. that's the whole idea.

## what it actually produces

formally: you give it a set of subject handles `H` and the public artifacts `D` it can find for them, and it gives you back a risk report `R` containing:

- identity-relevant features it pulled out of the text
- linkage claims, each one backed by actual evidence (not "trust me")
- confidence labels that are honest about how sure it is
- a prioritized list of things to go fix

## threat model

worth being clear about who the imagined attacker is, because it shapes everything:

- **what they can see:** publicly available text and metadata. that's it.
- **what they cannot do:** no private APIs, no logging in, no credentialed access, no secret datasets, no scraping behind a paywall. if a rando on the internet can't read it, neither can this tool.
- **what they're doing with it:** probabilistic entity linkage — composing a bunch of small features and asking "do these all point at the same person?"
- **what you're trying to win:** shrink your attributable identity surface. give the passive observer less to work with.

so it's a passive adversary, working only from public traces, doing statistics — no breaking into anything. the boundary exists because that's the realistic threat for most people, and it's the uncomfortable one: you don't need to be breached to be deanonymized, you just need to have posted.

## how a run actually goes

mental model first, bullets second. when you kick off an audit, here's the journey a username takes:

**1. it goes and collects everything public it can find.**

- Reddit posts/comments come from the [Arctic Shift API](https://arctic-shift.photon-reddit.com)
- Hacker News stuff comes from the [HN Algolia Search API](https://hn.algolia.com/api)
- GitHub gives up profile fields + public events (commits, issues, PRs, review comments) via the [GitHub REST API](https://docs.github.com/en/rest). commit author name and email tucked inside `PushEvent` payloads get folded in inline — those are a juicy source. dropping a `GITHUB_TOKEN` in the env raises your rate limit.
- Stack Overflow hands over answers, questions, comments, and profile fields via the [Stack Exchange API v2.3](https://api.stackexchange.com)
- X (Twitter) gives up the profile (display name, location, bio, website) and up to the last 3,200 posts and replies via the [X API v2](https://docs.x.com/x-api). retweets are skipped, since they're someone else's words, and `t.co` short links are expanded to where they actually point. reading posts needs a paid X API plan: put the app's bearer token in `X_BEARER_TOKEN`. for history older than 3,200 posts, X's own archive download is the only way in.
- and the interesting one: if a GitHub or Stack Overflow profile links out to a personal website, a shallow link-follower goes and reads it. it grabs the root page, then up to 5 same-origin sub-pages, prioritizing the ones that look identity-shaped — `/about`, `/cv`, `/resume`, `/contact`, `/bio`, `/me`, `/portfolio`, and so on. it preserves `mailto:` and `http(s)://` href values *before* stripping the HTML, so a contact email hiding behind a link survives the pass. this matters more than it sounds: people put their email in an `<a href>` constantly.

**2. it normalizes the mess.**

every source returns its own weird record shape, so everything gets mapped into one unified item schema, with timestamps and text normalized so the later inference is working from bounded, consistent context instead of five different JSON dialects.

**3. it pulls out features — two passes, running side by side.**

- the **LLM pass** reads the corpus and looks for the soft stuff: location, affiliations, daily-routine timing, self-disclosed demographics, cross-platform handles, external URLs, and stylometric tells. crucially, every claim it makes gets *bound to evidence* — a quote and a permalink — so nothing floats free. if it says you live somewhere, it has to show you where you said it.
- the **deterministic regex pass** runs in parallel and ignores the model entirely. it goes after the hard, unambiguous leaks: emails (and it un-mangles the `[at]`/`[dot]` obfuscation people use), plus cross-platform social handles for LinkedIn, Twitter/X, GitHub, YouTube, Instagram, Bluesky, Reddit, Hacker News, Telegram, GitLab, Stack Overflow, and Mastodon, pulled out of URL patterns in the text. it filters out false positives like `twitter.com/home`, and it excludes the account you're actually auditing so it doesn't "discover" the handle you just typed in.

**4. it synthesizes the risk.**

- findings get confidence-calibrated into low / medium / high
- there's an explicit "this is the exact user" section plus the set of public proof URLs
- the **direct-identifier block** (emails + discovered handles) is rendered *before* the LLM findings on purpose — concrete leaks should always show up front, no matter how the model chose to phrase its own summary. hard facts don't get buried under prose.
- each finding comes with its own remediation suggestion, so the report isn't just "here's the bad news," it's "here's the bad news and what to do about it."

## what you get out the other end

- a human-readable report with ranked findings + reasoning, grouped high → medium → low
- that dedicated `direct identifiers extracted` block surfacing the emails and cross-platform handles the regex pass caught
- JSON output for when you want to track this over time or feed it into something else — `AuditResult.directIdentifiers` exposes the raw email + social handle hits right alongside the model's findings
- optional strict mode that *fails the run* if there's no external proof URL beyond the audited platform's own profile pages (more on that below)

## installation

it's a node project, so:

```bash
npm install
```

that's it for the tool itself. now it needs a model to think with.

## picking an LLM backend

the analysis stage needs a model, and there are three interchangeable backends. it auto-picks one based on your environment, or you can choose explicitly with `--provider`. here's the rundown of who each one is for.

**Anthropic (native — the default if this is the only key you've set)**

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# default model is the fast claude-haiku-4-5
# optional: export ANTHROPIC_MODEL=claude-sonnet-4-6  # slower, higher quality
```

this is the path I reach for. it gets native prompt caching, so repeat runs are cheaper and faster. defaults to the fast `claude-haiku-4-5`; bump it to `claude-sonnet-4-6` when you want the model to think harder and don't mind waiting a bit.

**any OpenAI-compatible endpoint** — OpenAI, Google Gemini, Ollama, Groq, Together, basically anyone who speaks Chat Completions. just point `OPENAI_BASE_URL` at their surface:

```bash
# OpenAI
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=gpt-4o-mini

# Google Gemini (via its OpenAI-compatible endpoint)
export OPENAI_API_KEY=...your-gemini-key...
export OPENAI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
export OPENAI_MODEL=gemini-2.0-flash

# Ollama (local, no key required)
export OPENAI_BASE_URL=http://localhost:11434/v1
export OPENAI_MODEL=llama3
```

this is the "use whatever you've already got" path. switching providers is easy; pick based on cost, speed, or whichever model you trust. the Ollama variant is useful if you'd rather not send someone's data off your machine at all — it runs fully local, no key, slower but yours.

**Claude Code CLI (no API key at all)** — this one routes the analysis through your existing [Claude Code](https://claude.com/claude-code) session by shelling out to `claude -p`. so if you're already logged into Claude Code, you don't need an `ANTHROPIC_API_KEY` floating around in your env. you have to ask for it explicitly:

```bash
npm run audit -- my_reddit_handle --provider claude-code
# optional: pin the model or point at a non-default CLI binary
export CLAUDE_CODE_MODEL=claude-sonnet-4-6
export CLAUDE_CODE_BIN=/path/to/claude
```

the tradeoffs, stated plainly: no prompt caching, no `max_tokens` control, and slower per-call startup because the CLI has to cold-start every time. that's why it's opt-in and never auto-detected — it'd make a poor default, but it's a useful escape hatch when you don't want to manage a key. it also has no `response_format: json_object` equivalent, so the built-in JSON-repair fallback cleans up after it.

**how it decides, when you don't tell it:**

`--provider` flag → `LLM_PROVIDER` env → auto-detect (`OPENAI_*` / `--base-url` present → openai; `ANTHROPIC_API_KEY` present → anthropic). `claude-code` is *never* auto-detected — you have to ask via `--provider claude-code` or `LLM_PROVIDER=claude-code`. if you've got an Anthropic-only setup from before, nothing changes, it all still works. native Anthropic prompt caching stays on for the Anthropic path; the OpenAI path requests `response_format: json_object` where the endpoint supports it and falls back to JSON-repair for the ones that politely ignore it.

## usage

```bash
# Reddit only
npm run audit -- my_reddit_handle

# Reddit + Hacker News
npm run audit -- my_reddit_handle --hn my_hn_handle

# Hacker News only
npm run audit -- --hn my_hn_handle

# GitHub only (also follows the linked website + sub-pages)
npm run audit -- --github my_gh_handle

# Stack Overflow only (accepts numeric user_id or profile URL)
npm run audit -- --so 1234567

# X only (needs X_BEARER_TOKEN; paid X API plan)
npm run audit -- --x my_x_handle

# all four platforms at once — cross-platform handle correlation is the
# single strongest signal the analyzer can flag
npm run audit -- my_reddit_handle --hn my_hn_handle --github my_gh_handle --so 1234567

# audit through the Claude Code CLI (no API key needed)
npm run audit -- my_reddit_handle --provider claude-code

# JSON output
npm run audit -- my_reddit_handle --json -o report.json

# strict proof validation
npm run audit -- my_reddit_handle --require-external-proof

# faster wall-clock analysis (parallel chunk workers)
npm run audit -- my_reddit_handle --concurrency 3

# run against a local Ollama model
npm run audit -- my_reddit_handle --base-url http://localhost:11434/v1 --model llama3

# force a specific provider/model for one run
npm run audit -- my_reddit_handle --provider openai --model gpt-4o-mini
```

the all-four-platforms run is the one that tends to surprise people the most. reusing the same username everywhere is the easiest thread to pull on.

## CLI options

| flag | default | what it does |
|------|---------|--------------|
| [reddit-username] / --reddit | none | Reddit user to audit (accepts u/name) |
| --hn <username> | none | Hacker News user to audit |
| --github <username> | none | GitHub user to audit (uses public REST API; set `GITHUB_TOKEN` to raise rate limit) |
| --so <id_or_url> | none | Stack Overflow user to audit (numeric user_id or profile URL) |
| --x <username> | none | X (Twitter) user to audit (uses the X API v2; needs `X_BEARER_TOKEN`, paid plan) |
| -n, --max <n> | 300 | max items fetched per platform |
| --max-chars <n> | 120000 | max analysis transcript budget |
| --concurrency <n> | all (≤8) | number of chunk workers processed in parallel |
| --provider <name> | auto-detect | LLM provider: `anthropic`, `openai`, or `claude-code` |
| --base-url <url> | none | OpenAI-compatible base URL (Gemini/Ollama/Groq/…); implies `openai` |
| --model <name> | provider default | override the model name |
| --json | false | emit JSON instead of the text report |
| --require-external-proof | false | fail if no proof URL exists beyond audited profile pages |
| -o, --out <file> | stdout | write output to a file |
| --i-am-authorized | false | skip the interactive authorization prompt for scripted runs |

(yes, there's an authorization prompt by default. run this on yourself, or on someone who's asked you to.)

## getting consistent results

LLMs are a little moody, so if you want runs you can actually compare:

- crank `-n` up to pull in more history
- crank `--max-chars` up so less of the transcript gets truncated away
- pin the model (`ANTHROPIC_MODEL` / `OPENAI_MODEL` / `CLAUDE_CODE_MODEL` / `--model`) so you're not silently drifting between backends
- save the JSON outputs so you can diff today's exposure against last month's and watch it (hopefully) shrink

## build

```bash
npm run build
```

## continuous integration

there's a GitHub Actions workflow at `.github/workflows/ci.yml` that runs `npm run lint`, `npm run format:check`, `tsc --noEmit`, `npm test`, and `npm run build` on every push and PR against `main`, across a Node 20 / 22 / 24 matrix. so if it's green, it compiles, lints, and passes tests on three node versions.

## limitations (please read this part)

this is the section I care about most, so I'll be blunt.

this is a probability machine, not a crystal ball. *please do not take its output as proof of identity.* it's built to surface risk, not to convict anyone.

- **findings are probabilistic.** a "high confidence" finding means the evidence stacks up, not that it's a fact. treat it accordingly.
- **garbage in, garbage out.** recall is capped by how complete the source data is and by truncation. if the crumbs aren't public, it can't see them, and it'll under-report.
- **stylometry is unreliable.** how separable someone's writing style is depends heavily on the population and the domain. sometimes it's a fingerprint, sometimes it's nothing.
- **confidence depends on evidence density.** thin, low-quality artifacts mean shaky calibration. it knows less when there's less to know.
- **GitHub's public events feed only goes back ~300 events / ~90 days.** commit author emails that only live in older history won't get caught — unless you supply a `GITHUB_TOKEN` and walk the repos directly, which is *not yet implemented*.
- **the website link-follower is single-hop** with same-origin sub-page expansion, and there's no headless browser in the pipeline. so JavaScript-rendered SPAs — client-rendered Next.js, Notion exports, and the like — mostly come back as empty bodies. it reads HTML, not whatever your framework hydrates afterward.
- **`@users.noreply.github.com` addresses are filtered out** of the direct-identifier extractor on purpose. those are GitHub's privacy-preserving default, not a leak — flagging them would be a false positive.

if any of that makes you trust the tool *more* rather than less, good — that was the goal. a tool that's honest about where it's blind is one you can actually reason about.
