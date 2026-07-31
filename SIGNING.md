# SIGNING.md — Tauri Auto-Updater Signing

`pure` ships with [Tauri's auto-updater plugin](https://v2.tauri.app/plugin/updater/), which
verifies the integrity of every downloaded update with a **minisign** signature. Without the
private key set, `bun run gui:build` exits at the sidecar-signing step with:

```
failed to sign app bundle: No valid signing key found in environment
```

This doc explains why we sign, how to generate a key, and how to feed it to the build.

## Why

Three reasons:

1. **Integrity** — the updater rejects a `.app.tar.gz` if its `.sig` is missing or wrong. A
   tampered release (DNS hijack, GitHub account compromise, MITM) cannot replace a real update
   with a malicious one.
2. **Uniqueness** — even if you accidentally publish the same version twice, the signature
   binds the artifact to that single upload.
3. **Trust chain to installed users** — the public key is baked into the binary at compile
   time; updates signed with any other key are rejected by every installed user. **Rotation
   is therefore expensive** (see below).

## Pre-Flight

Two things are already in place:

- `src-tauri/Cargo.toml` has `tauri-plugin-updater = "2"` ✓
- `src-tauri/tauri.conf.json` has `plugins.updater.pubkey` (base64-encoded minisign pubkey)
  and `plugins.updater.endpoints: ["https://releases.pure.app/latest.json"]` ✓

Verify with:

```bash
jq '.plugins.updater' src-tauri/tauri.conf.json
node -e 'require("fs").writeFileSync("/tmp/pub.txt", Buffer.from(require("./src-tauri/tauri.conf.json").plugins.updater.pubkey,"base64").toString())'
cat /tmp/pub.txt   # should look like:
                  #   untrusted comment: minisign public key XXXXXXX
                  #   RWXXXXXXXXXXXXXXXXXXXXX (base64 key)
```

## Step 1 — Generate (or import) a Key

Option A — local, never committed:

```bash
# Interactive (asks for a passphrase). Stored at ~/.tauri/pure.key + ~/.tauri/pure.key.pub
npx tauri signer generate -w ~/.tauri/pure.key
```

Option B — unencrypted (safer for CI, less safe for laptops):

```bash
npx tauri signer generate
```

Option C — already have keys (e.g. on a CI secret store, or migrated from another machine):

```bash
# Either edit .env.local directly with the key body, or save it to ~/.tauri/pure.key
# before running the build.
```

⚠️ **`npx tauri signer generate` does NOT set restrictive permissions on the
key file.** After *any* generation option, lock down the private key:

```bash
chmod 600 ~/.tauri/pure.key
```

The private key file looks like:

```
untrusted comment: minisign secret key
RWXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

## Step 2 — Embed the Public Key in `tauri.conf.json`

The existing pubkey in `plugins.updater.pubkey` is base64 of the full multi-line
`pubkey` file content. After generating a new pair, decode the JSON value, replace it, then
re-encode:

```bash
# 1. Print what the new pubkey file contains
cat ~/.tauri/pure.key.pub

# 2. Convert to base64 (single-line, no trailing newline)
base64 -i ~/.tauri/pure.key.pub | tr -d '\n'
# → "untrusted comment: minisign public key XXXXXXX\nRWXXXXX..."

# 3. Paste that single line into plugins.updater.pubkey in src-tauri/tauri.conf.json
```

This bakes the public key into the binary. **All builds you ship from now on will trust
updates signed by the matching private key only.**

## Step 3 — Set the Private Key in Your Environment

The build (`cargo tauri build`) reads `TAURI_SIGNING_PRIVATE_KEY` from the environment and
automatically signs every updater artifact (`.app.tar.gz`, `.msi.zip`, etc.) → producing
`.sig` sidecars in `src-tauri/target/release/bundle/{macos,updater,…}/`.

Two paths; choose the one that fits your setup:

### Path A — `.env.local` (per-machine, recommended for local dev)

```bash
cp .env.example .env.local
chmod 600 .env.local

# .env.local
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/pure.key)"
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=your-passphrase         # only if you used -w
```

`.env.local` is gitignored (see `.gitignore`), so your key never leaves your laptop.

### Path B — Shell RC (for shared machines / CI logs that auto-redact)

```bash
# ~/.zshrc or ~/.bashrc — DO NOT commit; use a secret manager in CI instead
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/pure.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=your-passphrase
```

For CI, use the platform's secret store (GitHub Actions Encrypted Secrets, GitLab CI
Variables, etc.) and write them to the env at job-start — never inline.

## Step 4 — Verify the Build Chain

```bash
bun run build:gui:mac
```

`build:gui:mac` now does:

1. `bash scripts/load-tauri-signing-env.sh`  ← sources `.env.local`, falls back to
   `~/.tauri/pure.key`. Fails loudly if neither is set.
2. `bun run gui:build`                        ← `cargo tauri build` + vite, signs sidecar
3. `bun run sign:mac`                         ← ad-hoc local signing + `xattr -dr com.apple.quarantine`

You should see in stdout:

```
✓ TAURI_SIGNING_PRIVATE_KEY loaded (length=348, source=$HOME/.tauri/pure.key, password=(none))
...
✓ built in …
…
.pkg.sig  .pkg.tar.gz.sig   ← produced in src-tauri/target/release/bundle/{macos,updater}
```

Then upload both the `.tar.gz` and the matching `.sig` to your release endpoint, and
publish a `latest.json` referencing them. The Tauri updater plugin will pull and verify.

## Rotation

Old clients are pinned to the public key that was compiled into their binary. If you
**rotate the key**:

1. Generate a new keypair (`npx tauri signer generate -f ~/.tauri/pure.key`).
2. Update `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.
3. Ship a new release that contains the **new** public key.
4. Keep signing updates with the **old** key for at least one release cycle (or until
   telemetry says ≥X% of clients have the new key).
5. Then stop signing with the old key — the existing users will be forced to upgrade.

**Dual-signing** (publishing `latest.json` with two `.sig` files, one per key) is supported
by Tauri 2 and lets you transition without forcing upgrades.

## Where Keys Live

| Path                              | Purpose                                          | Commit it? |
| --------------------------------- | ------------------------------------------------ | ---------- |
| `~/.tauri/pure.key`               | Tauri default unencrypted key location           | **NO**     |
| `~/.tauri/pure.key.pub`           | Tauri default public key location                | **YES** (already embedded in tauri.conf.json as base64) |
| `.env.local`                      | Per-developer env override                       | **NO**     |
| `.env.example`                    | Reference template                               | **YES**    |
| `scripts/load-tauri-signing-env.sh` | Env loader used by `bun run build:gui:mac`     | **YES**    |
| `SIGNING.md`                      | This doc                                         | **YES**    |

## Security Checklist

- [ ] `.gitignore` covers `.env`, `.env.local`, `.env.*.local` ✓
- [ ] `.env.local` is `chmod 600` (owner read/write only) ✓
- [ ] Private key never appears in shell history: prefix with a space (zsh) or
      use `HISTIGNORE="*TAURI_SIGNING*"` in bash
- [ ] CI secrets are stored in the provider's encrypted-secret store, not inlined
- [ ] Public key in `tauri.conf.json` matches the **active** private key on your disk

## Verifying a Signed Artifact Manually

```bash
# Download the artifact + signature
curl -L -o pure.app.tar.gz https://releases.pure.app/.../pure_0.6.0_x64.app.tar.gz
curl -L -o pure.app.tar.gz.sig https://releases.pure.app/.../pure_0.6.0_x64.app.tar.gz.sig

# Verify (Tauri's CLI uses minisign under the hood)
npx tauri signer sign -k ~/.tauri/pure.key --verify pure.app.tar.gz.sig
```

`accepted` means the artifact is authentic and unmodified.
