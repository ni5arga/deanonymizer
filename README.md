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

## Installation

```bash
npm install
```

### LLM backend

The analysis stage runs on either of two interchangeable backends, selected
automatically from the environment (override with `--provider`):

**Anthropic (native, default when only this key is set)**

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# default model is the fast claude-haiku-4-5
# optional: export ANTHROPIC_MODEL=claude-sonnet-4-6  # slower, higher quality
```

**Any OpenAI-compatible endpoint** — OpenAI, Google Gemini, Ollama, Groq,
Together, etc. Point `OPENAI_BASE_URL` at the provider's Chat Completions
surface:

```bash
# OpenAI
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=gpt-4o-mini

# Google Gemini (OpenAI-compatible endpoint)
export OPENAI_API_KEY=...your-gemini-key...
export OPENAI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
export OPENAI_MODEL=gemini-2.0-flash

# Ollama (local, no key required)
export OPENAI_BASE_URL=http://localhost:11434/v1
export OPENAI_MODEL=llama3
```

Selection order: `--provider` flag → `LLM_PROVIDER` env → auto-detect
(`OPENAI_*` / `--base-url` → openai; `ANTHROPIC_API_KEY` → anthropic). Existing
Anthropic-only setups keep working unchanged. Native Anthropic prompt caching is
preserved on the Anthropic path; the OpenAI path requests
`response_format: json_object` where supported and still runs the JSON-repair
fallback for endpoints that ignore it.

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
npm run audit -- my_reddit_handle --base-url http://localhost:11434/v1 --model llama3

# Force a specific provider/model for one run
npm run audit -- my_reddit_handle --provider openai --model gpt-4o-mini
```

## CLI options

| Flag | Default | Description |
|------|---------|-------------|
| [reddit-username] / --reddit | none | Reddit user to audit (accepts u/name) |
| --hn <username> | none | Hacker News user to audit |
| -n, --max <n> | 300 | Maximum items fetched per platform |
| --max-chars <n> | 120000 | Maximum analysis transcript budget |
| --concurrency <n> | all (≤8) | Number of chunk workers processed in parallel |
| --provider <name> | auto-detect | LLM provider: `anthropic` or `openai` |
| --base-url <url> | none | OpenAI-compatible base URL (Gemini/Ollama/Groq/…); implies `openai` |
| --model <name> | provider default | Override the model name |
| --json | false | Emit JSON instead of text report |
| --require-external-proof | false | Fail if no proof URL exists beyond audited profile pages |
| -o, --out <file> | stdout | Write output to file |
| --i-am-authorized | false | Skip interactive authorization prompt for scripted runs |

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
