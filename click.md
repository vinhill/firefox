# Profile: Firefox SP3 20260406 — `HTMLElement.click` during measured `-sync`/`-async` intervals

- Chrome Profile [link](https://profiler.firefox.com/public/r9gw48bcb9p0jsrzevews3prnyzsj6fkrtbth30/flame-graph/?globalTrackOrder=0&profileName=Chrome%20sp3%2020260421&thread=0&transforms=fs-m--async%2C-sync~ffs-js-124972&v=16)
- Firefox Profile [link](https://profiler.firefox.com/public/78ephzmgh78jcwwxeb6en32m8ddsttt2qrazgqg/flame-graph/?globalTrackOrder=0&profileName=Firefox%20sp3%2020260406&thread=0&transforms=fs-m--async%2C-sync~ffs-js-129138&v=16)

The URL transforms restrict the view to samples taken during SP3's `*-sync` / `*-async` UserTiming intervals (~92 800 markers, the SP3 measurement windows) and re-root the analysis at frames whose innermost JS-visible function is `HTMLElement.click`. That gives **14 935 active samples (~15 s of CPU)** spent inside `element.click()` during measured SP3 work — a meaningful chunk of the benchmark's measured time.

## Where that time goes (top-down, % of click)

| Path | Total |
|---|---|
| `EventDispatcher::Dispatch` (the actual click event walk) | **98.2 %** |
| → `HTMLInputElement::ActivationBehavior` | 33.7 % |
| • `DispatchInputEvent` (synchronous, despite `AsyncEventDispatcher::RunDOMEventWhenSafe`) | 18.9 % |
| • `DispatchTrustedEvent` (the `change` event) | 14.0 % |
| → `LegacyPreActivationBehavior` → `DoSetChecked` → `UpdateAllValidityStatesButNotElementState` | 6.8 % |
| • `UpdateTooLongValidityState` → `IsTooLong` → `NotifyStateChange` → `RestyleManager::ElementStateChanged` | **5.1 % (4.6 % in restyle)** |
| → JS reflector creation: `Event::WrapObject` / `PointerEvent_Binding::Wrap` | 6.9 % |
| • `GetPerInterfaceObjectHandle` → `CreateInterfaceObjects` / `CreateInterfacePrototypeObject` | **5.3 %** |
| → `MouseEvent::DuplicatePrivateData` (event copy for re-dispatch) | 3.2 % |
| → `nsINode::GetExistingListenerManager` → `PLDHashTable::Search` | 3.3 % |

Top self-time leaves: `HandleEventTargetChain` (4.0 %), **`nsCycleCollectingAutoRefCnt::incr` (3.3 %)**, anonymous JIT addresses `0x7fff68667055` (3.0 %), `EventDispatcher::Dispatch` (2.9 %), critical-section enter/leave (1.6 % + 1.2 %).

## Three concrete optimization candidates

1. **Validity-state recompute fires a restyle for state that can't change.**
   `DoSetChecked` on a checkbox/radio walks `UpdateAllValidityStatesButNotElementState`, runs `UpdateTooLongValidityState` (which is meaningless for checkboxes), and ultimately reaches `RestyleManager::ElementStateChanged` (4.6 % of click time). Worth checking whether `UpdateTooLongValidityState` / the broader `UpdateAllValidityStatesButNotElementState` should early-out by input type, or whether `NotifyStateChange` should short-circuit when the diff mask is empty. This is the biggest single fixable hot spot inside click. The stack is likely misattributed to `IsTooLong` - removing is still keeps the same state change in the flame graph.

2. **`PointerEvent` interface-object creation leaking onto the hot path (5.3 %).**
   `CreateInterfaceObjects` / `CreateInterfacePrototypeObject` for `PointerEvent_Binding` is supposed to run once per realm. The bottom-up view shows it churning through `JS_DefineProperties` → `PropertySpecNameToId` → `strlen` (8.7 % self-time of the search slice) and `Atomize` → `AtomCacheHashTable::lookupForAdd` (5.5 %). SP3's iterations cycle through many short-lived globals, so this lazy-init cost is paid often. Two angles: (a) make per-realm reflector init cheaper (cache atomized property keys / interned `JS::PropertyKey` for binding specs), or (b) make sure SP3-style benchmarks reuse realms instead of recreating them.

3. **Listener-manager hashtable lookup on every dispatch (3.3 %).**
   `nsINode::GetExistingListenerManager` → `PLDHashTable::Search` runs at least twice per dispatch (capture + bubble walks). The flag bits on `nsINode` already tell us whether a listener manager exists; any path that reaches the hashtable could keep a cached pointer or fold the lookup into the chain item construction.

## Smaller things

- `MouseEvent::DuplicatePrivateData` (3.2 %) is the cost of cloning the `WidgetPointerEvent` for the redispatch chain — possibly avoidable by moving instead of cloning.
- `nsCycleCollectingAutoRefCnt::incr` showing up as the #1 self-time leaf (3.3 %) suggests refcount churn on `RefPtr<EventListenerManager>` and event-target cleanup that could use raw pointers across the Dispatch frame.
- The two unsymbolicated JIT addresses (`f-2789`, `f-2501`) account for ~3 % combined self-time — not actionable from this profile alone.

---

# Comparison with Chrome SP3 20260421

Same SP3 build, same `*-sync` / `*-async` filter, same `HTMLElement.click` focus. Chrome profile: **10 454 active samples** in the click path versus Firefox's **14 935** — Firefox is **~43 % heavier (~4.5 s more CPU)** on the same hot path.

## Side-by-side breakdown

| Path | Firefox | Chrome | Firefox−Chrome | Notes |
|---|---|---|---|---|
| Total click samples | 14 935 | 10 454 | +4 481 | Firefox ~43 % more |
| Top-level `Dispatch` | 98.2 % | 98.9 % | — | Same shape |
| Input activation behavior | 33.7 % | 35.7 % | comparable | Chrome's `RunActivationBehavior`/`DispatchInputAndChangeEventIfNeeded` |
| `input` event dispatch | 18.9 % | 11.8 % | **+7.1 pp** | Firefox dispatches more synchronously |
| `change`/`DispatchTrustedEvent` | 14.0 % | 23.0 %† | comparable | †Chrome's combined scoped-event-queue cost |
| Pre-activation / `SetChecked` | 6.8 % | 11.2 % | −4.4 pp | Chrome heavier here |
| Pseudo/element-state restyle | 5.0 % (`RestyleManager`) | 8.1 % (`StyleEngine::PseudoStateChangedForElement`) | −3.1 pp | Chrome heavier |
| `UpdateTooLongValidityState` (Firefox-only) | **5.1 %** | 0 % | **+5.1 pp** | Pure overhead — `tooLong` is meaningless for checkboxes |
| `LayoutShiftTracker.NotifyChangeEvent` (Chrome-only) | 0 % | **10.2 %** | −10.2 pp | Chrome unconditionally schedules a one-shot timer per change |
| Reflector creation (`Event::WrapObject` / `ScriptWrappable::ToV8`) | 6.9 % | 8.3 % | comparable | Per-event JS reflector |
| `CreateInterfaceObjects` (per-realm binding init) | **5.3 %** | not visible | **+5.3 pp** | Firefox-only — leaks onto SP3 hot path |
| `MouseEvent::DuplicatePrivateData` | 3.2 % | not visible | +3.2 pp | Firefox-only event clone for redispatch |
| Listener-manager lookup | 3.3 % (PLDHashTable) | ~3 % (Vector linear scan) | — | Both pay this; similar cost |
| Refcount / cycle-collector self-time | **~5 %** combined (`nsCycleCollectingAutoRefCnt::incr`, critical sections) | ~0 % | **+5 pp** | Firefox uses XPCOM refcount + CC; Chrome uses Oilpan/cppgc, pays only `CompressedPointer::Decompress` (6.6 %) |

## What this tells us

Chrome **pays a real overhead Firefox doesn't** — `LayoutShiftTracker::NotifyChangeEvent` schedules a one-shot timer on every `change` event (10.2 % of click). Yet Chrome is still ~30 % faster overall. That means Firefox's overhead, broken down, exceeds the Chrome layout-shift cost by a lot. The Firefox-specific costs that account for the gap:

1. **Refcount + cycle-collector churn (~5 %).** `nsCycleCollectingAutoRefCnt::incr` is the #1 self-time leaf in Firefox; Chrome's Oilpan model lacks an equivalent. Structural cost, not a quick fix, but a real per-event tax. Local wins: hold raw pointers across `EventDispatcher::Dispatch`, avoid the `RefPtr<EventListenerManager>` AddRef in `HandleEvent`.

3. **`CreateInterfaceObjects` on the hot path (~5 %).** SP3 cycles realms, and Firefox lazily defines `PointerEvent_Binding` properties (`PropertySpecNameToId` → `strlen`, `Atomize`, `JS_DefineProperties`) on each. Chrome's V8 binding setup is not visible at the same scale here. Caching atomized property keys for binding specs, or reducing per-realm init cost, would eat into this.

4. **`MouseEvent::DuplicatePrivateData` (3.2 %).** Firefox clones the `WidgetPointerEvent` for redispatch; Chrome reuses the event in the scoped event queue. Move-instead-of-clone is plausible here.

5. **Synchronous input event dispatch (+7 pp).** Firefox routes the `input` event through `AsyncEventDispatcher::RunDOMEventWhenSafe` which still calls `EventDispatcher::Dispatch` synchronously; Chrome batches via `ScopedEventQueue` so the `input` and `change` dispatches share traversal infrastructure and the activation-behavior post-process. Worth investigating whether Firefox could coalesce input + change traversals.

## Where Firefox wins (or at least doesn't lose)

- Element-state restyle is **cheaper** in Firefox (5.0 %) than Chrome's `PseudoStateChangedForElement` (8.1 %). The Servo-side restyle is doing well here.
- Listener-manager lookup is roughly comparable; Firefox's PLDHashtable is similar to Chrome's small-vector linear scan.
- Firefox doesn't carry the `LayoutShiftTracker` cost (10 % in Chrome). If Firefox ever adds equivalent CLS instrumentation, beware of this regression source.

## Combined cost accounting

Firefox-specific overheads (refcount churn ~5 %, `UpdateTooLong` ~5 %, `CreateInterfaceObjects` ~5 %, `DuplicatePrivateData` ~3 %) sum to roughly **18 % of Firefox's click time = ~2 700 samples**, vs Chrome's `LayoutShiftTracker` ~10 % = ~1 050 samples of overhead Chrome carries that Firefox doesn't. Net Firefox-specific surplus ≈ 1 650 samples — about 35–40 % of the 4 481-sample gap. The remaining gap likely comes from per-frame structural costs (refcounting touches that show up across many small leaves rather than at the top, scoped-event-queue advantages, and JS-engine differences in event-listener invocation that aren't visible without symbols on `f-2789`/`f-2501`).

## Recommended order of attack

2. Investigate per-realm binding init: cache atomized property keys for `JSPropertySpec` so `CreateInterfaceObjects` doesn't pay `strlen`/`Atomize` repeatedly. ~5 % potential.
3. Look at the `MouseEvent::DuplicatePrivateData` clone — can the redispatch reuse the existing event? ~3 % potential.
4. Longer term, look at refcount/CC pressure inside `EventDispatcher::Dispatch` (raw pointers across the dispatch frame, etc.).

---

# More DOM-side opportunities (deeper pass)

Numbers below are % of click samples unless noted. Most come from `samples-top-down --search` walks plus the unfiltered bottom-up self list.

## 1. Form-associated-custom-element check on every ancestor (~4.7%, ~3 % avoidable)

In the pre-walk, every ancestor that's a generic `HTMLElement` goes through `HTMLElement::GetEventTargetParent` → `IsDisabledForEvents` → **`IsFormAssociatedElement` (4.7 %)** → `CustomElementData::IsFormAssociated()` → `RefPtr<CustomElementDefinition>::operator bool()` (**3.1 % self**, pure pointer deref).

This is a check whether an `HTMLElement` is a form-associated custom element. For a checkbox in a form with a custom-element wrapper somewhere in the ancestor chain, this fires per ancestor, per event (click + input + change = 3× per click). The expensive part is reaching out to `CustomElementData` and dereferencing `mDefinition`.

Fix: cache `IsFormAssociated` as a bit on `CustomElementData` (or, better, as a node flag on the element) so the `RefPtr<CustomElementDefinition>` indirection is avoided. Even cheaper: an early-out in `HTMLElement::IsDisabledForEvents` when `!GetCustomElementData()` (the GetCustomElementData call itself is only 0.9 %, so the bulk of the cost is past the null check — verify whether SP3 elements actually have a CED).

## 2. PostHandleEvent: per-item `mItemData` refcount churn + always-on virtual call

The function itself is three lines (`EventDispatcher.cpp:481`):

```cpp
void EventTargetChainItem::PostHandleEvent(EventChainPostVisitor& aVisitor) {
  aVisitor.mItemFlags = mItemFlags;
  aVisitor.mItemData = mItemData;          // nsCOMPtr<nsISupports>
  mTarget->PostHandleEvent(aVisitor);
}
```

Called once per chain item in the system-group pass from the bubble loop (`if (aVisitor.mEvent->mFlags.mInSystemGroup) item.PostHandleEvent(aVisitor);`).

Hot work inside it:

- **`aVisitor.mItemData = mItemData;` shows ~13 % of the PostHandleEvent subtree** in nsCOMPtr<nsISupports>::operator= (~7.5 % self in `RefPtrTraits::AddRef`, ~4 % in `assign_assuming_AddRef` for Release). `mItemData` is the per-item scratch slot only a few overrides actually populate (e.g. `HTMLInputElement::LegacyPreActivationBehavior` stashes the previously-checked radio there for restore-on-cancel). For everything else both sides are null but the assignment still pays the operator= call. The matching reset in `EventChainPreVisitor::Reset()` shows up at 0.5 %.
- **`mTarget->PostHandleEvent` is called unconditionally for every chain item** even when the target's override is `Element::PostHandleEvent` (a no-op or near-no-op).
- **`HTMLInputElement::PostHandleEvent` 4.7 % self / 10.5 % total** (when this is the leaf override) with two surprising costs:
  - `WidgetMouseEventBase::IsLeftClickEvent` 1.7 % self — recomputed for every dispatch even after `LegacyPreActivation` already established this is a left click.
  - `MaybeInitPickers` called from **two distinct call sites** (`f-98427` 1.1 % + `f-51513` 0.9 %) — date/color/file picker scaffolding that has nothing to do with checkboxes. Should be gated on the relevant input types before any work happens.
- **`Document::MayHaveDOMActivateListeners` called three times** within the input PostHandleEvent (f-110626 + f-65012 + f-71720, ~1.4 % combined) — each call hits `Document::GetInnerWindow`. Cache the bit once per dispatch.
- `HTMLButtonElement::PostHandleEvent` 3.6 % self — same shape as input's.

Two structural fixes:
1. **Skip the virtual call entirely for chain items that don't override `PostHandleEvent`.** Set an `mOverridesPostHandleEvent` bit at chain-item creation (next to `WantsPreHandleEvent` etc.), short-circuit in the bubble loop. This removes both the virtual dispatch and the `mItemData`/`mItemFlags` copy for the no-op majority.
2. **Make `mItemData` cheaper to no-op-swap.** Guard `aVisitor.mItemData = mItemData;` on `mItemData || aVisitor.mItemData` being non-null so the common (both-null) path is a single load+branch instead of an AddRef/Release function call. Or change the type to a raw pointer + manual lifetime management at the handful of sites that actually populate it.

Note: my earlier draft attributed this AddRef/Release to a "currentTarget swap" — that was wrong. `mEvent->mCurrentTarget` is asserted null on entry/exit of `EventListenerManager::HandleEvent` and `mEvent->mTarget` gets a raw assignment in the bubble loop only at anonymous-boundary crossings. The per-item nsCOMPtr cost is `mItemData`.

## 3. `nsWindowRoot::GetRelevantGlobal` does an unnecessary `do_QueryInterface` (minor, XPCOM-listener path only)

```cpp
nsIGlobalObject* nsWindowRoot::GetRelevantGlobal() const {
  nsCOMPtr<nsIGlobalObject> global =
      do_QueryInterface(mWindow->GetCurrentInnerWindow());
  return global;
}
```

`GetCurrentInnerWindow()` already returns `nsPIDOMWindowInner*`; the `do_QueryInterface` runs a full vtable QI plus an nsCOMPtr AddRef/Release just to land on `nsIGlobalObject*`. Direct downcast via `nsGlobalWindowInner::Cast(...)` produces the same pointer without QI or refcount traffic.

Scope of the impact, though, is small. `EventListenerManager::WindowFromListener` only reaches `mTarget->GetRelevantGlobal()` on the **XPCOM-callback** branch (`!HasWebIDLCallback()`); the WebIDL branch — which is what SP3's JS listeners use — goes through `callback->IncumbentGlobalOrNull()` + `nsIGlobalObject::GetAsInnerWindow()` and is already QI-free. The QI traffic visible in the profile under `WindowFromListener` comes from chrome-side XPCOM listeners attached to `nsWindowRoot` firing during the bubble walk, not from page JS.

Net: worth fixing as a tidy cleanup (and it does take a measurable bite out of the chrome bubble path), but not a meaningful SP3 win. Caching the inner window across listeners is **not** an option either: WebIDL listeners can each carry a different incumbent global.

## 4. Popup-state pusher emplaced unconditionally in `HandleEventInternal` (~1 %)

```cpp
Maybe<AutoPopupStatePusher> popupStatePusher;
if (mIsMainThreadELM) {
  ...
  popupStatePusher.emplace(
      PopupBlocker::GetEventPopupControlState(aEvent, *aDOMEvent));
}
```

Note: `GetEventPopupControlState` runs **once per `HandleEventInternal` call** (once per chain item per phase), not once per listener — there is nothing per-listener to hoist out of. The cost sits in two places:

- the always-emplaced `Maybe<AutoPopupStatePusher>` → `PopupBlocker::PushPopupControlState` on construction + `PopPopupControlState` on destruction, whether or not the resulting state differs from the current top of the stack;
- the body of `GetEventPopupControlState`: a switch on `aEvent->mClass` where most cases are guarded by `aEvent->IsTrusted()`. For a synthetic `element.click()` (untrusted `ePointerClick`) every case short-circuits, but the dispatch and per-case `IsTrusted()` virtual still run.

Smaller, more concrete fixes:

1. **Don't push the pusher when it would be a no-op.** When `GetEventPopupControlState` returns the same state as the current top of the popup-state stack (typical: both `openBlocked` for synthetic clicks), skip the emplace entirely — the Push/Pop pair becomes free.
2. **Early-out the switch for untrusted events without a `WantsPopupControlCheck`.** One up-front `if (!aEvent->IsTrusted() && !(aDOMEvent && aDOMEvent->GetWantsPopupControlCheck())) return openBlocked;` collapses every guarded case below it.

Total recoverable: sub-1 % of click. My earlier "~2–3 %" estimate and the "hoist out of per-listener" framing were both wrong.

## 5. Pre-walk: `EventChainPreVisitor::Reset` and `Maybe<nsTArray<RefPtr<EventTarget>>>` for retargeting (~2.2 %)

`Reset()` runs for every chain item in the pre-walk. Two costs inside it:
- `Maybe<nsTArray<RefPtr<EventTarget>>>::reset()` (0.5 % self) — touch-retargeting state. For a single-point click on a non-shadow-DOM target, this is dead state being reset on every iteration.
- `nsCOMPtr<nsISupports>::operator=(void*)` (0.5 %) — clearing `mItemFlags`/related fields.

Two angles: (a) lazy-construct the touch retargeting state only when actually populated, so `reset()` becomes a single null check; (b) split the visitor's per-item state from per-walk state so Reset doesn't have to touch the entire object.

## 6. `EventTargetChainItem` setter bits add up to ~5 % combined self

Sum of `SetWantsPreHandleEvent`, `SetWantsWillHandleEvent`, `SetMayHaveListenerManager`, `SetItemInShadowTree`, `SetRootOfClosedTree`, `SetPreHandleEventOnly`, `SetRetargetedRelatedTarget`, `SetRetargetedTouchTarget` ≈ 5 % self. Each is a one-bit/one-pointer setter that didn't inline. Most of these bits are set once at chain-item creation in the pre-walk based on the per-element `GetEventTargetParent` result.

Fixes:
- Pack the flag setters into a single `SetFlags(EventTargetChainItemFlags)` call so the pre-visitor writes once instead of N times.
- Force-inline the trivial setters (or convert to public-bitfield assignment) so they don't show up as their own frames.
- Stop unconditionally setting `RetargetedTouchTarget` for non-touch events (the `Maybe<nsTArray>` assignment is 0.8 %).

## 7. `EventListenerMap::EntryIndexForType` uses binary search even with tiny N (~1.3 %, 0.9 % self)

`EventListenerManager::HandleEventInternal` calls `GetListenersForType(nsAtom*)` which `BinarySearchIf`'s an `AutoTArray<>`. For most elements the array has ≤ 4 entries, where a linear scan with branch-predictable atom-pointer compare wins. The 0.9 % self time inside `BinarySearchIf` plus 1.1 % self in `operator==(nsAtom*, RefPtr<nsAtom>&)` says we're paying the binary search's worst-case branch behaviour for small inputs.

Fix: linear scan when `Length() <= kSmallThreshold` (4 or 8), binary search otherwise.

## 8. `nsINode::GetAssignedSlot` in the pre-walk (~4.7 %, 2.9 % self in `nsIContent::GetAssignedSlot`)

In `nsIContent::GetEventTargetParent`, every chain ancestor calls `GetAssignedSlot()` (and beneath it `GetExistingExtendedContentSlots()` 1.9 % self) to find a slotted shadow-DOM parent. For non-shadow DOM (most of SP3) this is dead work that touches a separate allocation (`ExtendedContentSlots`).

Fix candidates:
- A node flag `MayHaveAssignedSlot` (set when an element is actually slotted) so the common case is a single bit check, not a load of `ExtendedContentSlots`.
- Or short-circuit before `GetAssignedSlot` when the element's containing tree has no shadow roots.

## 9. `nsContentUtils::DispatchInputEvent` → `AsyncEventDispatcher` is synchronous (~18.9 %)

The `input` event for checkbox activation goes through `nsContentUtils::DispatchInputEvent` → `AsyncEventDispatcher::RunDOMEventWhenSafe` → … → `EventDispatcher::Dispatch` synchronously, allocating an `AsyncEventDispatcher` object along the way. The async indirection is paying allocation + virtual-call cost for a synchronous dispatch most of the time. Either:
- Detect the "safe now" path inside the caller and skip building the AsyncEventDispatcher entirely (jump straight to `EventDispatcher::Dispatch`).
- Or, like Chrome, queue the `input` and `change` events on a `ScopedEventQueue` so they share traversal infrastructure.

## 10. Per-listener atom recompute: `nsContentUtils::GetEventType` / `GetEventTypeFromMessage` (~1.8 % combined)

For each chain item, `HandleEventInternal` recomputes the event-type atom from `WidgetEvent::mMessage`. The event already carries `mSpecifiedEventType` (an `nsAtom*`); for most internal events this is just a table lookup. The 1.3 % in `GetEventType` plus 0.5 % in `GetEventTypeFromMessage` is per-chain-item, per-event redundant work. Cache the resolved atom on the `EventChainPostVisitor` or on the `WidgetEvent` for the lifetime of the dispatch.

## 11. `nsWindowRoot::GetEventTargetParent` does an unnecessary AddRef (~3.5 %, ~1.7 % AddRef)

When the chain ascends to the chrome event handler / window root, `nsWindowRoot::GetEventTargetParent` (3.5 % total, 1.6 % self) does an `nsCOMPtr<nsISupports>` AddRef on its parent target — 1.7 % is spent inside `RefPtrTraits<nsISupports>::AddRef`. This runs once per dispatch; the chain holds the parent alive already, so a raw pointer assign is safe.

## DOM-only order of attack (biggest first)

1. **Skip-PostHandleEvent-when-no-override bit** on `EventTargetChainItem` + raw-pointer `currentTarget` swap. Potentially ~10 % of click. ← largest structural DOM win.
2. **`HTMLElement::IsFormAssociatedElement` early-out** (cache `IsFormAssociated` bit + null-CED fast path). ~3–4 %.
3. **Skip the `AutoPopupStatePusher` emplace when the resulting state matches the current top**, and early-out `GetEventPopupControlState` for untrusted events. Called once per chain item, not per listener. Sub-1 %.
4. **Drop the `do_QueryInterface` in `nsWindowRoot::GetRelevantGlobal`** (direct `nsGlobalWindowInner::Cast`). Cleanup only — applies to the XPCOM-callback branch in `WindowFromListener`, which is the chrome bubble path; SP3's WebIDL listeners don't reach it. Sub-1 %.
5. **`HTMLInputElement::PostHandleEvent` for checkbox**: dedupe `MaybeInitPickers`, gate by input type, dedupe `MayHaveDOMActivateListeners`. ~2 %.
6. **Linear scan in `EventListenerMap::EntryIndexForType`** for small N. ~1 %.
7. **`GetAssignedSlot` fast path** via a node flag. ~2–3 % but more invasive.
8. **Cache resolved event-type atom** once per dispatch instead of recomputing per chain item. ~1.5 %.
9. **`EventTargetChainItem` setter batching** into a single flag-write + inline. ~3–5 % if inlining can also be fixed.
10. **Synchronous-path detection** in `nsContentUtils::DispatchInputEvent` to skip the `AsyncEventDispatcher` indirection. Structural, but on a 19 % subtree.
