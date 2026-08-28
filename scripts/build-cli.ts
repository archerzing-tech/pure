// Build the standalone CLI binary (`pure`), baking the current package.json
// version in at compile time via `--define process.env.PURE_CLI_VERSION` so the
// CLI banner always reports the released version — the constant in cli.ts is
// only a fallback and can no longer drift from package.json.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version: string };
const version = pkg.version;

// PURE_CLI_TARGET lets CI cross-compile the CLI for a different arch than the
// host (e.g. build a bun-darwin-x64 binary on an Apple Silicon runner so the
// published macOS CLI stays x86_64-compatible). Falls back to the host arch.
const cliTarget = process.env.PURE_CLI_TARGET?.trim();

const bunArgs = [
  'build',
  '--compile',
  'src/cli.ts',
  '--outfile',
  'pure',
  '--external',
  '@huggingface/transformers',
  '--define',
  `process.env.PURE_CLI_VERSION="${version}"`,
];
if (cliTarget) bunArgs.push('--target', cliTarget);

const result = spawnSync(
  'bun',
  bunArgs,
  { stdio: 'inherit' },
);

if (result.error) {
  console.error(`Failed to run bun build: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
