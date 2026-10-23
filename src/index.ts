#!/usr/bin/env node
import { Command } from "commander";
import pc from "picocolors";
import { writeFile } from "node:fs/promises";
import { CONSENT_BANNER, requireConsent } from "./consent.js";
import { fetchReddit } from "./sources/reddit.js";
import { fetchHN } from "./sources/hn.js";
import { fetchGitHub } from "./sources/github.js";
import { fetchStackOverflow } from "./sources/stackoverflow.js";
import { analyze } from "./analyze.js";
import { createLLMClient, resolveProvider } from "./llm/index.js";
import {
  discoverChatCatalog,
  ORCAROUTER_DEFAULT_BASE_URL,
  ORCAROUTER_CONSOLE_URL,
  resolveChatModel,
} from "./llm/orcarouter-catalog.js";
import {
  looksLikeOrcaRouterKey,
  resolveOrcaRouterBaseUrl,
} from "./llm/orcarouter.js";
import { renderJson, renderText } from "./report.js";
import type { Profile } from "./types.js";

const program = new Command();

/** OrcaRouter inference origin from flags/env, validated before use. */
function orcaBaseUrl(opts: { baseUrl?: string }): string {
  return resolveOrcaRouterBaseUrl(
    opts.baseUrl ??
      process.env.ORCAROUTER_BASE_URL ??
      ORCAROUTER_DEFAULT_BASE_URL,
  );
}

function orcaApiKey(): string {
  const key = process.env.ORCAROUTER_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "ORCAROUTER_API_KEY is not set. Create a key at " +
        `${ORCAROUTER_CONSOLE_URL} and export ORCAROUTER_API_KEY=sk-orca-... then retry.`,
    );
  }
  return key;
}

/** `--list-models`: print the live chat catalog, or the verified fallback. */
async function printOrcaRouterModels(opts: {
  provider?: string;
  baseUrl?: string;
}): Promise<void> {
  const provider = resolveProvider({
    provider: opts.provider,
    baseUrl: opts.baseUrl,
  });
  if (provider !== "orcarouter") {
    throw new Error(
      "--list-models is only available for the OrcaRouter provider. Add --provider orcarouter.",
    );
  }

  const catalog = await discoverChatCatalog({
    baseUrl: orcaBaseUrl(opts),
    apiKey: orcaApiKey(),
  });

  if (catalog.degraded) {
    process.stderr.write(
      pc.yellow(
        `warning: live OrcaRouter model catalog unavailable (${catalog.degradedReason}).\n` +
          `Using the verified fallback catalog (${catalog.models.length} models).\n`,
      ),
    );
  }

  const heading =
    catalog.source === "live"
      ? "OrcaRouter chat models (live catalog)"
      : "OrcaRouter chat models (verified fallback)";
  console.log(`${heading} — ${catalog.models.length} available:`);
  for (const model of catalog.models) {
    const ctx = model.contextLength
      ? pc.dim(`  ${model.contextLength.toLocaleString("en-US")} ctx`)
      : "";
    console.log(`  ${model.id}${ctx}`);
  }
  const fallback = resolveChatModel(catalog).model.id;
  console.log(
    `\nSelect one with --model <id> or ORCAROUTER_MODEL=<id>. Default: ${fallback}`,
  );
}

program
  .name("audit")
  .description(
    "deanonymizer — consent-based privacy exposure auditor. Pull your own Reddit / Hacker News\n" +
      "history and report what an attacker could infer, so you can scrub it.\n" +
      "Defensive mirror of the deanonymization attack in arXiv:2602.16800.",
  )
  .version("0.1.0");

program
  .argument(
    "[reddit-username]",
    "Reddit username to audit (also accepts u/name)",
  )
  .option("--hn <username>", "Also audit this Hacker News (YC) username")
  .option("--github <username>", "Also audit this GitHub username")
  .option(
    "--so <id_or_url>",
    "Also audit this Stack Overflow user (numeric user_id or profile URL)",
  )
  .option(
    "--reddit <username>",
    "Reddit username (alternative to positional arg)",
  )
  .option("-n, --max <n>", "Max items per platform to fetch", "300")
  .option(
    "--max-chars <n>",
    "Max characters of transcript sent to the LLM",
    "120000",
  )
  .option(
    "--concurrency <n>",
    "Number of analysis chunks to process in parallel (default: all chunks at once, up to 8)",
  )
  .option(
    "--provider <name>",
    "LLM provider: 'anthropic', 'openai', 'orcarouter', or 'claude-code' (default: auto-detect from env)",
  )
  .option(
    "--base-url <url>",
    "OpenAI-compatible base URL (e.g. Gemini, Ollama, Groq); implies --provider openai. With --provider orcarouter it sets the OrcaRouter inference base.",
  )
  .option(
    "--model <name>",
    "Override the model name (else ANTHROPIC_MODEL / OPENAI_MODEL / ORCAROUTER_MODEL / provider default)",
  )
  .option(
    "--list-models",
    "List the live OrcaRouter chat models and exit (requires --provider orcarouter + ORCAROUTER_API_KEY)",
  )
  .option("--json", "Emit JSON instead of a human report")
  .option(
    "--require-external-proof",
    "Fail if no public proof URL exists beyond the audited platform profile pages",
  )
  .option("-o, --out <file>", "Write the report to a file")
  .option(
    "--i-am-authorized",
    "Skip the interactive consent prompt (asserts you own/are authorized for the target)",
  )
  .action(async (positional, opts) => {
    if (opts.listModels) {
      await printOrcaRouterModels(opts);
      return;
    }

    const redditUser = opts.reddit ?? positional;
    const hnUser = opts.hn;
    const githubUser = opts.github;
    const soUser = opts.so;

    if (!redditUser && !hnUser && !githubUser && !soUser) {
      console.error(
        pc.red(
          "Provide at least one of: positional Reddit handle, --hn, --github, --so.\n",
        ) +
          "Examples:\n" +
          "  audit my_reddit_handle\n" +
          "  audit my_reddit_handle --hn my_hn_handle\n" +
          "  audit --github my_gh_handle --so 1234567\n" +
          "  audit my_reddit_handle --hn my_hn_handle --github my_gh_handle --so 1234567",
      );
      process.exit(1);
    }

    if (!opts.json) console.error(CONSENT_BANNER);

    const subjectLabel = [
      redditUser && `reddit:${redditUser}`,
      hnUser && `hn:${hnUser}`,
      githubUser && `github:${githubUser}`,
      soUser && `stackoverflow:${soUser}`,
    ]
      .filter(Boolean)
      .join(" + ");
    await requireConsent({
      username: subjectLabel,
      assumeYes: Boolean(opts.iAmAuthorized),
    });

    const max = Number.parseInt(opts.max, 10);
    const maxChars = Number.parseInt(opts.maxChars, 10);
    const concurrency = opts.concurrency
      ? Math.max(1, Number.parseInt(opts.concurrency, 10) || 1)
      : undefined;

    // Resolve the LLM backend up front so a misconfigured provider fails before
    // we spend time fetching public history. For OrcaRouter the model is chosen
    // from its live catalog rather than typed in free-form.
    const provider = resolveProvider({
      provider: opts.provider,
      baseUrl: opts.baseUrl,
    });
    let modelOverride: string | undefined = opts.model;
    if (provider === "orcarouter") {
      const apiKey = orcaApiKey();
      if (!looksLikeOrcaRouterKey(apiKey)) {
        process.stderr.write(
          pc.yellow(
            "warning: ORCAROUTER_API_KEY does not start with sk-orca-; continuing anyway.\n",
          ),
        );
      }
      const catalog = await discoverChatCatalog({
        baseUrl: orcaBaseUrl(opts),
        apiKey,
      });
      if (catalog.degraded) {
        process.stderr.write(
          pc.yellow(
            `warning: live OrcaRouter model catalog unavailable (${catalog.degradedReason}); ` +
              `falling back to the verified list of ${catalog.models.length} models.\n`,
          ),
        );
      }
      const resolved = resolveChatModel(
        catalog,
        opts.model ?? process.env.ORCAROUTER_MODEL,
      );
      modelOverride = resolved.model.id;
      process.stderr.write(
        pc.dim(
          `OrcaRouter catalog: ${catalog.source} (${catalog.models.length} chat models); using ${modelOverride}\n`,
        ),
      );
    }

    const llm = createLLMClient({
      provider: opts.provider,
      baseUrl: opts.baseUrl,
      model: modelOverride,
    });
    process.stderr.write(pc.dim(`Using ${llm.label} model ${llm.model}\n`));

    const profiles: Profile[] = [];

    if (redditUser) {
      process.stderr.write(
        pc.dim(`Fetching Reddit history for ${redditUser}… `),
      );
      const p = await fetchReddit(redditUser, max);
      process.stderr.write(pc.dim(`${p.items.length} items\n`));
      if (p.items.length) profiles.push(p);
    }

    if (hnUser) {
      process.stderr.write(pc.dim(`Fetching HN history for ${hnUser}… `));
      const p = await fetchHN(hnUser, max);
      process.stderr.write(pc.dim(`${p.items.length} items\n`));
      if (p.items.length) profiles.push(p);
    }

    if (githubUser) {
      process.stderr.write(
        pc.dim(`Fetching GitHub history for ${githubUser}… `),
      );
      const p = await fetchGitHub(githubUser, max);
      process.stderr.write(pc.dim(`${p.items.length} items\n`));
      if (p.items.length) profiles.push(p);
    }

    if (soUser) {
      process.stderr.write(
        pc.dim(`Fetching Stack Overflow history for ${soUser}… `),
      );
      const p = await fetchStackOverflow(soUser, max);
      process.stderr.write(pc.dim(`${p.items.length} items\n`));
      if (p.items.length) profiles.push(p);
    }

    if (profiles.length === 0) {
      console.error(
        pc.red("No public content found. Check the username(s) and try again."),
      );
      process.exit(1);
    }

    process.stderr.write(pc.dim("Analyzing footprint…\n"));
    const result = await analyze(profiles, {
      llm,
      maxChars,
      chunkConcurrency: concurrency,
      onProgress: (p) => {
        const chunkLabel =
          p.currentChunk && p.totalChunks
            ? ` [chunk ${p.currentChunk}/${p.totalChunks}]`
            : "";
        process.stderr.write(
          pc.dim(
            `  ${String(p.percent).padStart(3, " ")}%  ${p.message}${chunkLabel}\n`,
          ),
        );
      },
    });

    if (opts.requireExternalProof) {
      const platformProfileUrls = new Set(
        result.platformProfiles.map((p) => p.profileUrl),
      );
      const externalProofUrls = (result.identity.publicProofUrls ?? []).filter(
        (u) => !platformProfileUrls.has(u),
      );

      if (externalProofUrls.length === 0) {
        console.error(
          pc.red(
            "Validation failed: no external public proof URL found beyond audited platform profile pages.",
          ) +
            "\nTry increasing --max/--max-chars, or add more sources where public links are present.",
        );
        process.exit(2);
      }
    }

    const output = opts.json ? renderJson(result) : renderText(result);

    if (opts.out) {
      await writeFile(opts.out, output, "utf8");
      console.error(pc.green(`Report written to ${opts.out}`));
    } else {
      console.log(output);
    }
  });

program.parseAsync().catch((err) => {
  console.error(pc.red(`\nError: ${err.message ?? err}`));
  process.exit(1);
});
