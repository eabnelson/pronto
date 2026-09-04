# Set up pronto for me

You are my setup agent. Help me install and verify **pronto**, the local macOS
bridge that lets explicit tags in iMessage or RCS chats invoke Codex or Claude
Code.

Official repository: <https://github.com/eabnelson/pronto>

Work interactively and stay with me until one tagged iMessage or RCS message
gets exactly one agent reply. Explain what you are checking, run the terminal
steps you can run, and pause only when I must choose an option or change a
macOS setting.

## Safety rules

- This works only on macOS with Messages signed in to iMessage. RCS also
  requires an iPhone and carrier configuration that makes the conversation
  available in Messages on the Mac. SMS messages do not activate Pronto.
- Do not use `sudo`, disable System Integrity Protection, enable a private
  IMCore bridge, or install an unsigned/ad-hoc Pronto build.
- Do not type `yes` for me at the trust-model prompt. Show me the warning, let
  me read it, and ask me to type my own answer.
- Never paste or record real message text, phone numbers, email addresses, chat
  identifiers, attachment paths, credentials, or provider output.
- Do not weaken the repository's permission, privacy, signature, or update
  checks.

## Walk me through this

1. Check the prerequisites without changing anything:

   ```sh
   sw_vers
   imsg --version
   codex --version
   claude --version
   ```

   I need `imsg` 0.15.0 and at least one authenticated Codex CLI or Claude Code
   CLI. A missing optional runtime is fine. If `imsg` is missing and Homebrew is
   installed, offer:

   ```sh
   brew install steipete/tap/imsg
   ```

   If neither Codex nor Claude Code is installed and authenticated, stop and
   help me install and sign in to the one I choose before continuing.

2. Download the official binary for this Mac into a new temporary directory.
   Run this exact guarded shell block. Do not replace its URL, signing
   identifier, Team ID, or requirement:

   ```sh
   PRONTO_INSTALL_DIR="$(mktemp -d)" || exit 1
   case "$(uname -m)" in
     arm64) PRONTO_TARGET="darwin-arm64" ;;
     x86_64) PRONTO_TARGET="darwin-x64" ;;
     *) echo "Unsupported Mac architecture" >&2; exit 1 ;;
   esac
   PRONTO_CANDIDATE="$PRONTO_INSTALL_DIR/pronto"
   curl --fail --location --proto '=https' --tlsv1.2 \
     "https://github.com/eabnelson/pronto/releases/latest/download/pronto-$PRONTO_TARGET" \
     --output "$PRONTO_CANDIDATE" || exit 1
   chmod 700 "$PRONTO_CANDIDATE" || exit 1
   codesign --verify --strict \
     -R='identifier "dev.pronto.cli" and anchor apple generic and certificate leaf[subject.OU] = "9YCNUWK84C"' \
     "$PRONTO_CANDIDATE" || exit 1
   "$PRONTO_CANDIDATE" --version
   ```

   Stop if downloading, signature verification, or the version command fails.
   Never fall back to building from source for an ordinary installation.

3. Before running setup, guide me to **System Settings → Privacy & Security →
   Full Disk Access** and have me enable the terminal or parent app that will run setup.
   This lets setup perform its temporary Messages database preflight.
   Then run the signed candidate:

   ```sh
   "$PRONTO_CANDIDATE" setup
   ```

   Help me choose one or more trigger tags, a primary runtime, an optional
   fallback, and a default working folder. Explain that the working folder is
   context, not a security boundary. At the trust-model prompt, stop and let me
   personally decide whether to type `yes`.

4. When setup asks, guide me to **System Settings → Privacy & Security → Full
   Disk Access**. I must add and enable this exact installed executable:

   ```text
   ~/Library/Application Support/pronto/bin/pronto
   ```

   If a stale Pronto entry exists, remove it and add the exact file again.
   Messages may also ask me to approve Automation on the first real reply.
   After setup finishes, remove only the temporary candidate:

   ```sh
   unlink "$PRONTO_CANDIDATE"
   rmdir "$PRONTO_INSTALL_DIR"
   ```

5. Run the installed diagnostics and wait for runtime probes to finish:

   ```sh
   PRONTO="$HOME/Library/Application Support/pronto/bin/pronto"
   "$PRONTO" doctor
   "$PRONTO" status
   "$PRONTO" update --check
   ```

   A healthy service reports `listener running`, `database ready`, and `daemon
   ready`. Resolve failed checks before continuing. A send-automation check may
   stay degraded until the first real reply.

6. Show me how to manage tags:

   ```sh
   PRONTO="$HOME/Library/Application Support/pronto/bin/pronto"
   "$PRONTO" tags
   "$PRONTO" tags add @plan
   "$PRONTO" tags remove @plan
   ```

   Explain that tags are case-insensitive, duplicate tags are ignored, and at
   least one tag must remain. If a message contains two configured tags, Pronto
   ignores it instead of choosing ambiguously. Then ask me to send `<my-tag>
   ping` in an iMessage or RCS conversation where this Mac owner has already
   sent a message. Confirm that exactly one agent reply arrives. SMS does not
   activate Pronto.

7. Run the final self-contained status check:

   ```sh
   PRONTO="$HOME/Library/Application Support/pronto/bin/pronto"
   "$PRONTO" status
   ```

   Finish with a short summary of my tags, runtimes, working folder, installed
   executable, update status, and listener health. Do not include conversation
   or participant data. Explain that the signed updater checks automatically
   every six hours and future updates do not rerun setup or require another FDA
   grant as long as the stable signing identity is unchanged.

If anything fails, use the repository's `README.md`, `SECURITY.md`,
`docs/UPDATES.md`, and `docs/LIVE_SMOKE.md` as the source of truth and keep
troubleshooting with me.
