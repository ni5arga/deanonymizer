# deanonymizer

deanonymizer is a command-line system for defensive OSINT exposure
measurement. It estimates re-identification risk from public Reddit and Hacker
News corpora by aggregating weak signals, scoring identity hypotheses, and
emitting evidence-linked remediation guidance.

## Research basis

The design follows the inference setting discussed in:

- [arXiv:2602.16800](https://arxiv.org/abs/2602.16800)

Operational premise: low-entropy disclosures that appear non-identifying in
isolation may become identifying under cross-post and cross-platform fusion.

## Quick Start

Get up and running in three steps:

### 1. Clone and install

```bash
git clone https://github.com/ni5arga/deanonymizer.git
cd deanonymizer
npm install
```

### 2. Set up an LLM provider

You need access to at least one LLM. Pick any option below — the tool works
with 9 different providers out of the box. The fastest free option is
**OpenRouter** with Google Gemini:

```bash
# Grab a free API key from https://openrouter.ai/keys
export OPENAI_API_KEY="your-openrouter-key"
```

Or if you already have an Anthropic or OpenAI key, just export it and go:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# or
export OPENAI_API_KEY=sk-...
```

### 3. Run it

```bash
# Audit your Reddit account
npm run audit -- my_reddit_handle

# Audit your Hacker News account
npm run audit -- --hn my_hn_handle

# Both at once
npm run audit -- my_reddit_handle --hn my_hn_handle
```

The tool will fetch your public posts, send them to the LLM for analysis, and
print a color-coded exposure report showing what an attacker could infer about
you — along with exact links to the leaking posts so you can delete them.

## Supported Providers

deanonymizer works with any OpenAI-compatible Chat Completions endpoint. Use
`--provider` to select one, or let the tool auto-detect from your environment.

| Provider | `--provider` | Env vars needed | Default model | Free tier? |
|----------|-------------|-----------------|---------------|------------|
| **Anthropic** | `anthropic` | `ANTHROPIC_API_KEY` | `claude-haiku-4-5` | No |
| **OpenAI** | `openai` | `OPENAI_API_KEY` | `gpt-4o-mini` | No |
| **OpenRouter** | `openrouter` | `OPENAI_API_KEY` | `google/gemini-2.0-flash-exp:free` | ✅ Yes |
| **Google Gemini** | `gemini` | `OPENAI_API_KEY` (Gemini key) | `gemini-2.0-flash` | ✅ Yes (free tier) |
| **Ollama** | `ollama` | None (local) | `llama3` | ✅ Local |
| **Groq** | `groq` | `OPENAI_API_KEY` (Groq key) | `llama-3.3-70b-versatile` | ✅ Yes |
| **Together** | `together` | `OPENAI_API_KEY` (Together key) | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | Limited |
| **NVIDIA NIM** | `nvidia` | `OPENAI_API_KEY` (NVIDIA key) | `meta/llama-3.3-70b-instruct` | Limited |
| **Mistral** | `mistral` | `OPENAI_API_KEY` (Mistral key) | `mistral-small-latest` | Limited |

### Provider setup examples

<details>
<summary><strong>Anthropic (Claude)</strong></summary>

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm run audit -- my_reddit_handle

# Use a higher-quality model
npm run audit -- my_reddit_handle --model claude-sonnet-4-6
```
</details>

<details>
<summary><strong>OpenAI</strong></summary>

```bash
export OPENAI_API_KEY=sk-...
npm run audit -- my_reddit_handle

# Override model
export OPENAI_MODEL=gpt-4o
npm run audit -- my_reddit_handle
```
</details>

<details>
<summary><strong>OpenRouter (recommended free option)</strong></summary>

OpenRouter aggregates dozens of models behind a single API. Sign up at
[openrouter.ai](https://openrouter.ai) and grab a free key.

```bash
export OPENAI_API_KEY="your-openrouter-key"

# Option A: Use the provider preset (auto-configures base URL + model)
npm run audit -- my_reddit_handle --provider openrouter

# Option B: Manual setup
export OPENAI_BASE_URL="https://openrouter.ai/api/v1"
export OPENAI_MODEL="google/gemini-2.0-flash-exp:free"
npm run audit -- my_reddit_handle
```

> **Tip:** Avoid `openrouter/free` as the model name — it auto-routes through a
> congested queue and frequently times out. Instead, pick a specific free model
> like `google/gemini-2.0-flash-exp:free` or
> `meta-llama/llama-3.3-70b-instruct:free`.
</details>

<details>
<summary><strong>Google Gemini (direct)</strong></summary>

```bash
export OPENAI_API_KEY="your-gemini-api-key"
npm run audit -- my_reddit_handle --provider gemini

# Or manually:
export OPENAI_BASE_URL="https://generativelanguage.googleapis.com/v1beta/openai/"
export OPENAI_MODEL="gemini-2.0-flash"
npm run audit -- my_reddit_handle
```
</details>

<details>
<summary><strong>Ollama (local, fully offline)</strong></summary>

Install [Ollama](https://ollama.ai), pull a model, then run:

```bash
ollama pull llama3
npm run audit -- my_reddit_handle --provider ollama

# Or manually:
npm run audit -- my_reddit_handle --base-url http://localhost:11434/v1 --model llama3
```

No API key needed — everything runs on your machine.
</details>

<details>
<summary><strong>Groq</strong></summary>

```bash
export OPENAI_API_KEY="your-groq-key"
npm run audit -- my_reddit_handle --provider groq
```
</details>

<details>
<summary><strong>Together AI</strong></summary>

```bash
export OPENAI_API_KEY="your-together-key"
npm run audit -- my_reddit_handle --provider together
```
</details>

<details>
<summary><strong>NVIDIA NIM</strong></summary>

```bash
export OPENAI_API_KEY="nvapi-..."
npm run audit -- my_reddit_handle --provider nvidia
```
</details>

<details>
<summary><strong>Mistral</strong></summary>

```bash
export OPENAI_API_KEY="your-mistral-key"
npm run audit -- my_reddit_handle --provider mistral
```
</details>

<details>
<summary><strong>Any other OpenAI-compatible endpoint</strong></summary>

Point `--base-url` at any Chat Completions surface:

```bash
export OPENAI_API_KEY="your-key"
npm run audit -- my_reddit_handle --base-url https://your-api.example.com/v1 --model your-model
```
</details>

### Model fallback

When the primary model fails with a retryable error (429 rate limit, 504
gateway timeout, empty response), deanonymizer automatically retries with a
known-good fallback model for that provider. You'll see a warning like:

```
⚠ Model "openrouter/free" failed, falling back to "google/gemini-2.0-flash-exp:free"
```

This happens transparently — no configuration needed.

## Formal objective

Given a subject handle set H and public artifact set D, produce a risk report R
containing:

- identity-relevant feature extractions
- evidence-backed linkage claims
- calibrated confidence labels
- prioritized mitigation actions

## Threat model

- Observer model: passive adversary with access to publicly available text and
  metadata only
- Data boundary: no private APIs, credentialed access, or hidden datasets
- Attack primitive: probabilistic entity linkage via feature composition
- Security goal: minimize attributable identity surface from public traces

## Pipeline

1. Acquisition
   - Reddit artifacts from [Arctic Shift API](https://arctic-shift.photon-reddit.com)
   - Hacker News artifacts from [HN Algolia Search API](https://hn.algolia.com/api)
2. Canonicalization
   - Heterogeneous source records mapped into a unified item schema
   - Temporal and textual normalization for bounded-context inference
3. Feature extraction and attribution
   - Detection of location, affiliation, temporal routine, self-disclosed
     demographics, cross-platform handles, external URLs, and stylometric cues
   - Attribution binding from claim to quote-level evidence and permalink
4. Risk synthesis
   - Confidence-calibrated findings: low, medium, high
   - Explicit exact-user section and public proof URL set
   - Finding-level remediation recommendations

## Output properties

- Human-readable report with ranked findings and rationale
- JSON serialization for longitudinal tracking and downstream analytics
- Optional strict validation: fail if no external proof URL exists beyond
  audited platform profile endpoints

## Usage

```bash
# Reddit only
npm run audit -- my_reddit_handle

# Reddit + Hacker News
npm run audit -- my_reddit_handle --hn my_hn_handle

# Hacker News only
npm run audit -- --hn my_hn_handle

# JSON output
npm run audit -- my_reddit_handle --json -o report.json

# Strict proof validation
npm run audit -- my_reddit_handle --require-external-proof

# Faster wall-clock analysis (parallel chunk workers)
npm run audit -- my_reddit_handle --concurrency 3

# Run against a local Ollama model
npm run audit -- my_reddit_handle --provider ollama

# Use OpenRouter with a specific free model
npm run audit -- my_reddit_handle --provider openrouter --model meta-llama/llama-3.3-70b-instruct:free

# Force a specific provider/model for one run
npm run audit -- my_reddit_handle --provider openai --model gpt-4o-mini

# Increase timeout for slow models (default: 70000ms)
npm run audit -- my_reddit_handle --timeout 120000
```

## CLI options

| Flag | Default | Description |
|------|---------|-------------|
| [reddit-username] / --reddit | none | Reddit user to audit (accepts u/name) |
| --hn \<username\> | none | Hacker News user to audit |
| -n, --max \<n\> | 300 | Maximum items fetched per platform |
| --max-chars \<n\> | 120000 | Maximum analysis transcript budget |
| --concurrency \<n\> | all (≤8) | Number of chunk workers processed in parallel |
| --provider \<name\> | auto-detect | LLM provider (see Supported Providers above) |
| --base-url \<url\> | none | OpenAI-compatible base URL (overrides provider preset) |
| --model \<name\> | provider default | Override the model name |
| --timeout \<ms\> | 70000 | LLM request timeout in milliseconds |
| --json | false | Emit JSON instead of text report |
| --require-external-proof | false | Fail if no proof URL exists beyond audited profile pages |
| -o, --out \<file\> | stdout | Write output to file |
| --i-am-authorized | false | Skip interactive authorization prompt for scripted runs |

## Troubleshooting

### "timed out after 45000ms" / "timed out after 70000ms"

The LLM is taking too long to respond. Common causes:
- **Free-tier congestion** (especially OpenRouter's `openrouter/free` auto-router)
- **Too many concurrent chunks** overwhelming rate limits

Fixes:
```bash
# Increase the timeout
npm run audit -- my_handle --timeout 120000

# Reduce concurrency (process one chunk at a time)
npm run audit -- my_handle --concurrency 1

# Reduce the number of posts to analyze
npm run audit -- my_handle -n 100

# Switch to a faster model
npm run audit -- my_handle --provider openrouter --model google/gemini-2.0-flash-exp:free
```

### "returned no choices or an error payload: {\"error\":{...}}"

The LLM provider returned an error instead of a valid response. The error JSON
is included in the message for diagnosis. Common causes:
- **504 Gateway Timeout**: Provider is overloaded. Try a different model.
- **429 Rate Limit**: Too many requests. Lower `--concurrency` or wait.
- **401 Unauthorized**: Check your API key.

### "Cannot read properties of undefined (reading '0')"

This was a bug in older versions where error payloads from providers like
OpenRouter would crash the tool. Update to the latest version — this is now
handled gracefully with a descriptive error message and automatic fallback.

### Model keeps failing on OpenRouter

Avoid `openrouter/free` — use an explicit free model:
```bash
npm run audit -- my_handle --provider openrouter --model google/gemini-2.0-flash-exp:free
```

## Reproducibility and calibration

- Increase -n to expand retrieval depth
- Increase --max-chars to reduce context truncation
- Pin the model (ANTHROPIC_MODEL / OPENAI_MODEL / --model) to control inference backend variance
- Store JSON outputs for temporal diff and regression analysis

## Build

```bash
npm run build
```

## Limitations

- Findings are probabilistic and should not be interpreted as identity proof
- Recall is upper-bounded by source completeness and truncation constraints
- Stylometric separability is population- and domain-dependent
- Confidence calibration depends on evidence density and artifact quality
