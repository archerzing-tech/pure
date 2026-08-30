// src/cli.ts
// CLI entrypoint (v1.1.0 — one-shot + interactive REPL with self-evolving memory).
// Split into cliConfig / cliAdapter / cliHarness / cliRepl (audit ①); this file
// stays the thin orchestrator: arg parsing, the `pure config` wizard, and the
// main() dispatch to one-shot / REPL.
// Usage: pure "question"              → one-shot
//        pure --resume abc123          → resume session
//        pure --workspace .            → REPL
//        pure config                   → set up provider + API key (persisted to ~/.pure/config.json)
import * as readline from 'node:readline';
import { resolveCliAutoApprove } from './cliIntent';
import { CUSTOM_PRESETS, customProviderFor, customProviderLabel, isCustomProviderId, nextCustomProviderId, providerOverrideFor } from './shared/providers';
import { bold, cyan, dim, green, red } from './termcolors';
import type { MCPServerConfig } from './adapter/mcp/MCPTransport';
import { autoDetectProvider, DEFAULT_CLI_AUTO_APPROVE, envKeyForProvider, hasAnyApiKeyEnv, loadConfig, resolveDefaultModel, resolveOverrideSecretKey, saveConfig, CONFIG_PATH } from './cliConfig';
import type { CliArgs, PureConfig } from './cliConfig';
import { PROVIDER_ENV_HINT, PROVIDER_LABELS } from './cliAdapter';
import { renderLogo, runOneShot, runRepl } from './cliRepl';

type SubCommand = 'config' | '';

// ── Arg parsing ──
// Precedence for provider/apiKey/model: --flag > env var > ~/.pure/config.json > defaults.
// This lets you `pure config` once and never worry about env vars again, while still
// allowing one-off overrides per invocation.

/** Collect repeatable `--flag <value>` occurrences (generic flags overwrite;
 * repeatable ones accumulate — e.g. multiple --mcp-server entries). */
function repeatableFlag(raw: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === `--${name}` && raw[i + 1] && !raw[i + 1].startsWith('--')) {
      out.push(raw[i + 1]);
      i += 1;
    }
  }
  return out;
}

/** Parse one `--mcp-server "<name>:<command-or-url>"` value: values containing
 * `://` are http (SSE) endpoints, everything else is a stdio command. */
function parseMcpServerFlag(value: string): MCPServerConfig {
  const sep = value.indexOf(':');
  const name = sep === -1 ? value : value.slice(0, sep).trim();
  const rest = sep === -1 ? '' : value.slice(sep + 1).trim();
  if (rest.includes('://')) {
    return { name: name || 'mcp', transport: 'http', url: rest };
  }
  return { name: name || 'mcp', transport: 'stdio', command: rest.split(/\s+/).filter(Boolean) };
}

function parseArgs(): { args: CliArgs; command: SubCommand } {
  const raw = Bun.argv.slice(2);
  const flags: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < raw.length; i++) {
    if (raw[i].startsWith('--')) {
      const key = raw[i].slice(2);
      const val = raw[i + 1] && !raw[i + 1].startsWith('--') ? raw[++i] : 'true';
      flags[key] = val;
    } else {
      positional.push(raw[i]);
    }
  }

  // Subcommand: `pure config` opens interactive setup. Only treat it as a
  // command when `config` is the SOLE positional (so `pure config my app` is
  // still treated as a prompt, not the wizard).
  let command: SubCommand = '';
  let promptParts = positional;
  if (positional.length === 1 && positional[0] === 'config') {
    command = 'config';
    promptParts = [];
  }

  const fileCfg = loadConfig();

  // Precedence for provider: --flag > env (auto-detect) > config > default.
  const envProvider = autoDetectProvider();
  const provider = (flags.provider && flags.provider !== 'auto')
    ? flags.provider
    : (hasAnyApiKeyEnv() ? envProvider : (fileCfg?.provider ?? envProvider));

  // Custom providers own their key inside the custom entry (or none at all for
  // keyless locals) — cloud-key env vars must never leak into their requests.
  const isCustom = isCustomProviderId(fileCfg?.customProviders, provider);
  // Built-ins may carry a per-provider key override: plain `apiKey` in the
  // config (browser mode) or the Rust secrets slot (desktop). It wins over
  // the legacy global file key but loses to --api-key and provider env vars.
  const override = isCustom ? undefined : providerOverrideFor(fileCfg?.providerOverrides, provider);
  const overrideKey = override?.apiKey || (override?.hasApiKey ? resolveOverrideSecretKey(provider) : '');
  const apiKey = flags['api-key'] ??
    (isCustom ? '' : (envKeyForProvider(provider) ?? (overrideKey || fileCfg?.apiKey || '')));

  const model = flags.model ?? fileCfg?.model ?? resolveDefaultModel(provider, fileCfg?.customProviders);
  const workspace =
    (flags.workspace && flags.workspace !== 'true') ? flags.workspace : (fileCfg?.workspace || '.');
  const resume = flags.resume && flags.resume !== 'true' ? flags.resume : '';
  const stateDb = flags['state-db'] ?? '';
  // CLI default: trust the operator — approve every tool call. The flag is
  // a one-way opt-out (`--prompt-on-tool`) so users who want the original
  // interactive confirmation flow can still get it. No positive opt-in
  // flag is needed because the default already matches the common case.
  const autoApprove = resolveCliAutoApprove(flags['prompt-on-tool'] !== undefined, DEFAULT_CLI_AUTO_APPROVE);

  // MCP servers: GUI-written ~/.pure/config.json entries first, then any
  // repeatable --mcp-server flags (a flag with the same name replaces the
  // config entry so one-off overrides work). Prefix exclusions merge.
  const mcpServers: MCPServerConfig[] = [...(fileCfg?.mcpServers ?? [])];
  for (const entry of repeatableFlag(raw, 'mcp-server')) {
    const server = parseMcpServerFlag(entry);
    const idx = mcpServers.findIndex((s) => s.name === server.name);
    if (idx >= 0) mcpServers[idx] = server;
    else mcpServers.push(server);
  }
  const mcpExcludedPrefixes = [
    ...(fileCfg?.mcpExcludedPrefixes ?? []),
    ...repeatableFlag(raw, 'mcp-exclude-prefix'),
  ];

  return {
    args: {
      prompt: promptParts.join(' '),
      provider, model, apiKey, workspace, resume, stateDb, autoApprove,
      customProviders: fileCfg?.customProviders,
      providerOverrides: fileCfg?.providerOverrides,
      mcpServers,
      mcpExcludedPrefixes,
    },
    command,
  };
}

// ── `pure config` — interactive one-time setup ──
// Writes ~/.pure/config.json so future `pure` invocations work without env vars.

async function runConfig(): Promise<void> {
  renderLogo();
  process.stdout.write(`  ${bold('pure config')} ${dim('— set up your provider and API key')}\n`);
  process.stdout.write(`  ${dim('Saved to')} ${CONFIG_PATH}${dim('. You only need to do this once.')}\n`);
  console.log('');

  const existing = loadConfig();

  // Each non-secret question gets its own short-lived readline handle so the
  // raw-mode `askMasked` below can take over stdin without contention.
  const ask = (q: string): Promise<string> => {
    const rlQ = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
      rlQ.question(q, a => { rlQ.close(); resolve((a ?? '').trim()); });
    });
  };

  // Raw-mode TTY mask for secrets. Each typed OR pasted character writes one `*`
  // so the user has visible confirmation that their paste landed. Falls back to
  // the unmasked `ask` when stdin is not a TTY (CI scripts, `pure config <
  // keys.txt`). Resolves on Enter, exits on Ctrl+C / Ctrl+D, handles Backspace
  // + Ctrl+U. Strips bracketed-paste boundary escapes so they neither reach
  // the secret buffer nor render as `*` junk.
  const askMasked = (q: string): Promise<string> => {
    if (!process.stdin.isTTY) return ask(q);
    return new Promise(resolve => {
      process.stdout.write(q);
      const wasRaw = !!process.stdin.isRaw;
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf8');

      let buf = '';
      const cleanup = () => {
        try { process.stdin.setRawMode(wasRaw); } catch {}
        process.stdin.pause();
        process.stdin.removeListener('data', onData);
      };
      const onData = (chunk: string) => {
        // Bracketed-paste wrap: \x1b[200~ … \x1b[201~ — strip the boundary
        // markers so they don't reach the key buffer or get echoed as `*`.
        chunk = chunk.replace(/\x1b\[200~|\x1b\[201~/g, '');
        for (const c of chunk) {
          const code = c.charCodeAt(0);
          if (code === 0x03 || code === 0x04) {           // Ctrl+C / Ctrl+D
            cleanup();
            process.stdout.write('\n');
            process.exit(code === 0x03 ? 130 : 1);
            return;
          }
          if (code === 0x0d || code === 0x0a) {           // Enter / LF
            cleanup();
            process.stdout.write('\n');
            resolve(buf);
            return;
          }
          if (code === 0x08 || code === 0x7f) {           // Backspace
            if (buf.length > 0) { buf = buf.slice(0, -1); process.stdout.write('\b \b'); }
            continue;
          }
          if (code === 0x15) {                            // Ctrl+U (clear line)
            if (buf.length > 0) { process.stdout.write('\b \b'.repeat(buf.length)); buf = ''; }
            continue;
          }
          if (code < 0x20) continue;                      // ignore other ctrl codes
          buf += c;
          process.stdout.write('*');
        }
      };
      process.stdin.on('data', onData);
    });
  };

  try {
    // Provider list: built-ins + user-defined customs + an "add new" option.
    const existingCustoms = existing?.customProviders ?? [];
    const builtInKeys = Object.keys(PROVIDER_LABELS) as Array<Exclude<CliArgs['provider'], 'mock'>>;
    const providerKeys: string[] = [...builtInKeys, ...existingCustoms.map(c => c.id), 'add-custom'];
    process.stdout.write(`  ${dim('Available providers:')}\n`);
    providerKeys.forEach((k, i) => {
      const custom = customProviderFor(existingCustoms, k);
      const label = k === 'add-custom'
        ? 'Add custom provider (OpenAI-compatible, e.g. Ollama)'
        : custom
          ? `${custom.name}${custom.apiKey ? '' : ' (no key)'}`
          : customProviderLabel(existingCustoms, k, existing?.providerOverrides);
      const marker = existing?.provider === k ? green(' ← current') : '';
      process.stdout.write(`    ${cyan(String(i + 1))}) ${label}${marker}\n`);
    });
    const currentIdx = existing && existing.provider !== 'mock' ? providerKeys.indexOf(existing.provider) : -1;
    const defaultHint = currentIdx >= 0 ? String(currentIdx + 1) : '1';
    const providerIdxRaw = await ask(`\n  ${bold('Choose provider')} ${dim(`[1-${providerKeys.length}]`)} ${dim(`(default ${defaultHint})`)}: `);
    let providerIdx = providerIdxRaw ? parseInt(providerIdxRaw, 10) - 1 : (currentIdx >= 0 ? currentIdx : 0);
    if (Number.isNaN(providerIdx) || providerIdx < 0 || providerIdx >= providerKeys.length) providerIdx = 0;

    // Custom-provider add flow: Ollama one-click preset or manual entry.
    let finalCustoms = existingCustoms;
    let provider: string;
    if (providerKeys[providerIdx] === 'add-custom') {
      // Quick presets: 1-Ollama 2-OpenAI 3-OpenRouter 4-NVIDIA, then Manual.
      const presetChoices = CUSTOM_PRESETS.map((p, i) => `[${i + 1}] ${p.name}${p.local ? ' (local)' : ''}`).join('  ');
      const presetRaw = await ask(`\n  ${bold('Preset')} ${dim(`${presetChoices}  [${CUSTOM_PRESETS.length + 1}] Manual`)} ${dim('(default 1)')}: `);
      const presetIdx = parseInt(presetRaw, 10) - 1;
      const preset = presetRaw.trim() === '' || Number.isNaN(presetIdx) ? 0 : presetIdx;
      if (preset >= 0 && preset < CUSTOM_PRESETS.length) {
        const chosen = CUSTOM_PRESETS[preset];
        if (!finalCustoms.some(p => p.id === chosen.id)) {
          finalCustoms = [...finalCustoms, { ...chosen }];
        }
        provider = chosen.id;
        process.stdout.write(`  ${green('✓')} ${chosen.name} preset: ${dim(chosen.baseURL)} ${dim(`(default model ${chosen.defaultModel})`)}\n`);
        if (!chosen.local) process.stdout.write(`  ${dim('API key: paste it when prompted below, or set later with')} ${bold('pure config')}${dim('.')}\n`);
      } else {
        const name = (await ask(`\n  ${bold('Provider name')}: `)).trim();
        if (!name) { process.stdout.write(`\n  ${red('❌ Name is required. Aborting.')}\n`); process.exit(1); }
        const baseURL = (await ask(`  ${bold('Base URL')} ${dim('(OpenAI-compatible, e.g. http://localhost:11434/v1)')}: `)).trim();
        if (!baseURL) { process.stdout.write(`\n  ${red('❌ Base URL is required. Aborting.')}\n`); process.exit(1); }
        const modelsRaw = (await ask(`  ${bold('Models')} ${dim('(comma-separated, e.g. qwen2.5-coder:7b, llama3.1:8b)')}: `)).trim();
        const models = modelsRaw.split(',').map(s => s.trim()).filter(Boolean);
        if (models.length === 0) { process.stdout.write(`\n  ${red('❌ At least one model is required. Aborting.')}\n`); process.exit(1); }
        process.stdout.write(`  ${dim('API key is optional — press Enter to skip for local endpoints.')}\n`);
        const apiKeyRaw = await askMasked(`  ${bold('API key')} ${dim('(optional)')}: `);
        const apiKey = apiKeyRaw.trim();
        const id = nextCustomProviderId(finalCustoms);
        finalCustoms = [...finalCustoms, { id, name, baseURL, models, defaultModel: models[0], apiKey, hasApiKey: false }];
        provider = id;
      }
    } else {
      provider = providerKeys[providerIdx];
    }

    const chosenCustom = customProviderFor(finalCustoms, provider);
    let finalKey = chosenCustom?.apiKey ?? '';
    if (!chosenCustom) {
      // Built-in providers require a key — raw-mode masked read so the user
      // sees `*` per character and gets a post-paste confirmation like
      // `✓ Captured 51 chars (sk-…XX)`. The key never appears in scrollback.
      process.stdout.write(`\n  ${dim(`Get your key from the provider, then paste it below. Env var: ${PROVIDER_ENV_HINT[provider as keyof typeof PROVIDER_ENV_HINT]}`)}\n`);
      const apiKeyRaw = await askMasked(`  ${bold('API key')}${existing?.apiKey ? dim(' (Enter to keep current)') : ''}: `);
      const apiKey = apiKeyRaw.trim();
      if (apiKey && process.stdin.isTTY) {
        // First 3 + last 2 chars (e.g. `sk-…XX`) so the user can verify they
        // pasted the right key without seeing the whole secret.
        const preview = apiKey.length > 5 ? `${apiKey.slice(0, 3)}…${apiKey.slice(-2)}` : '***';
        process.stdout.write(`  ${green('✓')} Captured ${apiKey.length} chars (${preview})\n`);
      }
      finalKey = apiKey || existing?.apiKey || '';
      if (!finalKey) {
        process.stdout.write(`\n  ${red('❌ An API key is required for this provider. Aborting.')}\n`);
        process.exit(1);
      }
    } else if (!finalKey) {
      if (chosenCustom && !chosenCustom.local) {
        // Cloud presets (OpenAI / OpenRouter / NVIDIA) still need a key.
        const apiKeyRaw = await askMasked(`  ${bold('API key')} ${dim('(required for this provider)')}: `);
        const apiKey = apiKeyRaw.trim();
        if (apiKey && process.stdin.isTTY) {
          const preview = apiKey.length > 5 ? `${apiKey.slice(0, 3)}…${apiKey.slice(-2)}` : '***';
          process.stdout.write(`  ${green('✓')} Captured ${apiKey.length} chars (${preview})\n`);
        }
        finalKey = apiKey;
        if (!finalKey) {
          process.stdout.write(`\n  ${red('❌ An API key is required for this provider. Aborting.')}\n`);
          process.exit(1);
        }
        const entryIdx = finalCustoms.findIndex(p => p.id === chosenCustom.id);
        if (entryIdx >= 0) finalCustoms[entryIdx] = { ...finalCustoms[entryIdx], apiKey: finalKey };
      } else {
        process.stdout.write(`\n  ${dim('No API key — sending without Authorization (local endpoint).')}\n`);
      }
    }

    // Model
    const defaultModel = resolveDefaultModel(provider, finalCustoms);
    const modelRaw = await ask(`\n  ${bold('Model')} ${dim(`(Enter for default: ${defaultModel})`)}: `);
    const model = modelRaw || existing?.model || defaultModel;

    // Workspace (optional)
    const workspaceRaw = await ask(`  ${bold('Workspace')} ${dim('(Enter for current dir ".")')}: `);
    const workspace = workspaceRaw || existing?.workspace || '.';

    const cfg: PureConfig = {
      provider,
      apiKey: finalKey,
      model,
      workspace,
      customProviders: finalCustoms,
      // Carry existing built-in overrides (name / Base URL / key) through a
      // re-run so `pure config` never silently drops them.
      providerOverrides: existing?.providerOverrides,
    };
    saveConfig(cfg);

    const providerLabelOut = customProviderLabel(finalCustoms, provider, existing?.providerOverrides)
      ?? PROVIDER_LABELS[provider as keyof typeof PROVIDER_LABELS];
    console.log('');
    process.stdout.write(`  ${green('✅ Saved.')} ${dim('Config written to')} ${CONFIG_PATH}\n`);
    process.stdout.write(`     ${dim('Provider:')} ${cyan(providerLabelOut)}\n`);
    process.stdout.write(`     ${dim('Model:')}    ${cyan(model)}\n`);
    process.stdout.write(`     ${dim('Workspace:')}${cyan(workspace)}\n`);
    process.stdout.write(`\n  ${dim('You can now run')} ${bold('pure')} ${dim('or')} ${bold('pure "your question"')} ${dim('.')}\n`);
    process.stdout.write(`  ${dim('Re-run')} ${bold('pure config')} ${dim('to change anything later.')}\n`);
  } finally {
    // ask() and askMasked() each manage their own stdin handles; nothing to close here.
  }
}

// ── Entry ──

async function main() {
  const { args, command } = parseArgs();

  if (command === 'config') {
    await runConfig();
    return;
  }

  if (args.prompt) {
    await runOneShot(args);
  } else {
    await runRepl(args);
  }
}

main().catch(console.error);
