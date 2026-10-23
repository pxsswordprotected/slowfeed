(() => {
  "use strict";

  function installHistoryBridge() {
    if (window.slowfeedHistoryBridgeInstalled) return;

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    function pushState(...args) {
      const result = Reflect.apply(originalPushState, this, args);
      window.dispatchEvent(new Event("slowfeed-route-change"));
      return result;
    }

    function replaceState(...args) {
      const result = Reflect.apply(originalReplaceState, this, args);
      window.dispatchEvent(new Event("slowfeed-route-change"));
      return result;
    }

    history.pushState = pushState;
    history.replaceState = replaceState;
    window.slowfeedHistoryBridgeInstalled = true;
  }

  installHistoryBridge();
})();
