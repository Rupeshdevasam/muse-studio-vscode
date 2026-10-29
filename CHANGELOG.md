# Changelog

## 0.4.0

- **New look:** one rounded message box with the controls inside it, compact pickers for model, effort and permissions, and a round send button that becomes stop while Muse works.
- **Welcome screen** with starter prompts.
- **Code blocks** get syntax highlighting, a language label and a Copy button.
- **Tool cards** show an icon for the kind of tool (terminal, file, edit, search, web…) and a status mark.
- A "Thinking…" indicator at the end of the chat shows what Muse is doing, including when it's waiting for your approval or answer.
- The panel title now reads **Muse Studio**, and the ⋯ menu has Settings, Check Setup and Show Log.

## 0.3.0

- **@-mentions:** type `@` (or click @) to pick a file or folder. Mentioned files are attached to the message (up to 10 files, 200 KB each); folders send their listing.
- **Editor context:** a chip shows your open file and selection; it's sent with the message (selected code included). Click × to leave it out of one message. Setting: `muse.sendEditorContext`.
- **Images:** paste, drag-drop, or 📎 to attach up to 5 images (5 MB each).
- **Review and undo:** in git repositories, a card lists every file Muse changed during a run (including changes made by shell commands), with Diff and Undo per file and Undo all. Snapshots use a temporary git index and never touch your staging area, branches or stash. Setting: `muse.trackChanges`.
- Tool-card "Show diff" compares against the start of Muse's run when available.
- Shortcuts: Cmd+Alt+M (Ctrl+Alt+M) opens the chat; Cmd+Alt+L (Ctrl+Alt+L) adds the selection.
- New icon.

## 0.2.1

- Permission profiles replace the approval-mode picker: **Ask me** (new default: you approve restricted actions), **Auto-review** (Muse's AI reviewer decides when it can), **Read only**, **Unrestricted**.
- Open file / Show diff now sit under each edit card instead of inside the collapsed details.
- Long file paths in tool cards are shortened so the file name stays visible.

## 0.2.0

- Rebuilt on `muse serve` and the Muse Session Protocol instead of one `muse exec` per message.
- Approval cards: Allow once / Allow for this session / Reject (with feedback), plus "reviewing" and "allowed by …" lines.
- Approval mode, model and reasoning-effort pickers in the panel. Contributor models are labeled.
- Muse's questions shown as clickable options.
- Task list, context meter and 5-hour / weekly quota meter.
- Stop now interrupts the turn instead of killing the process; Esc also stops. Messages sent while Muse works are queued.
- Chats resume inside Muse after restarting VS Code.
- Chats saved by 0.1.x aren't shown (the storage format changed).

## 0.1.2

- Fix: Install and Sign in now run their command in a plain bash process instead of typing into your shell. Shell startup prompts (like zsh's compinit warning) could eat the first characters of the command.
- The panel also polls for a finished sign-in while the setup terminal is open.

## 0.1.1

- Setup check when the panel opens: finds the muse CLI (including ~/.local/bin when it isn't on PATH) and checks sign-in.
- Setup card with Install, Sign in, Use an API key, Choose file and Check again. The panel re-checks when the setup terminal closes or VS Code regains focus.
- Runs that fail because Muse isn't signed in now say so and show the Sign in card.

## 0.1.0

- First version: chat panel, streamed replies, tool cards, edited-file diffs, resumable sessions, Add Selection, Stop.
