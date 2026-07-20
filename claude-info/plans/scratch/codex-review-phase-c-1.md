FINDING 1  
SEVERITY: critical  
LOCATION: Task 15 Step 15.2; Task 17 Step 17.1(f); src/tui/syntaurd/launch.ts:47-61; src/dashboard/agent-sessions.ts:305-316  
ISSUE: The proposed CAS lets whichever inherited process calls `consumeLaunchMarkers` first claim the reservation. A subagent or `track-session --session-id <other>` can therefore win before the launched root session, after which the real root is rejected as `lost`. The plan’s R3 test only verifies an intruder after the real session has claimed, so it misses the harmful ordering. This does not deterministically tie the dispatch to its intended session and reintroduces the inherited-marker problem the existing evidence guard describes.  
FIX: Define and persist a root-only claim binding before dispatch. For direct Claude launches, record the injected expected session ID and permit a claim only from that ID; provide an equally deterministic root-identity mechanism for shell-alias launches, or explicitly retain a safe non-claim path until one exists. Add an intruder-first race test proving the root still owns the reservation.

FINDING 2  
SEVERITY: major  
LOCATION: Task 6 Step 6.2 (`tailSpool`) and Step 6.5  
ISSUE: `tailSpool` performs its initial `read()` before chokidar has finished establishing the watch. An event appended after that read but before chokidar’s `ready` state can be treated as initial filesystem state and ignored because `ignoreInitial: true` is set. Since the offset has not advanced, a later append may recover it incidentally, but a lone permission event can be lost indefinitely, violating AC2’s one-poll-cycle prompt guarantee. The proposed latency test does not force this startup race.  
FIX: Start watching the parent directory or file, wait for watcher readiness, then perform a second offset catch-up read; ensure no append interval exists between the final catch-up and live event handling. Add a deterministic test that appends during watcher initialization and verifies the blocked state is persisted.

FINDING 3  
SEVERITY: major  
LOCATION: Task 6 Step 6.2 Error Handling (“Hook flood / giant payload”)  
ISSUE: The proposed reader allocates `Buffer.alloc(size - offset)` for the entire newly appended spool delta before `createLineDecoder` can enforce its 32 MiB pending-line limit. A large or corrupted append can therefore trigger excessive allocation or OOM pressure; the stated decoder-overflow protection does not protect this allocation. The 200-event cap only limits event count after parsing.  
FIX: Read deltas in bounded chunks, feed a byte-safe streaming decoder incrementally, and impose a maximum spool-read/line size that advances past oversized data safely. Add a fixture with an oversized append followed by a valid event, proving the host remains alive and processes the later event.

FINDING 4  
SEVERITY: minor  
LOCATION: Task 12 completion criteria; Task 13 Step 13.5 and completion criteria  
ISSUE: The tmux-removal verification criteria conflict with the required degradation tests. Task 13 explicitly adds `hostedBy: 'tmux'` fixtures in `src/tui/cockpit/__tests__/actions.test.tsx` and `railTypes.test.ts`, but Task 12 greps all of `src/tui/cockpit` for zero tmux code hits, and Task 13 similarly requires zero hits in its test directory. Those commands will fail on the planned, necessary legacy-row tests.  
FIX: Scope the zero-reference checks to production imports/modules, such as `src/tui/cockpit` excluding `__tests__`, and separately assert that the only remaining test references are the legacy degradation fixtures.

VERDICT: NEEDS REVISION