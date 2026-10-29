# Recording the README demo GIF

A 25–35 second GIF at the top of the README shows people what the extension does before they read anything. Record it in your real VS Code, using the `muse-playground` folder.

## Setup (2 minutes)

1. **Tools:** [Kap](https://getkap.co) (macOS, free) or ScreenToGif (Windows). Set 15 fps.
2. **Clean window:** one VS Code window, nothing personal on screen, about 1280×800. Hide the minimap and close other panels.
3. **Reset the playground:** in `muse-playground`, run `git checkout . && git clean -fd`.
4. **Panel state:** open Muse Studio, click **New chat**, and set **Permissions: Ask me**. Pick a non-contributor model.
5. **Theme:** use VS Code's default Dark Modern so it matches the screenshots.

## Script (one take)

| Time | Do this | Shows off |
|---|---|---|
| 0–4 s | Open `src/math.js`, select the `divide` function | The `✂ math.js:5-7` chip appears |
| 4–9 s | Type: `Fix the divide-by-zero bug and add a test for @` then pick `src/math.js` from the popup | @-mentions |
| 9–20 s | Press Enter; let it stream | Thinking indicator, tool cards with icons, streamed reply |
| 20–26 s | When the **Muse changed 2 files** card appears, click **Diff** on `src/math.js` | Review before / after |
| 26–30 s | Back in the panel, click **Undo all** | Undo |

If an approval card appears, click **Allow once**. That's a bonus shot.

Speed up the waiting parts 2–3× in Kap's editor so the GIF stays under about 30 seconds and 8 MB.

## Add it to the README

1. Save it as `media/screenshots/demo.gif`.
2. In `README.md`, replace the first screenshot line with:
   ```md
   ![Muse Studio demo](media/screenshots/demo.gif)
   ```
3. Commit and push. The Marketplace and Open VSX pages pick it up on the next publish.

A real model run costs some of your Muse quota (about 5% of the 5-hour allowance per message), so do a dry run first with **muse.provider** set to `echo` to practice the clicks.
