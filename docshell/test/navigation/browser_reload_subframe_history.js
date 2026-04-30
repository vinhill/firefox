/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Reloading from the browser UI goes through nsSHistory::Reload, which used to
// leave the session history entries of the discarded child navigables behind.
// See bug 2037346.

const PAGE =
  "https://example.com/browser/docshell/test/navigation/file_reload_subframe_history.html";

function frameURI(browser) {
  return SpecialPowers.spawn(
    browser,
    [],
    () => content.frames[0].location.href
  );
}

// Opens PAGE in a new tab and navigates its subframe away from its src, so that
// session history holds an entry for both states.
async function withNavigatedSubframe(task) {
  await BrowserTestUtils.withNewTab(PAGE, async browser => {
    const shistory = browser.browsingContext.sessionHistory;
    const srcURI = await frameURI(browser);

    is(shistory.count, 1, "one entry after the initial load");

    await SpecialPowers.spawn(browser, [], async () => {
      const frame = content.document.getElementById("testFrame");
      const loaded = new Promise(resolve =>
        frame.addEventListener("load", resolve, { once: true })
      );
      frame.contentWindow.location.href = "blank.html?navigated";
      await loaded;
    });

    const navigatedURI = await frameURI(browser);
    isnot(navigatedURI, srcURI, "subframe navigated away from its src");
    is(shistory.count, 2, "subframe navigation added an entry");
    is(shistory.index, 1, "index after the subframe navigation");

    await task({ browser, shistory, srcURI, navigatedURI });
  });
}

async function reloadFromUI(browser, flags) {
  const loaded = BrowserTestUtils.browserLoaded(browser, false, PAGE);
  gBrowser.reloadWithFlags(flags);
  await loaded;
}

async function reloadFromContent(browser, forceReload) {
  const loaded = BrowserTestUtils.browserLoaded(browser, false, PAGE);
  await SpecialPowers.spawn(browser, [forceReload], force =>
    content.location.reload(force)
  );
  await loaded;
}

// Either the subframe is restored from history (pre-existing behavior, only
// still reachable with the pref on), or it's recreated from its container and
// ends up back at its src (bug 2037346's fix, the pref-off default). Either
// way the pre-reload entry isn't dropped, so count/index/canGoBack are the
// same in both cases; canGoForward only holds when nothing was restored,
// since restoring rewinds to the entry right after the current one.
async function checkNormalReload(pref, description, expectRestored) {
  await SpecialPowers.pushPrefEnv({
    set: [["docshell.shistory.restoreSubframesOnReload", pref]],
  });

  await withNavigatedSubframe(
    async ({ browser, shistory, srcURI, navigatedURI }) => {
      await reloadFromUI(browser, Ci.nsIWebNavigation.LOAD_FLAGS_NONE);

      is(
        await frameURI(browser),
        expectRestored ? navigatedURI : srcURI,
        `${description}: subframe ${
          expectRestored
            ? "was restored from history"
            : "is loaded from its src again"
        }`
      );
      is(
        shistory.count,
        2,
        `${description}: no entry is dropped by the reload`
      );
      is(shistory.index, 1, `${description}: index is unchanged by the reload`);
      ok(browser.canGoBack, `${description}: can still go back`);
      if (!expectRestored) {
        ok(!browser.canGoForward, `${description}: nothing to go forward to`);
      }
    }
  );
}

add_task(async function normalReload() {
  await checkNormalReload(false, "normal reload", false);
});

add_task(async function normalReloadWithPref() {
  await checkNormalReload(true, "normal reload with pref", true);
});

// A force reload always drops the subframe's stale history entries via
// nsSHistory::RemoveFrameEntries, regardless of the pref (which only affects
// normal reloads) and regardless of whether it's triggered from the UI
// (nsSHistory::Reload) or from content script
// (CanonicalBrowsingContext::NotifyOnHistoryReload) -- two separate code
// paths that used to disagree here. The pre-reload entry (index 0) and the
// reloaded one (index 1) become duplicates once their children are stripped,
// so nsSHistory::RemoveDuplicate collapses them into one instead of leaving
// a stale entry that nothing can navigate back to.
async function checkForceReload(pref, reload, description) {
  await SpecialPowers.pushPrefEnv({
    set: [["docshell.shistory.restoreSubframesOnReload", pref]],
  });

  await withNavigatedSubframe(async ({ browser, shistory, srcURI }) => {
    await reload(browser);

    is(
      await frameURI(browser),
      srcURI,
      `${description}: subframe is loaded from its src again`
    );
    is(
      shistory.count,
      1,
      `${description}: the duplicate entry left behind by the reload is collapsed`
    );
    is(
      shistory.index,
      0,
      `${description}: index points at the sole remaining entry`
    );
    ok(!browser.canGoBack, `${description}: nothing to go back to`);
    ok(!browser.canGoForward, `${description}: nothing to go forward to`);
  });
}

const FORCE_RELOAD_FLAGS =
  Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE |
  Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_PROXY;

add_task(async function forceReloadFromUI() {
  await checkForceReload(
    false,
    browser => reloadFromUI(browser, FORCE_RELOAD_FLAGS),
    "force reload from UI"
  );
});

add_task(async function forceReloadFromUIWithPref() {
  await checkForceReload(
    true,
    browser => reloadFromUI(browser, FORCE_RELOAD_FLAGS),
    "force reload from UI with pref"
  );
});

add_task(async function forceReloadFromContent() {
  await checkForceReload(
    false,
    browser => reloadFromContent(browser, /* forceReload */ true),
    "location.reload(true)"
  );
});
