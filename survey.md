# Speedometer 3 Performance - DOM Bug Survey

Summary of DOM bug fixes contributing to Speedometer 3 performance improvements.

## Batch 1: DOM Attributes, Parsing, Events, Memory (21 bugs)

| Bug | Summary |
|-----|---------|
| 1843946 | Atomize full class attribute values for cheaper AtomArrayCache lookups; reduces string hash key cost and avoids string copies. |
| 1995614 | Use atoms for attributes instead of StringBuffer to improve attribute access performance across HTML/SVG elements. |
| 2017023 | Arena allocate element slots for better memory efficiency and allocation patterns. |
| 1499682 | SIMD-accelerate the HTML tokenizer data state for faster parsing of HTML documents. |
| 1807017 | Reuse tokenizer memory when nsHtml5Tokenizer::end() is called to reduce allocation overhead. |
| 1882417 | Suspend DOM notifications while parsing innerHTML to reduce unnecessary mutation observer overhead. |
| 1887615 | Micro-optimize PointerEventHandler::ReleaseIfCaptureByDescendant to reduce pointer event handler overhead. |
| 1887621 | Micro-optimize nsFocusManager::ContentRemoved for faster DOM removal handling. |
| 1815273 | Avoid extra TimeStamp::Now() calls in WidgetEvent::Duplicate to reduce event creation overhead. |
| 1838355 | Skip newline translation for IME text input on Windows (Nightly) for better performance. |
| 1925078 | Cache contenteditable attribute state in nsGenericHTMLElement to avoid repeated value comparisons. |
| 1834002 | Remove unnecessary InvalidateFrameSubtree call in HTMLInputElement::SetCheckedInternal. |
| 1929640 | Add faster GC mode in CCGCScheduler for faster collection when garbage creation is high. |
| 1930253 | Clear garbage collector graph before freeing snow whites in CleanupPhase. |
| 1890208 | Drop non-purple entries from GC nursery instead of moving to purple buffer. |
| 1856577 | Trigger minor GC before page loads to improve page load performance. |
| 1971630 | Skip subresource OnStateChange notifications for BCWebProgress to reduce IPC overhead. |
| 1874756 | Simplify LCP hashtable lookups by using raw pointers and eliminating mImageLCPEntryMap. |
| 1912908 | Check hash values before full string comparison in NodeInfoCache for faster node creation. |
| 1912367 | Have AtomCache check hashes before full string comparison for faster atom lookups. |
| 1925181 | Properly set small alloc randomization on Android content processes for security/performance. |

## Batch 2: Document/Parser/GC Optimization (21 bugs)

| Bug | Summary |
|-----|---------|
| 1879562 | Optimize default character set accesses in Document::RecomputeLanguageFromCharset() to reduce DOMParser overhead. |
| 1853986 | Remove Windows newline translation (\r\n) for IME input, simplifying composition text handling. |
| 1868746 | Release Document's StyleSet earlier during document lifecycle to reduce memory retention. |
| 1870477 | Trigger GC immediately after Cycle Collector if significant garbage found, improving cleanup timing. |
| 1868744 | Avoid redundant GC scheduling from CCGCScheduler immediately after JS engine GC slices. |
| 1832026 | Create TextControlState lazily only when needed instead of for every text input during parsing. |
| 1856574 | Only run GC/CC slices before page load if collection is ongoing; increase slice delays for idle time. |
| 1857221 | Disable line/column tracking in HTML parser during innerHTML and DOMParser operations to reduce tokenizer overhead. |
| 1842027 | Avoid localizing number input default values unless needed; cache localization to reduce conversions. |
| 1857731 | Schedule PREPARE_FOR_PAGELOAD minor GC during idle time instead of RelativeRefreshDriver hints. |
| 1857529 | Increase AsyncFreeSnowWhite timer delay from 500ms to leverage more idle time availability. |
| 1837482 | Optimize ContentEventHandler::GetTextLength by avoiding redundant TextFragment mode checks. |
| 1833181 | Avoid attribute lookups when checking if input value is empty by using HasForm() instead of string ops. |
| 1843949 | Pre-allocate element attribute array based on parser-known count to avoid reallocations. |
| 1843239 | Cache Location.hash with [Cached] annotation to avoid redundant property computation. |
| 1844752 | Initialize nsNodeInfoManager principal immediately with correct value instead of NullPrincipal replacement. |
| 1844774 | Optimize Document::SetScopeObject for data documents by skipping expensive DocGroup::GetKey(). |
| 1844432 | Cache parsed src attribute URI in HTMLImageElement to avoid recreating URL objects. |
| 1843918 | Skip console warnings about missing doctype when parsing data documents (DOMParser). |
| 1814310 | Optimize nsGenericHTMLFormElement::UpdateFormOwner by caching form ownership state. |
| 1834103 | Optimize nsIMutationObserver calls by skipping unnecessary observer notifications. |

## Batch 3: Event System & Caching Optimization (11 bugs)

| Bug | Summary |
|-----|---------|
| 1832515 | Optimize untrusted event dispatch by skipping EventListenerManager when no listeners exist, reducing overhead for unhandled events. |
| 1830542 | Replace LinkedList with AutoTArray for Selection registration in nsRange, eliminating allocation overhead while improving cache locality. |
| 1828293 | Synchronously dispatch input events using EventDispatcher when safe, avoiding unnecessary AsyncEventDispatcher allocations and reducing latency. |
| 1828356 | Expand EventTargetChainItem array caching with dual cache arrays to improve hit rate for rapid consecutive event dispatches. |
| 1828862 | Improve "no listeners" caching by storing 3 most-recent events without listeners instead of 1, increasing hit rate for typical multi-event patterns. |
| 1819769 | Skip a11y accessibility events (form checkbox/radio state change) entirely when no listeners registered, avoiding unnecessary creation and dispatch. |
| 1824627 | Expand MiscContainer cache size in nsAttrValue to accommodate more attribute value types, reducing cache misses during modifications. |
| 1812828 | Use AutoTArray with optimized inline capacity (70) for command dispatcher arrays, eliminating allocation overhead observed in Speedometer 3 benchmarks. |
| 1812644 | Cache warning state to prevent repeated WarnOnceAbout calls for preventDefault on non-cancelable events, reducing console spam overhead. |
| 1807842 | Simplify JSEventHandler to store direct EventTarget pointer instead of generic nsISupports, reducing indirection and enabling better type safety. |
| 1807812 | Remove unused WidgetEventTime::mTime field entirely, reducing event object memory footprint and eliminating useless timestamp computations. |

## Cross-cutting patterns

Across all 53 fixes, five principles recur:

**1. Skip, don't optimize.** Most wins remove work rather than speed it up: cache "no listeners," skip a11y events with no listeners, skip doctype warnings on data documents, skip line/column tracking in innerHTML, skip subresource OnStateChange, skip newline translation, suspend mutation notifications during parsing. Before optimizing a hot function, ask whether it needs to run *at all* in this context.

**2. Context-specialization beats generic optimization.** Fast paths for specific callers (DOMParser, innerHTML, data documents, untrusted events) outperform speeding up the general code. The caller knows things the callee discards — attribute count, observer absence, principal triviality. Look for that discarded knowledge.

**3. Allocation is the enemy more than CPU.** AutoTArray replacing LinkedList, tuned inline capacities (70), arena-allocated slots, reused tokenizer memory, eliminated AsyncEventDispatcher allocations. Profile for `operator new` / malloc churn, not just CPU samples.

**4. Small caches with cheap keys win.** The successful caches (3-slot "no listeners," dual EventTargetChainItem arrays, MiscContainer, hash-prefix in AtomCache/NodeInfoCache) are bounded and exploit benchmark-loop locality. Compare a hash **before** full string equality — cheapest possible reject.

**5. GC/CC is scheduling, not code.** GC wins are about *when*: run before page load, immediately after CC when garbage is high, during idle time, increase AsyncFreeSnowWhite delay, drop non-purple nursery entries. When GC shows up in a profile, the fix is usually a scheduling change.

## Where the fixes cluster

- **Caching & memoization** (~15 bugs): event listener sets, contenteditable state, form ownership, Location.hash, parsed URIs, node info hashes.
- **Event system** (~11 bugs, Batch 3): dispatch skipping, AutoTArray over LinkedList, sync dispatch when safe.
- **GC/CC scheduling** (~9 bugs, Batch 1): pre-pageload GC, idle slices, nursery and snow-white tuning.
- **Lazy init / pre-sizing** (~8 bugs, Batch 2): TextControlState, principals, parser-sized attribute arrays.
- **String & atom work** (~6 bugs): atomize attributes, hash-prefix comparisons, HasForm() over attribute lookup.
- **Parser specialization** (~5 bugs, Batch 2): line/column off in innerHTML, suspend notifications, data-document fast paths.
- **Surgical micro-fixes** (~8 bugs): redundant `TimeStamp::Now()`, dead fields, unnecessary InvalidateFrameSubtree.

## Finding the next fix

Three failure modes to look for in a profile:

- **An empty-set check that isn't being made** — no listeners, no observers, no work to do.
- **An allocation that didn't need to happen** — LinkedList node, AsyncEventDispatcher, temporary string.
- **A recomputation with a trivially cacheable key** — attribute value, parsed URI, hash prefix.

Concrete heuristics:

1. Re-profile after every landed fix — the next bottleneck is usually adjacent.
2. Hot string comparisons → atomize or hash-prefix.
3. Hot small-object allocations → AutoTArray / arena / pool.
4. Same-args repeated calls → `[Cached]` WebIDL or member cache.
5. Observer-conditional work → early-exit + cache the empty state (multi-slot if multiple objects rotate through).
6. Treat `TimeStamp::Now()`, principal creation, URL parsing, locale conversion on hot paths as suspects.
7. DOMParser / innerHTML / data-document paths remain fertile — they pay for parser features they don't need.
8. When the parser knows a size, preallocate to it.

Most fixes are local, low-risk, and don't touch APIs or architecture. The skill is *recognizing* the failure mode quickly from a profile, not inventing novel optimizations.
