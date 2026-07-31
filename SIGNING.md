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
untrusted comment: rsign encrypted secret key
RWXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

> ⚠️ **Format gotcha (we hit this in v0.8.0):** Tauri 2's `tauri signer generate`
> always writes the **`rsign encrypted secret key`** header — even a key you think
> is "unencrypted". The CLI signer (`tauri signer sign`) may accept it without a
> password, but the **Rust bundler inside `tauri build` / CI does NOT** — it fails
> with `incorrect updater private key password: Wrong password for that key`.
> For CI you MUST generate the key with an explicit password and provide BOTH
> `TAURI_SIGNING_PRIVATE_KEY` **and** `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
> (see [Rotation](#rotation) for the exact recipe).

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
**rotate the key**, follow the CI-proven procedure below (it's exactly what fixed the
v0.8.0 release after two failed CI runs).

> ⚠️ **Backup first.** Never delete the old key until the new release ships:
> ```bash
> cp ~/.tauri/pure.key ~/.tauri/pure.key.bak
> cp ~/.tauri/pure.key.pub ~/.tauri/pure.key.pub.bak
> ```

### Step A — Generate a new keypair with a KNOWN password

```bash
# -w writes to file · -p sets the password (REQUIRED for CI) · --ci skips prompts
npx tauri signer generate -w ~/.tauri/pure.key --ci -p '<STRONG_PASSWORD>'
```

Keep the password safe — you'll need it for the GitHub secret. Verify the key works
**with the password** (the CLI signer may accept passwordless, the Rust bundler won't):

```bash
echo 'probe' > /tmp/probe.txt && rm -f /tmp/probe.txt.sig
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/pure.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD='<STRONG_PASSWORD>' \
npx tauri signer sign /tmp/probe.txt
ls /tmp/probe.txt.sig   # must exist
```

### Step B — Embed the new public key in `tauri.conf.json`

```bash
cat ~/.tauri/pure.key.pub                                  # show the new pubkey
base64 -i ~/.tauri/pure.key.pub | tr -d '\n'                # → single-line base64
```

Paste the base64 line into `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`, then
confirm it matches your disk key exactly:

```bash
python3 -c "import json,base64; print(base64.b64decode(json.load(open('src-tauri/tauri.conf.json'))['plugins']['updater']['pubkey']).decode())"
cat ~/.tauri/pure.key.pub
# both outputs must be identical
```

### Step C — Update GitHub secrets (BOTH required)

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/pure.key
printf '%s' '<STRONG_PASSWORD>' | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD
gh secret list   # verify both exist
```

### Step D — Make sure the release workflow passes the password

`.github/workflows/release.yml` passes both env vars to `tauri-apps/tauri-action`:

```yaml
env:
  TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
```

(If your workflow predates the fix, add the `_PASSWORD` line — missing it reproduces
`incorrect updater private key password` in CI.)

### Step E — Verify locally before burning a CI cycle

```bash
# Exact CI signing path: updater artifact signature via the Rust bundler
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/pure.key)" \
TAURI_SIGNING_PRIVATE_KEY_PASSWORD='<STRONG_PASSWORD>' \
bun run gui:build
```

Success looks like:

```
Finished 1 updater signature at:
    src-tauri/target/release/bundle/macos/pure.app.tar.gz.sig
```

### Step F — Commit, push, force-update the tag, release

```bash
git add src-tauri/tauri.conf.json .github/workflows/release.yml
# ... commit + push main ...

# If the release tag was ALREADY pushed pointing at an older (broken) commit,
# force-update it so the new workflow actually runs:
git tag -f v0.8.0 && git push --force origin v0.8.0
```

Then watch the run and verify assets on the release page (`gh release view v0.8.0`).

### Transition for existing users

1. Keep signing updates with the **old** key for at least one release cycle (or until
   telemetry says ≥X% of clients have the new key).
2. Then stop signing with the old key — the existing users will be forced to upgrade.

**Dual-signing** (publishing `latest.json` with two `.sig` files, one per key) is supported
by Tauri 2 and lets you transition without forcing upgrades. Since v0.8.0 is the first
shipped release, there are no old clients to migrate — a clean cutover is fine.

## CI Troubleshooting — pitfalls we hit

Real failures from the v0.8.0 release cycle, all fixed in the current
`.github/workflows/release.yml`. Read these BEFORE changing the workflow.

### 1. Empty secrets crash the build: `failed codesign application: security import`

**Symptom** (bundling step):

```
failed to bundle project: failed codesign application: failed to run command security import:
failed to import keychain certificate
```

**Cause:** the workflow passed `APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}` etc.
unconditionally. With **zero secrets configured**, GitHub substitutes an **empty string**,
and tauri-bundler treats a present-but-empty `APPLE_CERTIFICATE` as "signing requested" →
it runs `security import` on an empty cert → crash.

**Fix:** run the tauri-action step in two mutually-exclusive branches — signed (only when
the secret exists) and unsigned (no `APPLE_*` env vars at all):

```yaml
jobs:
  release:
    env:
      HAS_APPLE_SIGNING: ${{ secrets.APPLE_CERTIFICATE != '' }}
    steps:
      - name: Build and publish GUI (signed)
        if: env.HAS_APPLE_SIGNING == 'true'
        uses: tauri-apps/tauri-action@v0
        env:
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
          # ... all other APPLE_* vars ...

      - name: Build and publish GUI (unsigned)
        if: env.HAS_APPLE_SIGNING == 'false'
        uses: tauri-apps/tauri-action@v0
        env:
          # NO APPLE_* vars here — that's the whole point
```

### 2. `secrets` context is NOT allowed in `if:` expressions

**Symptom:** the run dies instantly (0s) with `This run likely failed because of a
workflow file issue.` even though the YAML parses fine locally.

**Cause:** `if: ${{ secrets.APPLE_CERTIFICATE != '' }}` — GitHub Actions forbids the
`secrets` context inside `if:`. (actionlint flags it: *context "secrets" is not allowed
here*.)

**Fix:** mirror the secret into a job-level `env` var and branch on that (shown above).
Valid contexts for `if:` are only `env`, `github`, `inputs`, `job`, `matrix`, `needs`,
`runner`, `steps`, `strategy`, `vars`.

Validate the workflow locally before pushing — install once, then lint fast:

```bash
go run github.com/rhysd/actionlint/cmd/actionlint@latest .github/workflows/release.yml
```

### 3. `incorrect updater private key password` at the very end of the build

**Symptom:** everything builds — `.app`, `.dmg`, `.app.tar.gz` — then the LAST step dies:

```
failed to decode secret key: incorrect updater private key password: Wrong password for that key
```

**Cause:** the private key is in `rsign encrypted secret key` format and the CI job had
`TAURI_SIGNING_PRIVATE_KEY` set but no `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (or the
password didn't match). The Rust bundler is strict here, even though the CLI signer
sometimes signs without a password.

**Fix:** rotate to a key with a **known** password and set BOTH secrets (Steps A–C above).

### 4. Release tag points at a broken commit

**Symptom:** you pushed a tag, the workflow failed, you fixed the workflow, but pushing
more commits to `main` doesn't re-trigger the release.

**Cause:** the workflow only runs on tag pushes, and the tag still points at the old
commit.

**Fix:** force-update the tag to the fixed commit and push:

```bash
git tag -f v0.8.0 && git push --force origin v0.8.0
```

## Where Keys Live

| Path                              | Purpose                                          | Commit it? |
| --------------------------------- | ------------------------------------------------ | ---------- |
| `~/.tauri/pure.key`               | Tauri default key location                       | **NO**     |
| `~/.tauri/pure.key.pub`           | Tauri default public key location                | **YES** (already embedded in tauri.conf.json as base64) |
| `~/.tauri/pure.key.bak`           | Pre-rotation backup of the old key               | **NO**     |
| GitHub secret `TAURI_SIGNING_PRIVATE_KEY` | Private key for CI updater signing        | n/a (secret store) |
| GitHub secret `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Key password for CI                | n/a (secret store) |
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

> ⚠️ The `tauri signer` CLI only has `sign` and `generate` subcommands — there is NO
> `verify` subcommand. Signature verification happens at runtime inside the Tauri
> updater plugin, which compares against the pubkey baked into the binary.

For an out-of-band check, verify with `minisign` (Tauri's updater format is minisign):

```bash
# Install once
brew install minisign

# Download the artifact + signature (asset names from the GitHub release, e.g. pure_aarch64.app.tar.gz)
curl -L -o pure.app.tar.gz https://releases.pure.app/.../pure_aarch64.app.tar.gz
curl -L -o pure.app.tar.gz.sig https://releases.pure.app/.../pure_aarch64.app.tar.gz.sig

# Extract the pubkey from tauri.conf.json to a temp file
python3 -c "import json,base64; open('/tmp/pure.pub','w').write(base64.b64decode(json.load(open('src-tauri/tauri.conf.json'))['plugins']['updater']['pubkey']).decode())"

# Verify (use ONLY -p with the extracted pubkey file; -P is an alternative inline form, don't mix)
minisign -Vm pure.app.tar.gz -p /tmp/pure.pub -s pure.app.tar.gz.sig
```

`Signature and comment signature verified` means the artifact is authentic and unmodified.

Alternatively, trust the release pipeline: the CI run only publishes when
`bun run gui:build` prints `Finished 1 updater signature at: …/pure.app.tar.gz.sig`
(SIGNING.md Step E), so a `.sig` asset attached to a green GitHub Release is valid by
construction.
