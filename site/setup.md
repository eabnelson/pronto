# Set up pronto for me

You are my setup agent. Help me install and verify **pronto**, the local macOS bridge that lets tags in iMessage or RCS chats invoke Codex or Claude Code.

Repository: <https://github.com/eabnelson/pronto>

Work interactively and stay with me until one tagged iMessage or RCS message gets exactly one agent reply. Explain what you are checking, run the terminal steps you can run, and pause only when I must choose an option or change a macOS setting.

## Safety rules

- This works only on macOS with Messages signed in to iMessage. RCS also requires an iPhone and carrier configuration that makes the conversation available in Messages on the Mac. SMS messages do not activate Pronto.
- Do not use `sudo`, disable System Integrity Protection, or enable a private IMCore bridge.
- Do not type `yes` for me at the trust-model prompt. Show me the warning, let me read it, and ask me to type my own answer.
- Never paste or record real message text, phone numbers, email addresses, chat identifiers, attachment paths, credentials, or provider output.
- Do not weaken the repository's permission, privacy, or release checks.

## Walk me through this

1. Check the prerequisites without changing anything:

   ```sh
   sw_vers
   git --version
   bun --version
   imsg --version
   codex --version
   claude --version
   ```

   I need Bun 1.3.14 or newer, `imsg` 0.14 or a capability-compatible version, and at least one authenticated Codex CLI or Claude Code CLI. A missing optional runtime is fine. If Bun or `imsg` is missing and Homebrew is installed, offer:

   ```sh
   brew install oven-sh/bun/bun steipete/tap/imsg
   ```

   If neither Codex nor Claude Code is installed and authenticated, stop and help me install and sign in to the one I choose before continuing.

2. Ask where I want the source checkout. Suggest `~/Developer/pronto`, resolve my answer to an absolute path, and use that exact path as `CHECKOUT`. Never leave the example value below unchanged.

   If the chosen path does not exist or is an empty directory, create a new checkout. Run this as one shell call after replacing the first value with the absolute path I chose:

   ```sh
   CHECKOUT="/absolute/path/I/chose"
   git clone https://github.com/eabnelson/pronto.git "$CHECKOUT"
   cd "$CHECKOUT"
   ```

   If the chosen path already contains files, do not overwrite it. Reuse it only when it is a Git checkout whose origin is exactly `https://github.com/eabnelson/pronto.git` or `git@github.com:eabnelson/pronto.git` and whose worktree is clean. Run these checks and the update as one shell call after replacing the first value with the absolute path I chose:

   ```sh
   CHECKOUT="/absolute/path/I/chose"
   cd "$CHECKOUT" || exit 1
   ORIGIN="$(git remote get-url origin)" || exit 1
   case "$ORIGIN" in
     https://github.com/eabnelson/pronto.git|git@github.com:eabnelson/pronto.git) ;;
     *) echo "Stop: the existing checkout does not have the official pronto origin." >&2; exit 1 ;;
   esac
   if [ -n "$(git status --porcelain)" ]; then
     echo "Stop: the existing checkout has local changes." >&2
     exit 1
   fi
   git pull --ff-only
   ```

   If any guard fails, stop and ask me to choose a fresh, empty directory. Only after the new clone or guarded update succeeds, install dependencies from the chosen checkout in one shell call:

   ```sh
   CHECKOUT="/absolute/path/I/chose"
   cd "$CHECKOUT" || exit 1
   bun install --frozen-lockfile
   ```

3. Before running setup, guide me to **System Settings → Privacy & Security → Full Disk Access** and have me enable the terminal or parent app that will run setup. This access is required for setup to inspect the local Messages database. Then start the interactive setup from the chosen checkout:

   ```sh
   CHECKOUT="/absolute/path/I/chose"
   cd "$CHECKOUT" || exit 1
   bun run packages/cli/src/cli.ts setup
   ```

   Help me choose:

   - one or more comma-separated trigger tags, with or without `@`;
   - a primary runtime;
   - an optional fallback runtime;
   - a default working folder, normally `~/pronto`.

   Explain that the working folder is context, not a security boundary. At the trust-model prompt, stop and let me personally decide whether to type `yes`.

4. When setup finishes, guide me to **System Settings → Privacy & Security → Full Disk Access**. I must add and enable this exact installed executable:

   ```text
   ~/Library/Application Support/pronto/bin/pronto
   ```

   If a stale pronto entry already exists, have me remove it and add the exact file again. Messages may also ask me to approve Automation on the first real reply.

5. Run the installed diagnostics with a safely quoted path and wait for the runtime probes to finish:

   ```sh
   PRONTO="$HOME/Library/Application Support/pronto/bin/pronto"
   "$PRONTO" doctor
   "$PRONTO" status
   ```

   A healthy service reports `listener running`, `database ready`, and `daemon ready`. Resolve failed checks before continuing. A send-automation check may stay degraded until the first real reply.

6. Show me how to manage tags from the installed CLI:

   ```sh
   PRONTO="$HOME/Library/Application Support/pronto/bin/pronto"
   "$PRONTO" tags
   "$PRONTO" tags add @plan
   "$PRONTO" tags remove @plan
   ```

   Explain that tags are case-insensitive, duplicate tags are ignored, and at least one tag must remain. If a message contains two different configured tags, the bridge ignores it instead of choosing ambiguously. Then ask me to send `<my-tag> ping` in an iMessage or RCS conversation where this Mac owner has already sent at least one message. Confirm that exactly one agent reply arrives. SMS does not activate Pronto. In a self-chat, Messages may display each single send as an incoming/outgoing mirrored pair; that is one send, not a duplicate.

7. Run the final status check with its executable assigned in the same shell call:

   ```sh
   PRONTO="$HOME/Library/Application Support/pronto/bin/pronto"
   "$PRONTO" status
   ```

   Finish with a short summary of my tags, primary and fallback runtimes, default working folder, installed executable, and whether the listener, database, and daemon are ready. Do not include conversation or participant data.

If anything fails, use the repository's `README.md`, `SECURITY.md`, and `docs/LIVE_SMOKE.md` as the source of truth and keep troubleshooting with me.
