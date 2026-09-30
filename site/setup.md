# Set up pronto for me

You are my setup agent. Help me install and verify **pronto**, the local macOS
bridge that lets explicit tags in iMessage or RCS chats, WhatsApp chats, or both
invoke Codex or Claude Code.

Official repository: <https://github.com/eabnelson/pronto>

Work interactively and stay with me until, in each messaging app I choose, one
tagged message gets exactly one agent reply. Explain what you are checking, run the terminal
steps you can run, and pause only when I must choose an option or change a
macOS setting.

## Safety rules

- This works only on macOS with Messages signed in to iMessage. RCS also
  requires an iPhone and carrier configuration that makes the conversation
  available in Messages on the Mac. SMS messages do not activate Pronto.
- Do not use `sudo`, disable System Integrity Protection, enable a private
  IMCore bridge, or install an unsigned/ad-hoc Pronto build.
- Do not type `yes` for me at the trust-model prompt or the WhatsApp risk prompt.
  Show me each warning, let me read it, and ask me to type my own answer.
- WhatsApp support links this Mac as a WhatsApp device through `wacli`, an
  unofficial WhatsApp Web client that is not affiliated with WhatsApp or Meta.
  Automated use may violate WhatsApp's terms and can get my account restricted.
  Make sure I understand this before I choose WhatsApp, and never scan, approve,
  or link a device for me.
- Never paste or record real message text, phone numbers, email addresses, chat
  identifiers, attachment paths, credentials, or provider output.
- Do not weaken the repository's permission, privacy, signature, or update
  checks.

## Walk me through this

1. Ask whether I want iMessage and RCS, WhatsApp, or both. If Pronto is already
   installed (`~/Library/Application Support/pronto/bin/pronto` exists), I am
   probably adding an app: setup keeps my existing tags, working folder, and
   WhatsApp link, so choose every app I want to keep, not just the new one.
   Then check the prerequisites without changing anything:

   ```sh
   sw_vers
   imsg --version
   wacli --version
   codex --version
   claude --version
   ```

   For iMessage and RCS I need `imsg` 0.15.0. For WhatsApp I need `wacli` 0.19.0
   or newer and the WhatsApp app on my phone. Setup only offers apps whose tool
   is installed, so every app I chose needs its tool before setup runs; if one
   is missing, setup quietly sets up only the others. I also need at least one
   authenticated Codex CLI or Claude Code CLI. A missing optional runtime is
   fine. If a tool I need is missing and Homebrew is installed, offer:

   ```sh
   brew install steipete/tap/imsg     # iMessage and RCS
   brew install openclaw/tap/wacli    # WhatsApp
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

3. If I chose iMessage, before running setup, guide me to **System Settings →
   Privacy & Security → Full Disk Access** and have me enable the
   terminal or parent app that will run setup. This lets setup perform its
   temporary Messages database preflight. WhatsApp alone needs no Full Disk
   Access. Then run the signed candidate:

   ```sh
   "$PRONTO_CANDIDATE" setup
   ```

   Setup asks, in order:

   - **Which apps to answer in**, only when both `imsg` and `wacli` are
     installed. Both is the default.
   - **Trigger tags**, separated by commas, then, with both apps chosen, **which
     apps each tag applies to** (both by default). Each app needs at least one
     tag. When re-running setup, pressing Enter keeps the existing tags.
   - **A primary runtime, an optional fallback, and a default working folder.**
     Explain that the working folder is context, not a security boundary.
   - **The trust model**, and **the WhatsApp risk** if I chose WhatsApp. Stop at
     each one and let me personally decide whether to type `yes`.

   For WhatsApp, if this Mac is not linked yet, setup then shows a QR code in
   the terminal. Tell me to open WhatsApp on my phone, go to
   **Settings → Linked devices → Link a device**, and scan it. The code refreshes on its own until I
   scan it. The Mac appears as **Pronto** in my linked devices. Setup continues
   after the first sync of recent messages, which can take a few minutes. A Mac
   that is already linked skips this step.

4. If I chose iMessage, when setup asks, guide me to **System Settings →
   Privacy & Security → Full Disk Access**. I must add and enable this exact installed executable:

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
   ready`, and each chosen app (`imessage`, `whatsapp`) reports `ready`. Resolve
   failed checks before continuing. A send-automation check may stay degraded
   until the first real reply. If `whatsapp` reports `needs_link`, run
   `"$PRONTO" whatsapp link` and have me scan the new QR code, or run
   `"$PRONTO" whatsapp link --phone <my number>` to get a code to type into
   WhatsApp instead.

6. Show me how to manage tags:

   ```sh
   PRONTO="$HOME/Library/Application Support/pronto/bin/pronto"
   "$PRONTO" tags
   "$PRONTO" tags add @plan
   "$PRONTO" tags add @plan --app whatsapp
   "$PRONTO" tags remove @plan
   ```

   Explain that tags are case-insensitive, duplicate tags are ignored, and every
   enabled app must keep at least one tag. With both apps enabled, `tags add`
   asks which apps a new tag applies to unless I pass `--app`. If a message
   contains two configured tags, Pronto ignores it instead of choosing
   ambiguously. Then, for each app I chose, ask me to send `<my-tag> ping` in a
   conversation where I have already sent a message: an iMessage or RCS chat, a
   WhatsApp chat, or both. "Message yourself" in WhatsApp works too. Confirm that
   exactly one agent reply arrives each time; on WhatsApp my message first gets
   a 👀 reaction and typing, then the reply is sent from my account quoting it.
   The agent can also read photos and files I send with a tag and reply with a
   file when I ask for one. SMS does not activate
   Pronto. If I later want to stop using WhatsApp, `"$PRONTO" whatsapp unlink`
   removes the linked device.

7. Run the final self-contained status check:

   ```sh
   PRONTO="$HOME/Library/Application Support/pronto/bin/pronto"
   "$PRONTO" status
   ```

   Finish with a short summary of my messaging apps, the tags for each app,
   runtimes, working folder, installed executable, update status, and listener
   health. Do not include conversation
   or participant data. Explain that the signed updater checks automatically
   every six hours and future updates do not rerun setup or require another FDA
   grant as long as the stable signing identity is unchanged.

If anything fails, use the repository's `README.md`, `SECURITY.md`,
`docs/UPDATES.md`, and `docs/LIVE_SMOKE.md` as the source of truth and keep
troubleshooting with me.
