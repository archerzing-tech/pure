// Build the standalone CLI binary (`pure`), baking the current package.json
// version in at compile time via `--define process.env.PURE_CLI_VERSION` so the
// CLI banner always reports the released version — the constant in cli.ts is
// only a fallback and can no longer drift from package.json.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version: string };
const version = pkg.version;

const result = spawnSync(
  'bun',
  [
    'build',
    '--compile',
    'src/cli.ts',
    '--outfile',
    'pure',
    '--external',
    '@huggingface/transformers',
    '--define',
    `process.env.PURE_CLI_VERSION="${version}"`,
  ],
  { stdio: 'inherit' },
);

if (result.error) {
  console.error(`Failed to run bun build: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
