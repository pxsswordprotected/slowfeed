# Slow Feed — Design Spec (v1)

Goal for v1: as simple as possible. Look native to X. No animation. Make the core mechanism work first; polish comes later.

Read with `mains_spec_v1.md`.

---

## 1. Principles

- **Native to X.** Use X colors and X spacing. Slow Feed must look like an X feature, not a layer on top of X.
- **Minimal.** One timer bar, one blur, one toast, one small popup. Nothing else.
- **No animation in v1.** All state changes happen at once.
- **Scoped typography.** Use the locally bundled `PPNeueMontreal-Book.otf` for Slow Feed's popup and toast, with system fonts as fallback. Leave X's own typography unchanged. Colors come from the theme tokens below.

## 2. Theme support

X has three themes. Slow Feed must support all three.

| X theme | Page background | Detect by |
|---|---|---|
| Default (light) | `#FFFFFF` | `body` background color |
| Dim | `#15202B` | `body` background color |
| Lights out | `#000000` | `body` background color |

- While Slow Feed is On and the route is active, read `getComputedStyle(document.body).backgroundColor` on activation and route reconciliation. Observe body class/style changes to handle same-route theme changes, and rebind observation when the body is inserted or replaced.
- Set `data-slowfeed-theme="light" | "dim" | "dark"` on `<html>` for recognized opaque backgrounds: `#FFFFFF`, `#15202B`, and `#000000`, respectively. Transparent, translucent, or unrecognized colors retain the last recognized theme; before any recognized theme, use light tokens without setting a theme attribute.
- Off and inactive routes disconnect theme observation and remove the theme attribute.
- All Slow Feed CSS reads from these variables:

```css
:root[data-slowfeed-theme="light"] {
  --sf-accent: #1D9BF0;
  --sf-track: #EFF3F4;
  --sf-toast-bg: #1D9BF0;
  --sf-toast-text: #FFFFFF;
}
:root[data-slowfeed-theme="dim"] {
  --sf-accent: #1D9BF0;
  --sf-track: #38444D;
  --sf-toast-bg: #1D9BF0;
  --sf-toast-text: #FFFFFF;
}
:root[data-slowfeed-theme="dark"] {
  --sf-accent: #1D9BF0;
  --sf-track: #2F3336;
  --sf-toast-bg: #1D9BF0;
  --sf-toast-text: #FFFFFF;
}
```

`#1D9BF0` is the X blue. The track colors match the X border color in each theme.

## 3. Active tweet — timer bar

- A **2px bar** on the **top edge** of the active tweet `article`.
- Full width of the article.
- Track: `--sf-track`. Fill: `--sf-accent`.
- The fill goes from 0% to 100% width, left to right, over the timer length.
- Update the width with the timer (for example every 100ms, or with `requestAnimationFrame`). No CSS transition.
- No seconds label in v1.
- When the timer pauses, the bar stops. It does not change color.
- When the tweet becomes `read`, remove the bar.

Use an absolutely positioned child element so the bar does not change the tweet height.

## 4. Locked tweets — blur

```css
article[data-slowfeed-state="locked"] {
  filter: blur(8px);
  pointer-events: none;
  user-select: none;
}
```

- No overlay, no icon, no text on locked tweets.
- No opacity change. Blur only.
- Unlock: remove the attribute. The blur goes away at once.

## 5. Read tweets

- No change. They look like normal X tweets.

## 6. Scroll pushback — toast

Copy the X toast style.

- Position: fixed, bottom center, `24px` from the bottom of the viewport.
- Background: `--sf-toast-bg`. Text: `--sf-toast-text`.
- Font: PP Neue Montreal Book, `15px`, regular weight.
- Padding: `12px 16px`. Border radius: `4px`.
- Text: `Slow down. 42s left.` (number = seconds left on the active tweet, rounded up).
- Shows at once, stays for 2 seconds, then goes away at once.
- If the toast already shows, update the text and restart the 2 seconds. Do not stack toasts.
- `z-index` must be above the X header and bottom bar.

## 7. Popup (toolbar menu)

The popup is not on the X page, so it cannot read the X theme. Use `prefers-color-scheme`.

**Size:** `280px` wide. Height fits the content.

**Layout (top to bottom):**

1. **Header row:** text `Slow Feed`, `15px`, bold.
2. **On/off row:** label `On` on the left, a toggle switch on the right.
3. **Timer row:** label `Time per tweet` above a 3-option segmented control: `3s` · `30s` · `60s`. The 3-second choice replaces 15 seconds for faster testing.

**Style:**

- Font: `"sf-PPNeueMontreal", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`. The shared `font.css` loads the bundled Book face; retain the bold heading.
- Padding: `16px`. Gap between rows: `16px`.
- Light: background `#FFFFFF`, text `#0F1419`, secondary text `#536471`, borders `#EFF3F4`.
- Dark: background `#000000`, text `#E7E9EA`, secondary text `#71767B`, borders `#2F3336`.
- Toggle: on = `#1D9BF0` fill, off = border color fill. Round thumb, white.
- Segmented control: selected option = `#1D9BF0` fill with white text. Other options = transparent with border.
- Border radius: `9999px` for the toggle and the segmented control (X uses fully round buttons).
- When Slow Feed is **off**, the timer row shows at 50% opacity and does not take clicks.

## 8. Icon

- v1 placeholder: a solid X-blue (`#1D9BF0`) circle with a white `1` or a simple clock shape.
- Sizes: 16, 32, 48, 128 px.

## 9. Later (not v1)

- Unlock animation
- Seconds label or ring on the timer
- Custom colors or identity beyond X native
- Sound
