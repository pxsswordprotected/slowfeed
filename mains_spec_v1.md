# Slow Feed — Spec (v1 draft)

A Chrome extension for X (Twitter). The user must stay on each tweet for a set time before the next tweet unlocks. The goal is to train attention instead of mindless scrolling.

---

## 1. Platform

- Manifest V3 Chrome extension. Must also work in Edge and Brave (Chromium).
- Content script matches:
  - `https://x.com/*`
  - `https://twitter.com/*`
- Popup UI opens from the extension icon in the browser toolbar.
- No backend, no network calls, no analytics.

## 2. Pages where the extension is active

X is a single-page app. The URL changes without a page reload. The content script must watch for URL changes (patch `history.pushState` / `replaceState` and listen to `popstate`) and turn itself on or off for each route.

**Active on (feed screens):**

| Route | Screen |
|---|---|
| `/home` | Home timeline (For You and Following tabs) |
| `/search*` | Search results |
| `/explore*` | Explore |
| `/i/lists/*` | Lists |
| `/i/communities/*` | Communities |

**Not active on:**

- `/notifications*`
- `/messages*`
- `/settings/*`
- `/i/bookmarks`
- `/<username>/status/<id>` (a single tweet and its replies)
- Profile pages: `/<username>` and its subpages (`/with_replies`, `/media`, `/likes`, etc.)
- Any other route not in the active list

When the user goes from an active route to an inactive route, the script removes all blur, overlays, and scroll limits at once.

## 3. Core behavior

### 3.1 Tweet detection

- Each tweet is `article[data-testid="tweet"]`.
- The stable tweet ID is the number in the first `a[href*="/status/"]` link inside the article.
- X removes off-screen tweets from the DOM (virtualized list). Track state by tweet ID, not by element.
- Use a `MutationObserver` on the timeline to find new tweets as X adds them.
- Distinguish virtualization from a removed row. If a previously occupied native cell remains connected but is empty and collapsed to zero height, and a nonzero-height tweet cell now occupies the same position, remove the former ID from the current feed order. It must not block completion or leave the next real tweet locked.
- Retain that ID's record and any partial timer for a later remount; do not falsely mark it read. Detached cells, reserved-height cells, incomplete articles, and hidden/zero-height list layouts are not evidence of a removed row and continue to wait normally.

### 3.2 Tweet states

Each tweet has one of three states:

| State | Meaning | Look |
|---|---|---|
| `read` | Timer finished, or skipped earlier on activation | Normal |
| `active` | Current tweet; timer advances only while eligible | Normal, with a visible timer |
| `locked` | Not reached yet | Blurred |

- The **active** tweet is the first tweet in feed order that is not `read`.
- Only one tweet is `active` at a time.
- `read` tweets stay unblurred. The user can scroll back up and read them freely.
- State resets when the page reloads. Keep it in memory per tab for v1.

### 3.3 Timer

- Default length: **60 seconds**. The user can pick 3, 30, or 60 in the popup. The 3-second option replaces 15 seconds for faster testing.
- The timer runs only when all these conditions are true:
  - The tab is visible (`document.visibilityState === "visible"`).
  - The active article is connected, has nonzero size, and overlaps the viewport horizontally.
  - Below the measured X header, at least half of the smaller of the tweet height and usable viewport height is visible. This viewport-relative threshold lets tweets taller than two viewports accumulate reading time.
- The timer pauses when a condition becomes false. It continues from the same point when the conditions are true again. It does not restart.
- Accumulate reading time with `performance.now()` and update progress every 100ms while eligible; do not use a wall-clock completion deadline. Hidden, off, inactive, absent, or insufficiently visible time is not credited.
- Capture a tweet's duration on its first activation. Automatic prepends preserve a partial tweet's duration and elapsed time. Clicking the new-post button instead discards the old session and starts a fresh timer using the current setting.
- When the timer ends:
  1. The active tweet becomes `read`.
  2. The first remaining unread ID in feed order becomes `active`, and its blur goes away at once. If that ID is absent or insufficiently visible, its timer waits.
  3. The page does not scroll by itself. The user scrolls when ready.

### 3.4 Timer display

- Show one full-width, absolutely positioned **2px bar at the top edge** of the active article, without changing its height.
- The fill goes from 0% to 100% over the captured duration. No CSS transition, animation, or seconds label.
- Pauses stop the fill; DOM remounts restore the accumulated progress. Becoming read, off, or inactive removes the bar.
- The display must be visible in a screen recording without sound.

### 3.5 Locked look

- Locked tweets get `filter: blur(8px)` (tune by eye).
- Locked tweets must not take clicks: no likes, replies, links, or media playback. Use `pointer-events: none` on the article, or a transparent overlay.
- Blur must not change the tweet height. The layout must not jump.

### 3.6 Scroll pushback

- The user cannot scroll down past the active tweet.
- Ordinary-tweet limit: align the active article's top with the measured bottom of X's header. Tall-tweet limit: also allow its bottom to align with the viewport bottom. Use the larger limit, clamped to zero, and recompute from live geometry.
- Scrolling up is always allowed, even if an automatic prepend or resize lowers the limit above the current scroll position. Ordinary activation, completion, and geometry changes do not themselves scroll; clicking the new-post button explicitly starts over at the refreshed top tweet.
- Reject downward wheel/trackpad attempts that would exceed the limit. Normalize pixel/line/page deltas; leave upward, horizontal, and zoom gestures untouched.
- A capture scroll handler instantly corrects downward overshoots from native keyboard movement, scrollbar dragging, and X-initiated scrolling. Fractional limits round down to avoid crossing the boundary.
- Space, Page Down, and Arrow Down remain native below the boundary and are blocked at it. Shift+Space, Page Up, Arrow Up, and `k` stay usable upward. Editable fields, composition, modifiers, and native button/link Space activation are not intercepted by the keyboard guard.
- Allow `j` to read/active targets; block a later locked target. Restore focus from a locked article to the last allowed connected article without scrolling, with the scroll handler as the authoritative backstop.
- With no connected active article, suspend the fence and timer until remount; never use detached geometry or advance to another ID.
- Show one fixed bottom-center toast, 24px from the bottom: `Slow down. 42s left.` Remaining seconds round up. Use the design's 15px regular text, 12px/16px padding, 4px radius, blue background, white text, and no animation.
- New toast appearances are at least two seconds apart. Repeated blocked attempts update the existing toast and restart its two-second expiry; never stack. Off/inactive routes and active-tweet completion remove it immediately.

## 4. Popup (toolbar menu)

The popup opens from the extension icon in the browser toolbar. It does not show on the X page itself.

Contents:

1. **On/off switch.** Turns Slow Feed on or off for all X tabs.
2. **Timer length.** Three options: `3s`, `30s`, `60s`. Default `60s`.

Rules:

- Store settings in `chrome.storage.sync`: `{ enabled: boolean, timerSeconds: 3 | 30 | 60 }`. Unsupported saved durations, including the old 15-second choice, use the 60-second default until the user selects a current option.
- Open X tabs apply changes at once through `chrome.storage.onChanged`. No reload needed.
- When the user turns Slow Feed **off**, remove all blur, timers, overlays, and scroll limits.
- When the user turns it **on**, the first tweet that is visible becomes `active`.
- When the user changes the timer length, the new length applies to the next tweet. The current timer continues with its old length.

## 5. Out of scope for v1

- Stats or share card
- Daily tweet budget
- Sounds
- Mobile, Safari, Firefox
- Saving read state across page reloads

## 6. Resolved v1 choices

These choices include the user's clarifications approved before implementation.

1. **Promoted tweets (ads).** Treat them like normal tweets, including locked/active/read states and an ordinary timer. No ad classifier.
2. **"Show N posts" / "See new posts" button.** Start over: discard old read IDs and partial timers, wait for the refreshed list, select its first tweet as `active`, and scroll its top below X's header. All remaining tweets start locked/blurred. Do not preserve the old position or return to the old timer. Automatic prepends without a button click retain the existing preemption behavior.
3. **Switching between For You and Following tabs.** Reset state? [Yes, reset.]
4. **Threads in the feed** (X groups some replies under a tweet). One timer per article, or one per thread? [One per article.]
5. **Inline "Show more" on long tweets.** No special handling. [None.]
6. **Activation partway down the feed.** Start at the first visible unread tweet; earlier tweets count as skipped/read.
7. **Session retention.** Keep only the current feed in tab memory until reload. Off/on and inactive detours retain it; changing active route/query, changing feed tab, or clicking the new-post button resets it.

## 7. Files

```
manifest.json
content.js        # route detection, tweet tracking, timer, blur, pushback
route.js          # MAIN-world History API bridge
content.css       # scoped blur, progress bar, toast, theme tokens
font.css          # shared namespaced PP Neue Montreal Book font-face
PPNeueMontreal-Book.otf # bundled default font for Slow Feed UI only
popup.html
popup.js
popup.css
icons/            # 16, 32, 48, 128 px
home_source_2.html # saved Home timeline DOM reference
TL_source.html    # saved timeline DOM reference, including videos
explore_source.html # saved Search timeline DOM reference
```

## 8. Test checklist

- [ ] Extension turns on for each route in the active list, and only those routes.
- [ ] Moving from `/home` to a profile removes all effects with no reload.
- [ ] Only one tweet is active at a time.
- [ ] The timer pauses when the tab is hidden and continues when it is visible.
- [ ] Scroll down past the active tweet snaps back and shows the toast.
- [ ] Keyboard scroll (Space, Page Down, `j`) is also stopped.
- [ ] Locked tweets cannot be clicked.
- [ ] Scrolling up to read tweets works with no limit.
- [ ] A read tweet stays unblurred after X removes it from the DOM and adds it back.
- [ ] Popup on/off works in all open X tabs at once.
- [ ] Popup timer change applies to the next tweet.

## 9. Implementation status

- Stages 1–6 implemented: popup/settings, SPA routes, ID-based tweet states and guards, reading timers/progress, the geometry-based scroll fence with pushback toast, and X theme detection.
- Effective defaults are On and 60 seconds. Only changed settings are written to `chrome.storage.sync`; Off disables the timer choices without changing the saved duration.
- Load this directory through `chrome://extensions` → Developer mode → Load unpacked. Open the popup to choose On/off and 3/30/60 seconds; close and reopen it to check persistence.
- Route initialization, actual URL changes, and effective On/off changes log exactly `active` or `inactive` in the X tab console. Same-URL History calls are deduplicated. Feed identity is pathname plus query; inactive detours retain the last feed identity.
- After an extension update, click Reload in `chrome://extensions` and reload existing X tabs once. Navigate between Home, Search, Explore, Lists, Communities, and inactive pages with DevTools Console open; popup changes require no page reload.
- On an active feed, `.sf-active` identifies the single connected active article. Only locked articles have `data-slowfeed-state="locked"` and blur(8px); read/skipped articles have no visual changes. Off/inactive routes remove the attributes/classes and input/media guards.
- ID records survive DOM removal and node recycling. Ordinary off-screen active IDs pause without advancing. Confirmed collapsed/replaced rows leave the current order without losing their ID record or earned time. Feed-tab/query resets wait for new timeline content instead of assigning the old list to the new session.
- Clicking new posts clears the old session, waits for incoming timeline content, and starts the first refreshed tweet with zero elapsed time. It scrolls that tweet's top below the header, blurs all others, and attaches a fresh scroll fence. A temporarily incomplete first article waits for its valid ID instead of activating the second article.
- Automatic prepends still preserve partial timers and use a separate new-prefix geometry boundary to keep later new arrivals out of the old skipped region. Ordinary active-ID virtualization continues to pause until remount.
- After preemption leaves the viewport past a new fence, equal positive content/scroll shifts within one CSS pixel are treated as layout compensation, not downward navigation. Actual downward input and unmatched programmatic scrolling still enforce the fence.
- Timers advance only for a visible tab and an eligible connected active article. Completion removes the bar, marks the ID read, and unlocks the first remaining unread ID without scrolling or moving focus.
- While On and on an active route, content UI detects the computed body background as light, dim, or dark. Detection runs on activation, route reconciliation, body replacement/insertion, and body class/style changes; Off/inactive routes disconnect theme observation and remove the theme attribute.
- Timer smoke checks exercised real elapsed time, actual visible/hidden tab transitions, sticky-header occlusion, tall tweets, remounts, off/inactive pauses, duration changes, preemption, and unchanged completion scroll position. Fixture layout CSS is not proof of authenticated live-X header geometry.
- Scroll smoke checks exercised trusted wheel and repeated compositor gestures, actual scrollbar dragging, native Space/Page Down/arrows, fixture j/k navigation and focus restoration, editable fields, tall tweets, header resize, virtualization, prepend limits, toast expiry/rate limiting, completion cleanup, and off/inactive restoration.
- Theme smoke checks exercised all three exact palettes, same-route class/style changes, missing/replaced bodies, transparent/translucent/unrecognized colors, off/inactive restoration, and popup system-theme independence. Initial unrecognized colors use scoped light tokens without inventing a theme; later unrecognized colors retain the last recognized theme. Progress and toast surfaces were inspected in Chrome with fixture layout CSS.
- Current Chrome smoke run passed 84 behavioral checks, including `newest_one.html` in a simulated X refresh: trusted new-post click, first tweet selected/aligned, all five others locked, fresh wheel/keyboard/programmatic fence, real popup selection and persistence of 3 seconds, and actual 3-second completion without auto-scroll. Additional checks covered delayed first IDs, repeated refresh of previously read IDs, tall-tweet limits, 3-second hidden/off pause and resume, virtualization, route transitions, and automatic prepends. Chrome reported no manifest or runtime errors. Fixture geometry is not proof of authenticated live-X layout.
- Collapsed-row handoff regression: `newest_one_stopped.html` contains an empty cell and the first locked tweet at the same `translateY(4315.91px)`. A capture-based Chrome simulation reproduced completion selecting the missing cached ID, losing its bar, and detaching the fence before the fix. After the fix, real 3/30/60-second completion unlocked the real successor with one progress bar, unchanged completion scroll position, and a working fence. Additional checks covered active-row removal, partial-timer/duration restoration on return, ordinary detached cells, reserved slots, incomplete IDs, hidden lists, and zero-height layout transitions. The successor's clear state, later blur, and painted blue 2px progress fill were inspected.
- Typography: the popup and toast use bundled PP Neue Montreal Book through `font.css`; X text is unchanged. Only the Book asset is web-accessible, limited to X/Twitter matches, so content UI can load it locally without a remote font service. Chrome's rendered-font inspection confirmed the actual custom `PPNeueMontreal-Book` face in the popup and toast, not a fallback; light/dark popup and toast surfaces were inspected, and off/inactive cleanup retained native tweet typography.
- Physical trackpad behavior, authenticated live-X appearance/shortcut sequences, and route-specific live header geometry still require manual verification. The supplied Search fixture is not a genuine Explore/List/Community fixture.
