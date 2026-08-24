# Bug 2037346 — don't restore subframe history on parent reload

## Spec vs current behavior

Per [reload](https://html.spec.whatwg.org/#reload), a reload only marks the reloaded navigable
as changing; children are recreated from their containers, not restored from session history.
Chrome/Safari load iframe `src` on reload; Firefox restores last location.

**What the spec actually keeps at that child position.** [destroy a child
navigable](https://html.spec.whatwg.org/#destroy-a-child-navigable) step 7 — the thing that
removes a nested history from the parent document state — only runs from iframe *removal*, never
from reload (reload goes through [destroy a document and its
descendants](https://html.spec.whatwg.org/#destroy-a-document-and-its-descendants), which doesn't
touch nested histories at all). So after a reload, the parent document state's `nested histories`
list still holds the **old** navigable's nested history (id = old navigable's id, entries = the
old child's full history). Then [create a new child
navigable](https://html.spec.whatwg.org/#create-a-new-child-navigable) step 12, run for the
freshly-parsed iframe, **appends a second, independent nested history** (id = new navigable's id,
single entry, step = the parent's current step) to that *same* list. The spec does not override,
replace, or merge anything — `nested histories` is a plain growable list, so one child position
ends up backed by **two live nested histories side by side**: one dead (its navigable no longer
exists, but its entries still count) and one live. [get all used history
steps](https://html.spec.whatwg.org/#getting-all-used-history-steps) recurses into every nested
history in that list regardless, so `history.length` counts both. Confirmed with spec + WPT:
`history.length` should end at 2, back should move the index (it currently doesn't — see bug
below).

**Two reload paths**, both need the same fix:
- toolbar/F5/Ctrl+Shift+R → `nsSHistory::Reload` (never removed frame entries)
- tab context menu "Reload Tab" / `location.reload()` → `CanonicalBrowsingContext::NotifyOnHistoryReload`
  (removed them via `RemoveFrameEntries` on force reload)

**Pre-existing bug, worth a test + commit-message mention**: after Ctrl+Shift+R, back button
stays enabled but does nothing — recreated child gets a new history ID, so leftover entries
match no browsing context and `LoadNextPossibleEntry` walks off the end.

## Decision: adopt the old child entry's docshellID

Considered `RemoveFrameEntries` on all reloads too — rejected, collapses `history.length` 2→1
(verified via WPT), contradicting spec/Chrome. Must stay reachable behind the pref (pref ON =
today's exact behavior) but not be the new default path.

**Not a literal spec translation.** Spec keeps both nested histories (see above) — Gecko can't:
`SessionHistoryEntry::AddChild` (`SessionHistoryEntry.cpp:1146`) stores children in `mChildren`,
a flat array indexed by frame offset, one slot per position; adding a child at an occupied slot
orphans (`SetParent(nullptr)`) whatever was there (`SessionHistoryEntry.cpp:1219-1240`). There is
no room for two entries at one position without new storage (extend `mChildren` past
one-per-offset, or a side list of "dead but still counted" entries), which would also mean
teaching `RemoveDuplicate`/`IsSameTree`/length-counting/back-traversal about it — a much bigger,
riskier change. Docshell-ID adoption instead reuses the existing one-slot invariant: the new
child takes over the old child's slot *and* its `docshellID`, so externally `history.length`/back
behave like spec (2 entries, back moves the index) even though internally it's one slot whose
identity got reassigned, not two coexisting nested histories. Trade-off: back re-fetches the same
URL rather than restoring a truly separate live entry.

## Implemented change (parent process only, no IPC)

Done, builds clean (`./mach build binaries`, no errors/warnings in the touched files):

1. `CanonicalBrowsingContext::NotifyOnHistoryReload` — records the reload on the entry being
   reloaded (`mActiveEntry`/`loadingEntry.mEntry->SetLoadType(reloadLoadType)`, mirroring what
   `nsSHistory::InitiateLoad` already does), so the parent can tell "a reload is in progress"
   without asking content. `reloadLoadType` is `LOAD_RELOAD_BYPASS_CACHE` for `aForceReload`,
   else `LOAD_RELOAD_NORMAL`.
2. `CanonicalBrowsingContext::GetLoadingSessionHistoryInfoFromParent`
   (`CanonicalBrowsingContext.cpp:566`) — the single place subframe restore happens:
   ```cpp
   bool tookOverSlot = false;
   if (!StaticPrefs::docshell_shistory_restoreSubframesOnReload() &&
       (parentSHE->Info().LoadType() & nsIDocShell::LOAD_CMD_RELOAD)) {
     bool dynamicallyAddedChild = false;
     parentSHE->HasDynamicallyAddedChild(&dynamicallyAddedChild);
     if (!dynamicallyAddedChild) {
       RefPtr<SessionHistoryEntry> oldChild;
       parentSHE->GetChildAt(index, getter_AddRefs(oldChild));
       if (oldChild) {
         (void)SetHistoryID(oldChild->DocshellID());
         parentSHE->RemoveChild(oldChild);
       }
       tookOverSlot = true;
     }
   }
   if (!tookOverSlot) {
     // ...existing restore path unchanged...
   }
   ```
   `RemoveChild` first means `AddChild` finds an empty slot — no assertion hack needed. The WIP's
   relaxation of the `NS_ASSERTION` in `SessionHistoryEntry::AddChild` stays reverted (it was
   backwards: would've defeated the assertion for the Fission case it exists for). When there's a
   dynamically-added child, `tookOverSlot` stays false and behavior is unchanged (falls into the
   existing `GetChildSHEntryIfHasNoDynamicallyAddedChild` path, which itself declines to restore
   in that case).
3. Gated the existing `RemoveFrameEntries` calls: `NotifyOnHistoryReload`'s call is now
   `aForceReload && StaticPrefs::docshell_shistory_restoreSubframesOnReload()` (pref ON keeps
   today's exact behavior; pref OFF relies entirely on step 2, for both forced and normal
   reloads). The block added to `nsSHistory::Reload` was dropped outright — that file is now
   byte-identical to upstream (`git diff HEAD~1 -- docshell/shistory/nsSHistory.cpp` is empty).
4. `SessionHistoryInfo::LoadType()` → `const` (needed to call from `Info()`).

## Tree state at handoff

C++ implementation above is done and builds clean. Remaining work is tests + commit message.

- `HEAD` (this WIP commit) — `CanonicalBrowsingContext.cpp`/`nsSHistory.cpp` now hold the real
  fix instead of the rejected `RemoveFrameEntries`-based attempt; `StaticPrefList.yaml` pref and
  the WPT registration are unchanged from the WIP.
- `browser_reload_subframe_history.js` — done. Rewrote to expect `history.length` 2 (nothing
  dropped by a reload) instead of the rejected design's 1, and `canGoBack` true instead of false;
  `forceReload` keeps the pref *on* on purpose (that's the one case intentionally left matching
  today's dead-back-button behavior — see comment in the file). `file_reload_subframe_history.html`
  (its fixture, a page with one `<iframe id="testFrame" src="blank.html?src">`) didn't exist on
  disk despite being referenced in `browser.toml` — created it. All 26 subtests pass
  (`./mach test --headless docshell/test/navigation/browser_reload_subframe_history.js`).
- Still to write: `test_reload_subframe_history.html` (plain mochitest, referenced in the earlier
  handoff as planned but never actually created — nothing to rewrite, it doesn't exist).
- `test_bug1375833.html` — done. It relies on the legacy restore-on-reload path, so pinned
  `SpecialPowers.pushPrefEnv({set: [["docshell.shistory.restoreSubframesOnReload", true]]})` before
  opening its window (wrapped `window.open` in the pushPrefEnv callback, since `prefs=` only works
  in `[DEFAULT]`, not per-test). 20/20 subtests pass.
- WPT `iframe-restoration-on-container-history-navigation.html` — the two original tests
  (`history.length` 2 after reload, restore-on-container-navigate-and-back) pass unmodified. Added
  a third subtest for traversing back to a page whose iframe never left its initial about:blank
  (new fixture `has-initial-about-blank-iframe.html`); see the "Related" section below for why —
  it's about the initial-about:blank-sync-load timing, not this bug's actual fix, but it lives in
  the same file. Needed two `waitToAvoidReplace(t)` ticks before navigating the container away
  (one isn't enough here, unlike the other two tests, since there's no intervening real iframe
  navigation to naturally provide that delay — without it the container's own nav-away collapses
  into a replace and `history.length` stays 1 instead of 2).
- `artifacts/manual-2037346/` — manual Firefox-vs-Chrome harness (`python3 -m http.server 8123`),
  not meant to land.

## Related: initial about:blank sync-load timing on traversal (out of scope for this bug)

Came up reviewing `nsDocShell.cpp:9476` (`ShouldDoInitialAboutBlankSyncLoad`'s comment: "If a page
with an initial iframe is reloaded, `MaybeHandleSubframeHistory` will restore that about:blank
asynchronously. Bug 2007894." with an `XXX Bug 2037346` note right below). Question: is it bad
that this codepath forces the slow/async path whenever `LoadIsFromSessionHistory()` is true?

- **Mechanism, confirmed by reading the code**: `MaybeHandleSubframeHistory`
  (`nsDocShell.cpp:981`) gates an IPC round-trip to the parent process
  (`SendGetLoadingSessionHistoryInfoFromParent`) purely on `parentDS->IsLoadingFromSessionHistory()`
  + `XRE_IsContentProcess()` — independent of whether a restore actually happens.
  `GetInProcessSameTypeParent` requires an in-process parent, so this is specifically the
  same-origin/same-process child case. When it fires, the original synchronous `LoadURI` call
  bails (`return NS_OK`) before reaching `ShouldDoInitialAboutBlankSyncLoad`/
  `CompleteInitialAboutBlankLoad`; the retry after the IPC response
  (`aContinueHandlingSubframeHistory = true`) skips that block and can finish
  `CompleteInitialAboutBlankLoad` synchronously within the second call. So: starts sync, forced
  async by the SH check, finishes sync once the parent responds — one extra IPC round trip.
- **Not a reload-only thing** — this fires for reload (this bug's scope) *and* traversal.
- **Measured (new WPT subtest, `has-initial-about-blank-iframe.html`)**: on a non-bfcached
  back-navigation to a page whose iframe is still on its initial about:blank, the load does
  *not* complete synchronously in Firefox (`assert_true(w.initialAboutBlankWasSync)` fails) —
  but Chrome *does* manage it synchronously here, while still correctly restoring other SH child
  entries on the same back-navigation. So this is a real, Chrome-visible gap, not a "both equally
  slow" situation.
- **Spec check**: reload's non-restoration is cleanly derivable (destroy-a-document-and-its-
  descendants never calls destroy-a-child-navigable; create-a-new-child-navigable step 12
  unconditionally appends a fresh nested history). Traversal's restoration is not — "attempt to
  populate the history entry's document" reuses the same entry/document-state object, but the
  fresh iframe's create-a-new-child-navigable still unconditionally appends a brand-new nested
  history with no lookup against the old orphaned one. Couldn't find the spec step that mandates
  the reconnection real browsers do — looks like de-facto interop behavior, not a specified
  algorithm (not exhaustively checked, e.g. iframe "process the iframe attributes" steps).
- **Why hard to match Chrome here**: session history lives exclusively in the parent/UI process
  (`CanonicalBrowsingContext`); a content-process docshell can't learn "do I have history to
  restore" without an IPC round trip, and Gecko forbids synchronous content→parent IPC for this.
  Even given the info in time, swapping an already-synchronously-completed about:blank placeholder
  for the restored content hits the *same* one-slot-per-frame problem this bug's docshellID-adopt
  fix is already navigating (`SessionHistoryEntry::AddChild`'s `mChildren` is one entry per
  offset), now in the opposite direction and after a document a script could have already
  observed — plus it'd reintroduce the double-`load`-event problem the sync-placeholder path
  exists to avoid in the first place.
- **Possible direction, unexplored**: deliver the "is this child position still-initial-per-SH"
  bit earlier, as part of the *parent's own* navigation/commit data (which already necessarily
  talks to the parent process once per top-level navigation), rather than a fresh per-iframe IPC
  round-trip during HTML parsing. Would let `ShouldDoInitialAboutBlankSyncLoad` decide sync-vs-not
  without waiting on anything new — but still needs the "identify this child position before its
  docshell exists" and "one entry per slot" problems solved. Not scoped or attempted here.

## Still to do

1. ~~Compare against Chrome with the manual harness~~ — done, seems fine.
2. ~~Update `test_bug1375833.html` and the WPT~~ — done (see above).
3. Decide whether `test_reload_subframe_history.html` is still worth writing or
   `browser_reload_subframe_history.js` already covers it.
4. Drop `WIP` from commit message; describe spec rationale, the pref, and the pre-existing
   dead-back-button bug. Consider whether the "Related" investigation above belongs in the review
   response to the `nsDocShell.cpp:9476` question, or as a separate filed bug.
