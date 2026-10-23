(() => {
  "use strict";

  const defaults = { enabled: true, timerSeconds: 60 };
  const revisions = { enabled: 0, timerSeconds: 0 };
  let settings = { ...defaults };
  const routeState = { href: null, effective: null, feedKey: null, tabKey: null };
  let settingsLoaded = false;
  const tweetSelector = 'article[data-testid="tweet"]';
  let session = createFeedSession(null);
  let primaryColumn = null;
  let timeline = null;
  let connectedArticles = new Map();
  let firstArticles = new Map();
  let cellTweetIds = new WeakMap();
  let lastPositions = new Map();
  let lastPostStart = 0;
  let lifecycleObserver = null;
  let timelineObserver = null;
  let headerObserver = null;
  let reconciliationQueued = false;
  let lifecycleGeneration = 0;
  let needsVisibleStart = false;
  let pendingFeedChange = null;
  let needsTopStart = false;
  let timerHandle = null;
  let timerRunning = false;
  let lastClockSample = 0;
  let geometryObserver = null;
  let geometryNodes = new Set();
  let headerElements = [];
  let headerCandidatesDirty = true;
  let fenceAttached = false;
  let previousScrollY = window.scrollY;
  let fenceTweetId = null;
  let fenceTweetTop = 0;
  let previousScrollLimit = 0;
  let correctingScroll = false;
  let lastAllowedArticle = null;
  let restoringFocus = false;
  let pushbackToast = null;
  let toastHandle = null;
  let lastToastAppearance = -Infinity;
  let themeObserver = null;
  let themeBody = null;
  let lastDetectedTheme = null;

  function normalizeSettings(values) {
    return {
      enabled: typeof values.enabled === "boolean" ? values.enabled : defaults.enabled,
      timerSeconds: [3, 30, 60].includes(values.timerSeconds)
        ? values.timerSeconds
        : defaults.timerSeconds
    };
  }

  async function loadSettings() {
    const beforeRead = { ...revisions };
    try {
      const stored = normalizeSettings(await chrome.storage.sync.get(defaults));
      for (const key of Object.keys(defaults)) {
        if (revisions[key] === beforeRead[key]) settings[key] = stored[key];
      }
      settingsLoaded = true;
      reconcileRoute();
    } catch (error) {
      console.error("Slow Feed settings read failed:", error);
    }
  }

  function onStorageChanged(changes, areaName) {
    if (areaName !== "sync") return;
    for (const key of Object.keys(defaults)) {
      if (!Object.hasOwn(changes, key)) continue;
      revisions[key] += 1;
      settings[key] = normalizeSettings({ [key]: changes[key].newValue })[key];
    }
    if (settingsLoaded) reconcileRoute();
  }

  function isFeedRoute(pathname) {
    if (pathname === "/home") return true;
    return ["/search", "/explore", "/i/lists", "/i/communities"].some(prefix =>
      pathname === prefix || pathname.startsWith(`${prefix}/`)
    );
  }

  function reconcileRoute() {
    const url = new URL(location.href);
    const eligible = isFeedRoute(url.pathname);
    const effective = settings.enabled && eligible;
    const changedUrl = routeState.href !== url.href;
    const changedState = routeState.effective !== effective;

    if (eligible) {
      const feedKey = url.pathname + url.search;
      if (routeState.feedKey !== feedKey) resetFeedState(feedKey);
      routeState.feedKey = feedKey;
    }
    const wasEffective = routeState.effective;
    routeState.href = url.href;
    routeState.effective = effective;
    if (changedUrl || changedState) console.log(effective ? "active" : "inactive");
    if (effective && !wasEffective) activateFeed();
    else if (!effective && wasEffective) deactivateFeed();
    else if (effective && changedUrl) scheduleReconciliation();
  }

  function onRouteSignal() {
    if (!settingsLoaded || location.href === routeState.href) return;
    reconcileRoute();
  }

  function createFeedSession(feedKey) {
    return {
      feedKey,
      tweets: new Map(),
      orderedIds: [],
      activeId: null,
      activationBoundary: null,
      prependBoundary: null
    };
  }

  function resetFeedState(feedKey) {
    pauseTimer();
    detachScrollFence();
    removePushbackToast();
    lastAllowedArticle = null;
    const oldTimeline = timeline ?? findTimeline(findPrimaryColumn());
    const oldArticles = oldTimeline ? [...oldTimeline.querySelectorAll(tweetSelector)] : [];
    if (session.tweets.size && oldArticles.length) {
      pendingFeedChange = {
        timeline: new WeakRef(oldTimeline),
        articles: new WeakSet(oldArticles),
        ids: new Set(oldArticles.map(getTweetId).filter(Boolean)),
        firstId: getTweetId(oldArticles[0]),
        firstTop: oldArticles[0].getBoundingClientRect().top - oldTimeline.getBoundingClientRect().top
      };
    }
    clearArticleEffects();
    session = createFeedSession(feedKey);
    cellTweetIds = new WeakMap();
    routeState.tabKey = null;
    lastPositions.clear();
    needsTopStart = false;
    needsVisibleStart = true;
  }

  function activateFeed() {
    needsVisibleStart = true;
    previousScrollY = window.scrollY;
    lifecycleGeneration += 1;
    lifecycleObserver = new MutationObserver(onFeedMutations);
    lifecycleObserver.observe(document, { childList: true, subtree: true });
    geometryObserver = new ResizeObserver(onGeometryResize);
    themeObserver = new MutationObserver(onThemeMutations);
    syncThemeBody();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("scroll", onViewportChange, { capture: true, passive: true });
    window.addEventListener("resize", onViewportChange);
    document.addEventListener("click", onFeedClick, true);
    document.addEventListener("dblclick", onLockedInteraction, true);
    document.addEventListener("auxclick", onLockedInteraction, true);
    document.addEventListener("pointerdown", onLockedInteraction, true);
    document.addEventListener("keydown", onLockedKeydown, true);
    document.addEventListener("play", onMediaPlay, true);
    scheduleReconciliation();
  }

  function deactivateFeed() {
    pauseTimer();
    detachScrollFence();
    removePushbackToast();
    geometryObserver?.disconnect();
    geometryObserver = null;
    geometryNodes.clear();
    headerElements = [];
    headerCandidatesDirty = true;
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("scroll", onViewportChange, true);
    window.removeEventListener("resize", onViewportChange);
    lifecycleGeneration += 1;
    reconciliationQueued = false;
    lifecycleObserver?.disconnect();
    timelineObserver?.disconnect();
    headerObserver?.disconnect();
    lifecycleObserver = null;
    timelineObserver = null;
    headerObserver = null;
    themeObserver?.disconnect();
    themeObserver = null;
    themeBody = null;
    document.removeEventListener("click", onFeedClick, true);
    document.removeEventListener("dblclick", onLockedInteraction, true);
    document.removeEventListener("auxclick", onLockedInteraction, true);
    document.removeEventListener("pointerdown", onLockedInteraction, true);
    document.removeEventListener("keydown", onLockedKeydown, true);
    document.removeEventListener("play", onMediaPlay, true);
    clearArticleEffects();
    document.documentElement?.removeAttribute("data-slowfeed-enabled");
    document.documentElement?.removeAttribute("data-slowfeed-theme");
    primaryColumn = null;
    timeline = null;
    lastPositions.clear();
    needsTopStart = false;
  }

  function clearArticleEffects() {
    for (const article of connectedArticles.keys()) removeArticleEffects(article);
    connectedArticles.clear();
    firstArticles.clear();
  }

  function removeArticleEffects(article) {
    article.removeAttribute("data-slowfeed-state");
    if (article.classList.contains("sf-active")) article.classList.remove("sf-active");
    removeProgress(article);
  }

  function isOwnedNode(node) {
    return node instanceof Element &&
      (node.matches(".sf-progress, .sf-progress-fill, .sf-toast") ||
        Boolean(node.closest(".sf-progress, .sf-toast")));
  }

  function onFeedMutations(mutations) {
    const relevant = mutations.some(mutation => {
      if (isOwnedNode(mutation.target)) return false;
      if (mutation.type === "attributes") return true;
      return [...mutation.addedNodes, ...mutation.removedNodes].some(node => !isOwnedNode(node));
    });
    if (relevant) {
      if (mutations.some(mutation => !isOwnedNode(mutation.target) &&
          (!timeline?.contains(mutation.target) ||
            (mutation.target instanceof Element &&
              !mutation.target.closest(`${tweetSelector}, [data-testid="cellInnerDiv"]`))))) {
        headerCandidatesDirty = true;
      }
      scheduleReconciliation();
    }
  }

  function scheduleReconciliation() {
    if (reconciliationQueued || !routeState.effective) return;
    reconciliationQueued = true;
    const generation = lifecycleGeneration;
    queueMicrotask(() => {
      if (generation !== lifecycleGeneration) return;
      reconciliationQueued = false;
      if (routeState.effective) reconcileFeed();
    });
  }

  function findPrimaryColumn() {
    return document.querySelector('[data-testid="primaryColumn"]');
  }

  function findTimeline(primary) {
    if (!primary) return null;
    const article = primary.querySelector(tweetSelector);
    const region = article?.closest('[aria-label^="Timeline:"]');
    if (region && primary.contains(region)) return region;
    return article ? primary : primary.querySelector('[aria-label^="Timeline:"]');
  }

  function bindFeedElements(primary, nextTimeline) {
    if (primaryColumn !== primary) {
      headerObserver?.disconnect();
      headerCandidatesDirty = true;
      primaryColumn = primary;
      if (primary) {
        headerObserver = new MutationObserver(onFeedMutations);
        headerObserver.observe(primary, {
          attributes: true,
          subtree: true,
          attributeFilter: ["aria-selected", "style", "class"]
        });
      }
    }
    if (timeline !== nextTimeline) {
      timelineObserver?.disconnect();
      timeline = nextTimeline;
      if (timeline) {
        timelineObserver = new MutationObserver(onFeedMutations);
        timelineObserver.observe(timeline, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["href"]
        });
      }
    }
  }

  function getSelectedTab(primary) {
    if (!primary) return null;
    const tabs = [...primary.querySelectorAll('[role="tab"]')].filter(tab =>
      !tab.closest('[data-testid="toolBar"]') && !tab.closest(tweetSelector)
    );
    const selected = tabs.find(tab => tab.getAttribute("aria-selected") === "true");
    if (!selected) return null;
    const link = selected.matches("a[href]") ? selected : selected.querySelector("a[href]");
    if (link) return link.getAttribute("href");
    return `${selected.textContent.trim().replace(/\s+/g, " ")}:${tabs.indexOf(selected)}`;
  }

  function reconcileFeed() {
    document.documentElement?.setAttribute("data-slowfeed-enabled", "true");
    syncThemeBody();
    const primary = findPrimaryColumn();
    const nextTimeline = findTimeline(primary);
    const tabKey = getSelectedTab(primary);
    if (tabKey !== null) {
      if (routeState.tabKey !== null && routeState.tabKey !== tabKey) {
        resetFeedState(routeState.feedKey);
      }
      routeState.tabKey = tabKey;
      session.feedKey = JSON.stringify([routeState.feedKey, tabKey]);
    }
    bindFeedElements(primary, nextTimeline);
    reconcileTweets();
    refreshHeaderElements();
    syncGeometryObserver();
    updateTimer(performance.now());
    syncScrollFence();
  }

  function syncThemeBody() {
    if (themeBody !== document.body) {
      themeObserver?.disconnect();
      themeBody = document.body;
      if (themeBody) {
        themeObserver?.observe(themeBody, {
          attributes: true,
          attributeFilter: ["class", "style"]
        });
      }
    }
    detectTheme();
  }

  function onThemeMutations() {
    detectTheme();
  }

  function detectTheme() {
    if (!routeState.effective || !document.body) return;
    const color = getComputedStyle(document.body).backgroundColor.match(/^rgba?\(([^)]+)\)$/i);
    const channels = color ? color[1].trim().split(/[,\s/]+/).map(Number) : [];
    const opaque = channels.length === 3 || (channels.length === 4 && channels[3] === 1);
    const key = opaque ? channels.slice(0, 3).join(",") : null;
    const theme = {
      "255,255,255": "light",
      "21,32,43": "dim",
      "0,0,0": "dark"
    }[key];
    if (theme) lastDetectedTheme = theme;
    if (lastDetectedTheme) {
      document.documentElement?.setAttribute("data-slowfeed-theme", lastDetectedTheme);
    }
  }

  function getTweetId(article) {
    const anchor = article.querySelector('a[href*="/status/"]');
    if (!anchor) return null;
    try {
      const pathname = new URL(anchor.getAttribute("href"), location.href).pathname;
      return pathname.match(/\/status\/(\d+)(?:\/|$)/)?.[1] ?? null;
    } catch {
      return null;
    }
  }

  function getTimelineTop(article) {
    return article.getBoundingClientRect().top - timeline.getBoundingClientRect().top;
  }

  function getLiveEntries() {
    if (!timeline) return [];
    return [...timeline.querySelectorAll(tweetSelector)].flatMap(article => {
      const id = getTweetId(article);
      return id ? [{ article, id, top: getTimelineTop(article) }] : [];
    });
  }

  function isWaitingForFeed(entries) {
    if (!pendingFeedChange) return false;
    if (!entries.length) return true;
    const arrived = timeline !== pendingFeedChange.timeline.deref() ||
      entries.some(entry => !pendingFeedChange.articles.has(entry.article) ||
        !pendingFeedChange.ids.has(entry.id)) ||
      (needsTopStart && (entries[0].id !== pendingFeedChange.firstId ||
        Math.abs(entries[0].top - pendingFeedChange.firstTop) > 0.5));
    if (arrived) pendingFeedChange = null;
    return !arrived;
  }

  function updateActivationBoundary(entries) {
    const boundary = session.activationBoundary;
    if (!boundary) return;
    const anchor = entries.find(entry => entry.id === boundary.anchorId);
    if (!anchor) return;
    boundary.top += anchor.top - boundary.lastAnchorTop;
    boundary.lastAnchorTop = anchor.top;
  }

  function findPrependedIds(entries) {
    const anchorIndex = entries.findIndex(entry => lastPositions.has(entry.id));
    if (anchorIndex < 1) return [];
    const anchor = entries[anchorIndex];
    const oldPositions = lastPositions;
    const oldTop = oldPositions.get(anchor.id) ?? anchor.top;
    const movedDown = anchor.top > oldTop + 0.5;
    if (!movedDown) return [];
    const ids = entries.slice(0, anchorIndex)
      .filter(entry => !session.tweets.has(entry.id))
      .map(entry => entry.id);
    if (ids.length) {
      const boundary = session.activationBoundary;
      if (boundary && !entries.some(entry => entry.id === boundary.anchorId)) {
        const displacement = anchor.top - oldTop;
        boundary.top += displacement;
        boundary.lastAnchorTop += displacement;
      }
      rememberPrependBoundary(anchor, new Set(session.tweets.keys()),
        oldPositions, lastPostStart);
    }
    return ids;
  }

  function rememberPrependBoundary(anchor, oldIds, positions, start) {
    const oldTop = anchor ? positions.get(anchor.id) : undefined;
    const displacement = oldTop === undefined ? 0 : anchor.top - oldTop;
    session.prependBoundary = {
      top: anchor ? oldTop === undefined ? anchor.top : start + displacement : null,
      fallbackId: oldTop === undefined ? anchor?.id ?? null : null,
      start,
      displacement,
      positions,
      oldIds,
      ids: new Set()
    };
  }

  function updatePrependBoundary(entries) {
    const boundary = session.prependBoundary;
    if (!boundary) return;
    const anchor = entries.find(entry => boundary.positions.has(entry.id));
    if (!anchor) {
      const fallback = entries.find(entry => entry.id === boundary.fallbackId);
      if (fallback) boundary.top = fallback.top;
      return;
    }
    const displacement = anchor.top - boundary.positions.get(anchor.id);
    const skipped = session.activationBoundary;
    if (skipped && !entries.some(entry => entry.id === skipped.anchorId)) {
      const change = displacement - boundary.displacement;
      skipped.top += change;
      skipped.lastAnchorTop += change;
    }
    boundary.displacement = displacement;
    boundary.top = boundary.start + displacement;
  }

  function isInNewPostPrefix(id, top) {
    const boundary = session.prependBoundary;
    return Boolean(boundary && !boundary.oldIds.has(id) &&
      (boundary.top === null || top < boundary.top));
  }

  function getPostStart(article) {
    const container = article?.closest('[data-testid="cellInnerDiv"]')?.parentElement;
    if (!container || !timeline) return 0;
    let start = container.getBoundingClientRect().top;
    for (const cell of container.children) {
      if (!cell.matches('[data-testid="cellInnerDiv"]')) continue;
      const rect = cell.getBoundingClientRect();
      if (rect.top > start + 1 || cell.querySelector(tweetSelector)) break;
      start = Math.max(start, rect.bottom);
    }
    return start - timeline.getBoundingClientRect().top;
  }

  function mergeFeedOrder(ids) {
    const order = session.orderedIds;
    let previous = null;
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index];
      let position = order.indexOf(id);
      if (position < 0) {
        const next = ids.slice(index + 1).find(candidate => order.includes(candidate));
        position = next ? order.indexOf(next) : previous ? order.indexOf(previous) + 1 : order.length;
        if (!next && !previous && session.prependBoundary?.ids.has(id)) {
          const firstOld = order.findIndex(candidate => !session.prependBoundary.ids.has(candidate));
          if (firstOld >= 0) position = firstOld;
        }
        order.splice(position, 0, id);
      } else if (previous && position < order.indexOf(previous)) {
        order.splice(position, 1);
        order.splice(order.indexOf(previous) + 1, 0, id);
      }
      previous = id;
    }
  }

  function reconcileCollapsedCells(entries) {
    if (!timeline) return;
    for (const { article, id } of entries) {
      const cell = article.closest('[data-testid="cellInnerDiv"]');
      if (cell) cellTweetIds.set(cell, id);
    }
    const retiredIds = new Set();
    for (const cell of timeline.querySelectorAll('[data-testid="cellInnerDiv"]')) {
      const id = cellTweetIds.get(cell);
      if (!id || firstArticles.has(id) || cell.childElementCount) continue;
      const rect = cell.getBoundingClientRect();
      if (rect.height > 0.5 || rect.width <= 0) continue;
      // Detached cells are virtualization. A collapsed row replaced at the same
      // position is no longer in the feed, but its ID record can still remount.
      const replaced = entries.some(({ article }) => {
        const occupiedCell = article.closest('[data-testid="cellInnerDiv"]');
        if (!occupiedCell) return false;
        const occupiedRect = occupiedCell.getBoundingClientRect();
        return occupiedRect.height > 0.5 &&
          Math.abs(occupiedRect.top - rect.top) <= 0.5;
      });
      if (!replaced) continue;
      retiredIds.add(id);
      cellTweetIds.delete(cell);
    }
    if (!retiredIds.size) return;
    if (retiredIds.has(session.activeId)) {
      pauseTimer();
      session.tweets.get(session.activeId).state = "locked";
      session.activeId = null;
      removePushbackToast();
    }
    session.orderedIds = session.orderedIds.filter(id => !retiredIds.has(id));
  }

  function reconcileTweets() {
    flushElapsed(performance.now());
    const entries = getLiveEntries();
    const liveNodes = new Map(entries.map(entry => [entry.article, entry.id]));
    for (const [article, oldId] of connectedArticles) {
      if (liveNodes.get(article) !== oldId) removeArticleEffects(article);
    }
    connectedArticles = liveNodes;
    firstArticles = new Map();
    for (const { article, id } of entries) {
      if (!firstArticles.has(id)) firstArticles.set(id, article);
    }
    if (isWaitingForFeed(entries)) {
      clearArticleEffects();
      return;
    }
    reconcileCollapsedCells(entries);
    updateActivationBoundary(entries);
    updatePrependBoundary(entries);
    const prependedIds = findPrependedIds(entries);
    const prepended = new Set(prependedIds);
    for (const { id, top } of entries) {
      if (session.tweets.has(id)) continue;
      const newPost = isInNewPostPrefix(id, top);
      if (newPost) session.prependBoundary.ids.add(id);
      const skipped = !newPost && session.activationBoundary &&
        top < session.activationBoundary.top;
      session.tweets.set(id, {
        state: skipped && !prepended.has(id) ? "read" : "locked",
        elapsedMs: 0,
        durationMs: null
      });
    }
    if (prepended.size) {
      session.orderedIds = [...prepended,
        ...session.orderedIds.filter(id => !prepended.has(id))];
    }
    mergeFeedOrder([...firstArticles.keys()]);
    const startFromTop = needsTopStart && entries.length > 0 &&
      entries[0].article === timeline.querySelector(tweetSelector);
    if (needsTopStart) {
      if (startFromTop) {
        needsTopStart = false;
        needsVisibleStart = false;
        setActiveTweet(entries[0].id);
      }
    } else if (prependedIds.length) {
      needsVisibleStart = false;
      setActiveTweet(prependedIds[0]);
    } else if (needsVisibleStart) {
      startAtVisibleTweet(entries);
    } else if (session.prependBoundary?.oldIds.has(session.activeId)) {
      const next = session.orderedIds.find(id =>
        session.prependBoundary.ids.has(id) && session.tweets.get(id).state !== "read");
      if (next) setActiveTweet(next);
    } else if (session.activeId === null) {
      const next = session.orderedIds.find(id => session.tweets.get(id).state !== "read");
      if (next) setActiveTweet(next);
    }
    lastPositions = new Map();
    for (const { id, top } of entries) {
      if (!lastPositions.has(id)) lastPositions.set(id, top);
    }
    lastPostStart = getPostStart(entries[0]?.article);
    applyArticleStates();
    if (startFromTop) scrollToActiveTop(entries[0].article);
  }

  function scrollToActiveTop(article) {
    const top = window.scrollY + article.getBoundingClientRect().top - getHeaderBottom();
    scrollToLimit(Math.max(0, top));
  }

  function intersectsViewport(article) {
    const rect = article.getBoundingClientRect();
    return rect.height > 0 && rect.width > 0 && rect.bottom > 0 &&
      rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
  }

  function startAtVisibleTweet(entries) {
    const unread = entries.filter(entry => session.tweets.get(entry.id).state !== "read");
    const selected = unread.find(entry => intersectsViewport(entry.article)) ?? unread[0];
    if (!selected) {
      if (entries.length) needsVisibleStart = false;
      return;
    }
    const index = session.orderedIds.indexOf(selected.id);
    for (const id of session.orderedIds.slice(0, index)) markTweetRead(id);
    session.activationBoundary = {
      anchorId: selected.id,
      lastAnchorTop: selected.top,
      top: selected.top
    };
    needsVisibleStart = false;
    setActiveTweet(selected.id);
  }

  function setActiveTweet(id) {
    if (session.activeId === id) return;
    pauseTimer();
    removePushbackToast();
    const previous = session.tweets.get(session.activeId);
    if (previous?.state === "active") previous.state = "locked";
    const record = session.tweets.get(id);
    record.state = "active";
    if (record.durationMs === null) record.durationMs = settings.timerSeconds * 1000;
    session.activeId = id;
  }

  function markTweetRead(id) {
    const record = session.tweets.get(id);
    if (!record) return;
    if (session.activeId === id) pauseTimer();
    record.state = "read";
    if (session.activeId === id) session.activeId = null;
  }

  function applyArticleStates() {
    for (const [article, id] of connectedArticles) {
      const record = session.tweets.get(id);
      const locked = record?.state === "locked";
      if (locked) {
        article.setAttribute("data-slowfeed-state", "locked");
        for (const media of article.querySelectorAll("video, audio")) {
          if (!media.paused) media.pause();
        }
      } else {
        article.removeAttribute("data-slowfeed-state");
      }
      article.classList.toggle("sf-active",
        record?.state === "active" && firstArticles.get(id) === article);
      if (record?.state !== "active" || firstArticles.get(id) !== article) {
        removeProgress(article);
      }
    }
  }

  function findHeaderElements(primary) {
    if (!primary) return [];
    const candidates = new Set();
    const outer = primary.querySelector('[aria-label="Home timeline"]');
    const observedHeader = outer?.firstElementChild;
    if (observedHeader && !observedHeader.querySelector(tweetSelector) &&
        observedHeader.querySelector('[role="tablist"], [data-testid="pillLabel"]')) {
      candidates.add(observedHeader);
    }
    for (const element of primary.querySelectorAll("div, header, nav")) {
      if (element.closest(tweetSelector) || element.querySelector(tweetSelector) ||
          element.closest('[data-testid="toolBar"], [role="status"], [data-keep-composer-open]') ||
          element.matches('[data-testid="pillLabel"]')) continue;
      const position = getComputedStyle(element).position;
      if (position === "sticky" || position === "fixed") candidates.add(element);
    }
    return [...candidates];
  }

  function refreshHeaderElements() {
    if (!headerCandidatesDirty) return;
    headerElements = findHeaderElements(primaryColumn);
    headerCandidatesDirty = false;
  }

  function getHeaderBottom() {
    refreshHeaderElements();
    if (!primaryColumn) return 0;
    const column = primaryColumn.getBoundingClientRect();
    const bounds = headerElements.filter(element => element.isConnected)
      .map(element => element.getBoundingClientRect())
      .filter(rect => rect.height > 0 && rect.bottom > 0 &&
        rect.right > column.left && rect.left < column.right)
      .sort((left, right) => left.top - right.top);
    let bottom = 0;
    for (const rect of bounds) {
      if (rect.top <= bottom + 1) bottom = Math.max(bottom, rect.bottom);
    }
    return Math.min(window.innerHeight, bottom);
  }

  function syncGeometryObserver() {
    if (!geometryObserver) return;
    const nodes = new Set([primaryColumn, ...headerElements, getActiveArticle()].filter(Boolean));
    for (const node of geometryNodes) {
      if (!nodes.has(node)) geometryObserver.unobserve(node);
    }
    for (const node of nodes) {
      if (!geometryNodes.has(node)) geometryObserver.observe(node);
    }
    geometryNodes = nodes;
  }

  function onGeometryResize() {
    if (routeState.effective) updateTimer(performance.now());
  }

  function onViewportChange(event) {
    if (event.type === "scroll") onFenceScroll();
    if (event.type === "resize") {
      headerCandidatesDirty = true;
      refreshHeaderElements();
      syncGeometryObserver();
    }
    updateTimer(performance.now());
  }

  function onVisibilityChange() {
    updateTimer(performance.now());
  }

  function getActiveArticle() {
    const article = firstArticles.get(session.activeId);
    return article?.isConnected && getTweetId(article) === session.activeId ? article : null;
  }

  function isTimerEligible(article) {
    if (document.visibilityState !== "visible" || !article?.isConnected) return false;
    const rect = article.getBoundingClientRect();
    const headerBottom = getHeaderBottom();
    const usableHeight = Math.max(0, window.innerHeight - headerBottom);
    const visibleHeight = Math.max(0,
      Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, headerBottom));
    return rect.height > 0 && rect.width > 0 && rect.right > 0 &&
      rect.left < window.innerWidth && usableHeight > 0 &&
      visibleHeight >= 0.5 * Math.min(rect.height, usableHeight);
  }

  function flushElapsed(now) {
    const record = session.tweets.get(session.activeId);
    if (timerRunning && record?.state === "active") {
      record.elapsedMs = Math.min(record.durationMs,
        record.elapsedMs + Math.max(0, now - lastClockSample));
    }
    lastClockSample = now;
  }

  function pauseTimer() {
    flushElapsed(performance.now());
    timerRunning = false;
    clearTimeout(timerHandle);
    timerHandle = null;
  }

  function updateTimer(now) {
    flushElapsed(now);
    clearTimeout(timerHandle);
    timerHandle = null;
    const article = getActiveArticle();
    const record = session.tweets.get(session.activeId);
    timerRunning = Boolean(routeState.effective && record?.state === "active" &&
      isTimerEligible(article));
    if (!routeState.effective || !article || record?.state !== "active") return;
    if (timerRunning && record.elapsedMs >= record.durationMs) {
      completeActiveTweet();
      updateTimer(performance.now());
      return;
    }
    renderProgress(article, record);
    if (timerRunning) timerHandle = setTimeout(onTimerTick, 100);
  }

  function onTimerTick() {
    timerHandle = null;
    updateTimer(performance.now());
  }

  function renderProgress(article, record) {
    let bar = article.querySelector(":scope > .sf-progress");
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "sf-progress";
      bar.setAttribute("aria-hidden", "true");
      const fill = document.createElement("div");
      fill.className = "sf-progress-fill";
      bar.append(fill);
      article.append(bar);
    }
    const percentage = Math.max(0, Math.min(100, record.elapsedMs / record.durationMs * 100));
    bar.querySelector(".sf-progress-fill").style.width = `${percentage}%`;
  }

  function removeProgress(article) {
    for (const bar of article.querySelectorAll(":scope > .sf-progress")) bar.remove();
  }

  function completeActiveTweet() {
    const id = session.activeId;
    const record = session.tweets.get(id);
    if (!record) return;
    pauseTimer();
    removePushbackToast();
    record.elapsedMs = record.durationMs;
    markTweetRead(id);
    const next = session.orderedIds.find(candidate => session.tweets.get(candidate).state !== "read");
    if (next) setActiveTweet(next);
    applyArticleStates();
    syncGeometryObserver();
    syncScrollFence();
  }

  function getScrollLimit(article) {
    const rect = article.getBoundingClientRect();
    return Math.max(0,
      window.scrollY + rect.top - getHeaderBottom(),
      window.scrollY + rect.bottom - window.innerHeight);
  }

  function syncScrollFence() {
    const article = getActiveArticle();
    if (!routeState.effective || !article) {
      detachScrollFence();
      return;
    }
    if (fenceTweetId !== session.activeId) {
      rememberFencePosition(window.scrollY + article.getBoundingClientRect().top,
        getScrollLimit(article));
    }
    if (fenceAttached) return;
    fenceAttached = true;
    window.addEventListener("wheel", onFenceWheel, { capture: true, passive: false });
    document.addEventListener("keydown", onNavigationKeydown, true);
    document.addEventListener("focusin", onFenceFocus, true);
  }

  function detachScrollFence() {
    fenceTweetId = null;
    if (!fenceAttached) return;
    window.removeEventListener("wheel", onFenceWheel, true);
    document.removeEventListener("keydown", onNavigationKeydown, true);
    document.removeEventListener("focusin", onFenceFocus, true);
    fenceAttached = false;
    lastAllowedArticle = null;
  }

  function scrollToLimit(limit) {
    correctingScroll = true;
    try {
      // Floor fractional geometry so browser rounding cannot cross the boundary.
      window.scrollTo({ top: Math.floor(limit), left: window.scrollX, behavior: "instant" });
      previousScrollY = window.scrollY;
    } finally {
      correctingScroll = false;
    }
  }

  function rememberFencePosition(top, limit) {
    fenceTweetId = session.activeId;
    fenceTweetTop = top;
    previousScrollLimit = limit;
    previousScrollY = window.scrollY;
  }

  function onFenceScroll() {
    const current = window.scrollY;
    const article = getActiveArticle();
    if (!article) {
      fenceTweetId = null;
      previousScrollY = current;
      return;
    }
    const top = current + article.getBoundingClientRect().top;
    const limit = getScrollLimit(article);
    // A prepend may leave us past the fence; equal content/scroll shifts are reflow.
    const layoutOnly = fenceTweetId === session.activeId &&
      previousScrollY > previousScrollLimit && top > fenceTweetTop &&
      Math.abs((current - previousScrollY) - (top - fenceTweetTop)) <= 1;
    if (!correctingScroll && current > previousScrollY && current > limit && !layoutOnly) {
      scrollToLimit(limit);
      rememberFencePosition(top, limit);
      showPushbackToast(performance.now());
      return;
    }
    rememberFencePosition(top, limit);
  }

  function getWheelPixels(event) {
    if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * window.innerHeight;
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      const target = event.target instanceof Element ? event.target : document.documentElement;
      const style = getComputedStyle(target);
      const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
      return event.deltaY * lineHeight;
    }
    return event.deltaY;
  }

  function onFenceWheel(event) {
    if (event.deltaY <= 0 || event.ctrlKey || event.metaKey || event.shiftKey) return;
    updateTimer(performance.now());
    const article = getActiveArticle();
    if (!article) return;
    const limit = getScrollLimit(article);
    if (window.scrollY + getWheelPixels(event) <= limit) return;
    event.preventDefault();
    scrollToLimit(limit);
    showPushbackToast(performance.now());
    updateTimer(performance.now());
  }

  function isEditableTarget(target) {
    return target instanceof Element &&
      (Boolean(target.closest("input, textarea, select")) || target.isContentEditable);
  }

  function blockNavigation(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    showPushbackToast(performance.now());
  }

  function getNextNavigationArticle() {
    if (!timeline) return null;
    const articles = [...timeline.querySelectorAll(tweetSelector)];
    const focused = document.activeElement?.closest(tweetSelector);
    const anchor = focused && primaryColumn?.contains(focused)
      ? focused
      : articles.find(intersectsViewport);
    const index = articles.indexOf(anchor);
    return index >= 0 ? articles[index + 1] ?? null : null;
  }

  function onNavigationKeydown(event) {
    if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey ||
        event.metaKey || isEditableTarget(event.target)) return;
    if (event.key === " " && (event.shiftKey ||
        (event.target instanceof Element &&
          event.target.closest('button, a[href], [role="button"]')))) return;
    if (![" ", "PageDown", "ArrowDown", "j"].includes(event.key)) return;
    updateTimer(performance.now());
    const article = getActiveArticle();
    if (!article) return;
    if (event.key === "j") {
      if (getNextNavigationArticle()?.getAttribute("data-slowfeed-state") === "locked") {
        blockNavigation(event);
      }
      return;
    }
    if (window.scrollY >= Math.floor(getScrollLimit(article))) blockNavigation(event);
  }

  function onFenceFocus(event) {
    if (restoringFocus || !(event.target instanceof Element) || !getActiveArticle()) return;
    const article = event.target.closest(tweetSelector);
    if (!article || !primaryColumn?.contains(article)) return;
    if (article.getAttribute("data-slowfeed-state") !== "locked") {
      lastAllowedArticle = new WeakRef(article);
      return;
    }
    event.stopImmediatePropagation();
    const previous = lastAllowedArticle?.deref();
    const restore = previous?.isConnected && primaryColumn.contains(previous) &&
      previous.getAttribute("data-slowfeed-state") !== "locked" ? previous : getActiveArticle();
    if (!restore) return;
    restoringFocus = true;
    try {
      restore.focus({ preventScroll: true });
    } finally {
      restoringFocus = false;
    }
    showPushbackToast(performance.now());
  }

  function showPushbackToast(now) {
    const record = session.tweets.get(session.activeId);
    if (!routeState.effective || !getActiveArticle() || !record || !document.body) return;
    flushElapsed(now);
    if (!pushbackToast?.isConnected) {
      if (now - lastToastAppearance < 2000) return;
      removePushbackToast();
      pushbackToast = document.createElement("div");
      pushbackToast.className = "sf-toast";
      document.body.append(pushbackToast);
      lastToastAppearance = now;
    }
    const remaining = Math.max(0, Math.ceil((record.durationMs - record.elapsedMs) / 1000));
    pushbackToast.textContent = `Slow down. ${remaining}s left.`;
    clearTimeout(toastHandle);
    toastHandle = setTimeout(removePushbackToast, 2000);
  }

  function removePushbackToast() {
    clearTimeout(toastHandle);
    toastHandle = null;
    pushbackToast?.remove();
    pushbackToast = null;
  }

  function getLockedArticle(event) {
    if (!primaryColumn || !(event.target instanceof Element) ||
        !primaryColumn.contains(event.target)) return null;
    const direct = event.target.closest(`${tweetSelector}[data-slowfeed-state="locked"]`);
    if (direct) return direct;
    if (!(event instanceof MouseEvent)) return null;
    const cell = event.target.closest('[data-testid="cellInnerDiv"]');
    if (!cell || !timeline?.contains(cell)) return null;
    return [...cell.querySelectorAll(`${tweetSelector}[data-slowfeed-state="locked"]`)]
      .find(article => {
        const rect = article.getBoundingClientRect();
        return event.clientX >= rect.left && event.clientX <= rect.right &&
          event.clientY >= rect.top && event.clientY <= rect.bottom;
      }) ?? null;
  }

  function onLockedInteraction(event) {
    if (!getLockedArticle(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  function onLockedKeydown(event) {
    if (event.key === "Enter" || event.key === " ") onLockedInteraction(event);
  }

  function onMediaPlay(event) {
    const media = event.target;
    if (!(media instanceof HTMLMediaElement) || !getLockedArticle(event)) return;
    media.pause();
    event.stopImmediatePropagation();
  }

  function isNewPostButton(button) {
    if (!button || !primaryColumn?.contains(button) || button.closest(tweetSelector) ||
        button.closest('[data-testid="toolBar"]')) return false;
    return Boolean(button.querySelector('[data-testid="pillLabel"]')) ||
      /\b(?:Show\s+\d+\s+posts|See new posts)\b/i.test(button.textContent);
  }

  function onFeedClick(event) {
    const button = event.target instanceof Element ? event.target.closest("button") : null;
    if (isNewPostButton(button)) {
      resetFeedState(routeState.feedKey);
      needsTopStart = true;
      scheduleReconciliation();
    }
    onLockedInteraction(event);
  }

  window.addEventListener("slowfeed-route-change", onRouteSignal);
  window.addEventListener("popstate", onRouteSignal);
  window.addEventListener("hashchange", onRouteSignal);
  chrome.storage.onChanged.addListener(onStorageChanged);
  void loadSettings();
})();
