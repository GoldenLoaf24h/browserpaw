# TEST_INFRA — E2E Test Infrastructure Specification

## 1. Overview & Objectives

This document specifies the architecture, test harness, oracle derivation methodology, and execution framework for the modern, opaque-box End-to-End (E2E) test suite of the **mcp-chrome** system.

The test suite validates the modernization and browser-use engine integration specified in `PROJECT.md` and `ORIGINAL_REQUEST.md`. It provides comprehensive, requirement-driven verification across all 13 core features, organized into 4 distinct verification tiers:

- **Tier 1: Feature Coverage (>=5 tests per feature)**: Validates functional correctness, core behavior, and protocol conformance across all 13 features (65 tests).
- **Tier 2: Boundary & Corner Cases (>=5 tests per feature)**: Exercises zero/extreme inputs, race conditions, disconnects, network anomalies, and format limits across all 13 features (67 tests; F07 and F10 include specialized subframe synchronization and table extraction boundary coverage).
- **Tier 3: Cross-Feature Combinations**: Validates pairwise interactions and state coupling between distinct subsystem features (16 tests).
- **Tier 4: Real-World Application Scenarios**: Simulates end-to-end, multi-step agent workflows on complex real-world web applications (5 scenarios).
- **Total E2E Tests**: 153 tests executed in ~10s with 100% compliance.

---

## 2. Architecture of the Test Suite

### 2.1 Technology Stack & Design Principles

- **Runtime**: Native Node.js LTS (v22+) with `--experimental-strip-types`, enabling direct execution of TypeScript test files without transpilation overhead or fragile external bundlers.
- **Assertion & Harness**: Native `node:test` and `node:assert/strict` ensuring zero external devDependency fragility, high-speed execution, and full Windows OS compatibility.
- **Opaque-Box Testing**: Tests interact strictly via observable protocol interfaces (MCP JSON-RPC over HTTP/SSE, stdio streams, Chrome Native Messaging protocol packets, CDP commands, and DOM index structures) rather than inspecting internal private variables.
- **Progressive Testability**: Features in active development (M1, M2, M3) can be verified against high-fidelity mock harnesses adhering strictly to the interface contracts in `PROJECT.md`, while remaining immediately switchable to live system processes in M4.

### 2.2 Directory & Module Layout

```
test/
├── e2e/
│   ├── fixtures/
│   │   ├── dom-samples.ts        # Synthetic & realistic DOM trees (E-commerce, Admin, SPA 1500-node feed)
│   │   ├── tool-inputs.ts        # Payloads for valid, edge-case, and adversarial inputs
│   │   ├── oracle-evaluators.ts  # Formal specifications and expected output derivation helpers
│   │   └── mock-server.ts        # Unified E2ETestEnvironment scaffold bundling all mocks and tool schemas
│   ├── mocks/
│   │   ├── mock-mcp-server.ts    # Multi-session MCP server harness conforming to McpSessionManager
│   │   ├── mock-extension.ts     # Mock Chrome Extension background worker & native port
│   │   ├── mock-cdp.ts           # Mock Chrome DevTools Protocol session & file input handler
│   │   ├── mock-dom-engine.ts    # 6-stage DOM pruning, viewport visibility, and 1-based indexer
│   │   └── mock-batch-pipeline.ts # Batch action execution pipeline with runtime page guards
│   ├── runner.ts                 # Master runner with tiered reporting and exit code management
│   ├── tier1-feature-coverage/   # 13 test files (F01 to F13)
│   │   ├── f01-multi-client-concurrency.test.ts
│   │   ├── f02-http-headers-sent.test.ts
│   │   ├── f03-stdio-termination.test.ts
│   │   ├── f04-extension-handshake.test.ts
│   │   ├── f05-tool-security-annotations.test.ts
│   │   ├── f06-file-upload-protocol.test.ts
│   │   ├── f07-index-interaction.test.ts
│   │   ├── f08-dom-pruning-visibility.test.ts
│   │   ├── f09-batch-actions-pipeline.test.ts
│   │   ├── f10-markdown-visual-boxes.test.ts
│   │   ├── f11-build-typecheck.test.ts
│   │   ├── f12-automated-tests.test.ts
│   │   └── f13-acceptance-adversarial.test.ts
│   ├── tier2-boundary-corner/    # 13 test files (F01 to F13)
│   │   ├── f01-multi-client-boundary.test.ts
│   │   ├── f02-http-headers-boundary.test.ts
│   │   ├── f03-stdio-termination-boundary.test.ts
│   │   ├── f04-extension-handshake-boundary.test.ts
│   │   ├── f05-tool-annotations-boundary.test.ts
│   │   ├── f06-file-upload-boundary.test.ts
│   │   ├── f07-index-interaction-boundary.test.ts
│   │   ├── f08-dom-pruning-boundary.test.ts
│   │   ├── f09-batch-actions-boundary.test.ts
│   │   ├── f10-markdown-boxes-boundary.test.ts
│   │   ├── f11-build-typecheck-boundary.test.ts
│   │   ├── f12-automated-tests-boundary.test.ts
│   │   └── f13-acceptance-adversarial-boundary.test.ts
│   ├── tier3-pairwise-combinations/
│   │   └── cross-feature-combinations.test.ts (16 pairwise interaction tests)
│   └── tier4-real-world-scenarios/
│       └── application-scenarios.test.ts (5 comprehensive end-to-end workflows)
```

---

## 3. Feature Inventory & Oracle Derivation

Each test case derives its expected output from authoritative source requirements documented in `PROJECT.md` and `ORIGINAL_REQUEST.md`:

| Feature ID | Feature Name                                 | Authoritative Source                                                 | Primary Verification Criteria                                                                                                                                   |
| ---------- | -------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F1**     | Multi-client HTTP/SSE Concurrency            | `PROJECT.md` §Interface Contracts; `ORIGINAL_REQUEST.md` §R1         | Independent `Server` per session; Client A tool invocation does not route or mutate Client B; session close is isolated.                                        |
| **F2**     | ERR_HTTP_HEADERS_SENT Elimination            | `ORIGINAL_REQUEST.md` §R1; Node.js HTTP invariants                   | Fastify `reply.hijack()` called; checks on `headersSent` / `writableEnded`; zero uncaught header exceptions under client abort or errors.                       |
| **F3**     | stdio Clean Termination (<1s)                | `ORIGINAL_REQUEST.md` §Acceptance                                    | Process exits within <= 1000ms upon `stdin` EOF/close; watchdog handles parent PID exit; zero zombie/orphan processes.                                          |
| **F4**     | Extension Handshake Self-Healing             | `PROJECT.md` §Feature 4; `ORIGINAL_REQUEST.md` §R1                   | 2-way handshake; 2s ping/pong heartbeat; recovery from port drop/reconnect within <= 3000ms to ready status.                                                    |
| **F5**     | MCP Tool Security Annotations                | `PROJECT.md` §Feature 5; MCP Spec 2024-11                            | Every tool schema includes `annotations` object with `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`.                                      |
| **F6**     | File Upload & file:// Protocol Support       | `ORIGINAL_REQUEST.md` §R1, §Acceptance                               | CDP `DOM.setFileInputFiles` succeeds on standard, hidden, and dynamic file inputs; Windows `file://` path normalization; triggers `change` event.               |
| **F7**     | Index-Based Element Interaction              | `PROJECT.md` §Feature 7; browser-use reference                       | Interactive elements assigned compact 1-based sequential indices; `chrome_interact_index` triggers click; `chrome_fill_index` focuses/clears/inputs text.       |
| **F8**     | DOM Pruning & Visibility Filtering           | `PROJECT.md` §Interface Contracts; `ORIGINAL_REQUEST.md` §Acceptance | 6-stage pruning; viewport 1000px check; occlusion filtering; achieves >= 85% compression ratio on 1000+ node DOM while preserving 100% of interactive elements. |
| **F9**     | Batch Action Execution Pipeline              | `PROJECT.md` §Interface Contracts; browser-use multi-act             | Compound action lists execute sequentially; runtime URL drift or static navigation triggers safe interruption; returns detailed partial execution results.      |
| **F10**    | Structured Markdown & Visual Bounding Boxes  | `PROJECT.md` §Feature 10; browser-use markdown extractor             | Clean hierarchical markdown extraction; scripts/styles/JSON blobs stripped; bounding boxes provide accurate layout coordinates.                                 |
| **F11**    | Monorepo Build & Typecheck Cleanliness       | `PROJECT.md` §Feature 11; `ORIGINAL_REQUEST.md` §R3                  | `pnpm build` succeeds; root `typecheck` passes cleanly; package exports resolve properly for ESM and CJS.                                                       |
| **F12**    | Automated Unit & Integration Tests           | `PROJECT.md` §Feature 12; `ORIGINAL_REQUEST.md` §Acceptance          | Unit and integration test suites execute cleanly via `pnpm test`; coverage includes session manager, stdio shutdown, DOM pruning.                               |
| **F13**    | Final E2E Acceptance & Adversarial Hardening | `PROJECT.md` §Feature 13; `ORIGINAL_REQUEST.md` §Acceptance          | Full opaque-box E2E pipeline passes 100%; stress testing under concurrent load; input sanitization against adversarial injections.                              |

---

## 4. Four-Tier Test Suite Specification

### Tier 1: Feature Coverage (65+ tests, >= 5 tests per feature)

- **F1 (Multi-client HTTP/SSE Concurrency)**:
  1. `test_f01_create_independent_sessions`: Creates separate sessions for Client A and Client B with distinct session IDs.
  2. `test_f01_concurrent_tool_dispatch`: Dispatches concurrent tool invocations on Client A and Client B without crosstalk.
  3. `test_f01_session_isolation_on_close`: Closing Client A session leaves Client B session active and operational.
  4. `test_f01_stale_session_cleanup`: Stale session reaper removes idle sessions exceeding threshold while retaining active sessions.
  5. `test_f01_sse_stream_multi_subscription`: Concurrent SSE subscribers receive only their corresponding message events.
- **F2 (ERR_HTTP_HEADERS_SENT Elimination)**:
  1. `test_f02_fastify_hijack_flag`: Handler immediately engages `reply.hijack()` on raw streaming routes.
  2. `test_f02_error_before_headers_sent`: Thrown error before headers are flushed returns 500 without double-sending headers.
  3. `test_f02_error_after_headers_sent`: Thrown error after headers are flushed closes stream cleanly without `ERR_HTTP_HEADERS_SENT`.
  4. `test_f02_rapid_client_disconnect`: Client socket abruptly closed during tool output generation does not throw unhandled header error.
  5. `test_f02_double_end_guard`: Multiple calls to stream termination are safely guarded by `writableEnded`.
- **F3 (stdio Clean Termination <1s)**:
  1. `test_f03_stdin_eof_exit_within_1s`: Closing stdin triggers process exit in <= 1000ms.
  2. `test_f03_parent_pid_watchdog`: Simulated parent PID death triggers child process termination in <= 1000ms.
  3. `test_f03_cleanup_hooks_invoked`: Active network connections and timers are closed during shutdown sequence.
  4. `test_f03_sigterm_graceful_exit`: Process handles SIGTERM signal and exits within 1000ms.
  5. `test_f03_no_lingering_background_processes`: Verifies zero orphan worker processes remain alive after stdio transport close.
- **F4 (Chrome Extension Handshake Self-Healing)**:
  1. `test_f04_two_way_handshake`: Extension initiates connection, receives ack, and transitions to `connected` ready state.
  2. `test_f04_heartbeat_ping_pong`: Active 2s ping/pong keep-alive maintains connection stability.
  3. `test_f04_transient_disconnect_recovery`: Port disconnection triggers reconnect and restores ready status in <= 3000ms.
  4. `test_f04_http_ping_fallback`: Extension uses HTTP `/ping` verification when native messaging port is resetting.
  5. `test_f04_state_transition_lifecycle`: Verifies complete lifecycle: `CONNECTING` -> `CONNECTED` -> `DISCONNECTED` -> `RECONNECTING` -> `CONNECTED`.
- **F5 (MCP Tool Security Annotations)**:
  1. `test_f05_readonly_hint_compliance`: Read-only inspection tools have `readOnlyHint: true`.
  2. `test_f05_destructive_hint_compliance`: State-mutating tools have `destructiveHint: true`.
  3. `test_f05_idempotent_hint_compliance`: Idempotent query tools declare `idempotentHint: true`.
  4. `test_f05_open_world_hint_compliance`: Browser tools declare `openWorldHint: true`.
  5. `test_f05_schema_conformance_with_annotations`: All exported tool schemas validate against MCP protocol specification with annotations metadata.
- **F6 (File Upload & file:// Protocol Support)**:
  1. `test_f06_standard_file_input_upload`: CDP `DOM.setFileInputFiles` binds file path to visible file input.
  2. `test_f06_hidden_file_input_upload`: Successfully locates and uploads to `display:none` or zero-size file input.
  3. `test_f06_change_event_dispatch`: Dispatches `change` and `input` DOM events after path injection.
  4. `test_f06_windows_file_protocol_normalization`: Normalizes Windows `file:///C:/...` and `file://C:\...` paths correctly.
  5. `test_f06_nonexistent_file_rejection`: Cleanly returns validation error when local file path does not exist.
- **F7 (Index-Based Element Interaction)**:
  1. `test_f07_compact_index_assignment`: Interactive elements receive sequential 1-based numbers.
  2. `test_f07_interact_index_click`: Dispatches click event to element specified by numeric index.
  3. `test_f07_fill_index_text`: Focuses, clears existing value, and fills new text into target input index.
  4. `test_f07_out_of_bounds_index_error`: Submitting index outside valid range returns structured error with valid boundaries.
  5. `test_f07_index_map_integrity`: Index map correctly associates index numbers with backend node IDs and tag names.
- **F8 (DOM Pruning & Visibility Filtering)**:
  1. `test_f08_non_content_tags_stripped`: Scripts, styles, meta, link, and comments are pruned in Stage 1-2.
  2. `test_f08_zero_dimension_filtering`: Elements with width=0 or height=0 are excluded from interactive index.
  3. `test_f08_viewport_boundary_culling`: Elements located >1000px outside viewport are pruned.
  4. `test_f08_hierarchical_occlusion_culling`: Elements fully covered by opaque overlay are culled.
  5. `test_f08_token_reduction_ratio`: Pruning on 1000+ node DOM achieves >= 85% compression while retaining 100% of interactive elements.
- **F9 (Batch Action Execution Pipeline)**:
  1. `test_f09_sequential_action_execution`: Executes compound action sequence (click -> wait -> fill) in exact order.
  2. `test_f09_detailed_results_reporting`: Returns `completedActions`, `totalActions`, and per-action success status.
  3. `test_f09_fail_fast_interruption`: Aborts on first failing action and outputs explicit `interruptedReason`.
  4. `test_f09_duration_delay_execution`: Accurately honors `durationMs` wait between actions.
  5. `test_f09_runtime_page_drift_guard`: Aborts remaining action steps when navigation/URL drift is detected.
- **F10 (Structured Markdown & Visual Bounding Boxes)**:
  1. `test_f10_clean_markdown_extraction`: Extracts clean markdown representing page hierarchy.
  2. `test_f10_spa_state_blob_stripping`: Strips injected JSON state blobs and script payloads from markdown.
  3. `test_f10_bounding_box_coordinates`: Computes accurate pixel bounding boxes for all indexed elements.
  4. `test_f10_overlay_injection_and_cleanup`: Injects visual index badges and cleans them up without DOM corruption.
  5. `test_f10_empty_whitespace_omission`: Ignores whitespace-only paragraphs and redundant linebreaks.
- **F11 (Monorepo Build & Typecheck Cleanliness)**:
  1. `test_f11_shared_package_build`: Builds `chrome-mcp-shared` to both ESM and CJS formats.
  2. `test_f11_typecheck_exclusion`: Verifies root typecheck config excludes `@chrome-mcp/wasm-simd`.
  3. `test_f11_export_resolution`: Verifies `package.json` exports map correctly to built artifacts.
  4. `test_f11_native_server_build_config`: Verifies native server build script configuration is valid.
  5. `test_f11_clean_distribution_target`: Confirms build output directories can be cleaned and regenerated cleanly.
- **F12 (Automated Unit & Integration Tests)**:
  1. `test_f12_session_manager_integration`: Verifies session manager test suite executes and passes.
  2. `test_f12_stdio_shutdown_integration`: Verifies stdio process termination integration test passes.
  3. `test_f12_dom_pruning_benchmark`: Verifies DOM benchmark tests meet the >85% compression threshold.
  4. `test_f12_tool_annotations_validation`: Verifies automated schema tests check annotations.
  5. `test_f12_test_runner_aggregation`: Verifies test runner correctly rolls up test results and return codes.
- **F13 (Final E2E Acceptance & Adversarial Hardening)**:
  1. `test_f13_full_opaque_box_pipeline`: Simulates full MCP client -> HTTP/SSE -> native server -> extension -> tool execution.
  2. `test_f13_concurrency_stress_load`: 10 parallel client sessions sending interleaved requests without collision.
  3. `test_f13_reconnect_resilience`: In-flight request completes successfully across an extension reconnection.
  4. `test_f13_high_node_count_stability`: Processes a 5,000-node DOM without memory spikes or timeouts.
  5. `test_f13_adversarial_input_sanitization`: Handles malformed JSON, prototype pollution keys (`__proto__`), and script injection safely.

### Tier 2: Boundary & Corner Cases (65+ tests, >= 5 tests per feature)

- **F1**:
  1. `test_f01_zero_clients`: System maintains zero CPU/memory spin with 0 active clients.
  2. `test_f01_max_concurrent_clients_50`: 50 concurrent client connections handled without descriptor starvation.
  3. `test_f01_rapid_session_churn`: Rapidly creating and destroying 20 sessions sequentially without memory leaks.
  4. `test_f01_duplicate_session_id_rejection`: Rejecting attempt to create duplicate existing session ID.
  5. `test_f01_session_timeout_during_request`: Handling idle timeout while long-running request is in progress.
- **F2**:
  1. `test_f02_socket_abort_mid_chunk`: Client aborts mid-way through a 1MB payload chunk.
  2. `test_f02_zero_length_sse_event`: Handling zero-length comment or empty payload ping.
  3. `test_f02_client_half_close`: Client closes write-side of TCP socket while reading SSE stream.
  4. `test_f02_write_after_fin`: Attempted write after socket FIN flag is handled without exception.
  5. `test_f02_backpressure_buffer_overflow`: High-throughput SSE stream honors backpressure without buffer exhaustion.
- **F3**:
  1. `test_f03_sigkill_pid_watchdog`: Process watchdog detects sudden death of parent PID and terminates immediately.
  2. `test_f03_stdin_flooded_before_eof`: 10MB of data sent through stdin immediately followed by EOF.
  3. `test_f03_zero_byte_stdin_close`: Immediate zero-byte close on process spawn exits within 1000ms.
  4. `test_f03_unhandled_rejection_cleanup`: Uncaught exception triggers graceful cleanup before termination.
  5. `test_f03_broken_pipe_on_stdout`: stdout pipe closed by parent while child is writing; child exits cleanly.
- **F4**:
  1. `test_f04_native_host_crash_recovery`: Extension recovers when native host crashes during heartbeat.
  2. `test_f04_disconnect_during_3way_handshake`: Port disconnects mid-way through initial handshake and recovers.
  3. `test_f04_rapid_reconnect_oscillation`: Port flaps 5 times in 2 seconds; extension stabilizes on final connect.
  4. `test_f04_chrome_runtime_lasterror_handling`: Handles `chrome.runtime.lastError` gracefully without unhandled promise rejection.
  5. `test_f04_pending_queue_preservation`: In-flight messages queued during disconnection are flushed on reconnection.
- **F5**:
  1. `test_f05_empty_properties_schema`: Tool schema with empty input properties object validates correctly.
  2. `test_f05_undefined_optional_properties`: Tool schema with optional properties left undefined is accepted.
  3. `test_f05_extra_unknown_keys`: Tool schema with unexpected metadata properties preserves core annotations.
  4. `test_f05_unicode_annotation_values`: Annotations containing non-ASCII / Unicode metadata process cleanly.
  5. `test_f05_empty_string_tool_name`: System rejects tool registration with empty or whitespace-only name.
- **F6**:
  1. `test_f06_unicode_and_space_file_paths`: Uploads file with Chinese characters, spaces, and emoji in path.
  2. `test_f06_unc_network_paths`: Handles Windows UNC network file path (`\\server\share\file.txt`).
  3. `test_f06_read_only_locked_file`: Handles file that is locked for reading by another process.
  4. `test_f06_multiple_file_input_attribute`: Handles `input[type="file"][multiple]` with multiple file paths.
  5. `test_f06_directory_path_instead_of_file`: Rejects folder path supplied to file upload tool.
- **F7**:
  1. `test_f07_index_zero_out_of_bounds`: Rejects index `0` (system is strictly 1-based).
  2. `test_f07_negative_index_rejection`: Rejects negative index `-1`.
  3. `test_f07_index_overflow_rejection`: Rejects index `99999` exceeding maximum assigned elements.
  4. `test_f07_detached_node_race_condition`: Target element removed from DOM immediately prior to click event.
  5. `test_f07_occluded_by_modal_race_condition`: Element covered by a dynamic modal between indexing and click.
  6. `test_f07_subframe_index_reindex_synchronization`: Subframe index synchronization and dynamic re-indexing across nested frames.
- **F8**:
  1. `test_f08_deeply_nested_dom_100_levels`: Correctly prunes DOM tree nested 100 levels deep without stack overflow.
  2. `test_f08_ten_thousand_text_nodes`: Handles page with 10,000 raw text nodes within memory limits.
  3. `test_f08_zero_visible_interactive_elements`: Page with only non-interactive static text returns empty interactive map.
  4. `test_f08_svg_complex_paths_collapsed`: Complex SVG with 500 path elements collapsed to single interactive SVG badge.
  5. `test_f08_fixed_header_boundary_elements`: Fixed elements positioned exactly on the 1000px boundary are correctly retained.
- **F9**:
  1. `test_f09_empty_action_array`: Submitting empty batch array `[]` returns successful result with 0 completed.
  2. `test_f09_oversized_batch_100_actions`: Submitting 100 actions executes with proper backpressure.
  3. `test_f09_invalid_action_type_in_array`: Action array containing unknown action type `'explode'` fails fast.
  4. `test_f09_detached_target_mid_batch`: Element at index 4 detached during step 3; step 4 halts gracefully.
  5. `test_f09_zero_duration_wait_action`: Action with `durationMs: 0` behaves as an immediate yield.
- **F10**:
  1. `test_f10_empty_body_document`: Document with empty `<body>` returns empty markdown string without error.
  2. `test_f10_xss_script_injection_in_dom`: `<script>` and `onload=` handlers completely omitted from extracted markdown.
  3. `test_f10_negative_viewport_coordinates`: Elements with negative scroll offsets have coordinates clamped properly.
  4. `test_f10_bounding_box_fullscreen`: Computes bounding boxes correctly when page is scrolled or in fullscreen mode.
  5. `test_f10_nested_overflow_scroll_containers`: Element inside internal scrolling container calculates correct relative position.
  6. `test_f10_table_and_image_markdown_extraction`: Verifies HTML table structures and images with alt text extract into markdown syntax without corruption.
- **F11**:
  1. `test_f11_strict_null_checks`: TS configuration enforces strict null safety across shared and native packages.
  2. `test_f11_missing_optional_peer_dep`: System operates without failure if optional peer dependencies are absent.
  3. `test_f11_crlf_and_lf_source_files`: Monorepo builds cleanly regardless of Windows CRLF or Linux LF line endings.
  4. `test_f11_circular_type_dependency_guard`: Ensures no circular type imports between shared packages and native server.
  5. `test_f11_clean_rebuild_from_scratch`: Complete removal of `dist` folders followed by rebuild succeeds.
- **F12**:
  1. `test_f12_hanging_test_timeout_guard`: Runner enforces 10s per-test timeout to prevent hanging asynchronous suites.
  2. `test_f12_special_characters_in_test_titles`: Test names with quotes, braces, and unicode characters report cleanly.
  3. `test_f12_isolated_execution_state`: Tests execute with independent fixture state without shared variable leakage.
  4. `test_f12_nonzero_exit_code_on_failure`: Runner exits with exit code 1 whenever any test fails.
  5. `test_f12_zero_exit_code_on_clean_run`: Runner exits with code 0 when 100% of tests pass.
- **F13**:
  1. `test_f13_prompt_injection_in_tool_args`: SQL / Prompt injection characters (`"'; DROP TABLE; \nHuman: ...`) safely handled as literal strings.
  2. `test_f13_oversized_json_payload_10mb`: Tool invocation with 10MB JSON argument rejected or handled without crash.
  3. `test_f13_slowloris_sse_client`: Slowloris-style drip client does not block other active client requests.
  4. `test_f13_high_network_jitter_simulation`: 500ms jitter and dropped packets simulated without deadlocking session queue.
  5. `test_f13_conflicting_state_mutations`: Concurrent contradictory commands (e.g. click vs navigate) queued and executed deterministically.

### Tier 3: Cross-Feature Combinations (16 pairwise interaction tests)

- `C01`: **F1 + F7**: Client A and Client B querying DOM and interacting with different indices concurrently on different tabs.
- `C02`: **F1 + F9**: Concurrent clients submitting complex batch actions simultaneously without cross-talk.
- `C03`: **F1 + F3**: stdio transport and HTTP transport running simultaneously without port or session contention.
- `C04`: **F2 + F9**: Client aborting HTTP connection while a multi-step batch action is in mid-execution; actions halt cleanly.
- `C05`: **F4 + F1**: Extension disconnects and reconnects while multiple HTTP clients are actively connected; sessions resume.
- `C06`: **F4 + F6**: Reconnection occurs during file upload sequence; file upload retries or reports clean error.
- `C07`: **F4 + F9**: Extension port drop between steps 2 and 3 of a 5-step batch action; triggers safe interruption.
- `C08`: **F6 + F7**: Locating a file input element via numeric index (`chrome_interact_index` focus) and then invoking file upload.
- `C09`: **F7 + F8**: Pruned DOM indices map 100% accurately to live interactive DOM elements with zero offset errors.
- `C10`: **F8 + F10**: Pruned DOM snapshot and markdown extractor produce mutually consistent representations of page text.
- `C11`: **F9 + F7**: Batch action sequence interleaves index-based clicks and index-based text fills across a form.
- `C12`: **F9 + F8**: Dynamic DOM change triggered by action step 2 causes selective re-indexing before action step 3.
- `C13`: **F5 + F9**: Batch action pipeline verifies annotations of each constituent action before execution.
- `C14`: **F5 + F6**: Security verification of file upload path restrictions and destructive/write hints.
- `C15`: **F3 + F4**: Stdio client termination notifies native host and frees extension connection cleanly.
- `C16`: **F2 + F10**: Streaming large extracted markdown document over SSE without HTTP header write conflicts.

### Tier 4: Real-World Application Scenarios (5 realistic application workflows)

- `S01`: **Multi-Step E-Commerce Checkout**:
  1. Navigate to e-commerce catalog page.
  2. Extract pruned DOM (1200 nodes compressed to 45 tokens).
  3. Locate "Add to Cart" button by index 4 -> click.
  4. Navigate to checkout wizard.
  5. Execute batch action: fill full name (index 2), address (index 3), credit card (index 4), click submit (index 5).
  6. Verify order confirmation markdown extracted with status "Success".
- `S02`: **Admin Dashboard File Attachment & Submission**:
  1. Access admin portal login screen.
  2. Fill credentials using index-based interaction (`chrome_fill_index`).
  3. Navigate to document management tab.
  4. Identify `<input type="file">` hidden element.
  5. Execute file upload attaching local document (`DOM.setFileInputFiles`).
  6. Submit form and verify file uploaded badge appears in pruned DOM.
- `S03`: **Multi-Agent Parallel Research Workflow**:
  1. Agent 1 (Claude Code) creates Session A; Agent 2 (Hermes) creates Session B.
  2. Agent 1 inspects React documentation tab; Agent 2 inspects GitHub repository issues tab.
  3. Both agents concurrently extract markdown and interactive index maps.
  4. Agent 1 interacts with index 3 (search docs); Agent 2 interacts with index 7 (filter open issues).
  5. Neither agent experiences session pollution, transport cross-talk, or header exceptions.
- `S04`: **Flaky Network & Extension Recovery during Form Wizard**:
  1. Agent initiates 5-step registration wizard.
  2. Steps 1 and 2 executed successfully.
  3. Network port disconnects (simulating browser reload or extension update).
  4. Self-healing handshake automatically reconnects within 2.5 seconds.
  5. Steps 3, 4, 5 resume and complete without wizard state loss.
- `S05`: **Dynamic SPA Feed with Occlusion & Visual Bounding Boxes**:
  1. Load infinite-scroll social media feed with 1500 DOM elements and sticky header.
  2. DOM engine performs 6-stage pruning, removing occluded and out-of-viewport nodes (achieving 89% compression).
  3. Visual bounding boxes calculated for all visible action items.
  4. Batch action executes: expand comments (index 6) -> wait 100ms -> fill comment (index 7) -> submit (index 8).
  5. Bounding box overlay rendered and verified without altering layout.

---

## 5. Test Runner & Execution Guide

### 5.1 Standalone Runner

Run the master E2E test suite covering all 4 tiers:

```bash
node --experimental-strip-types test/e2e/runner.ts
```

### 5.2 Targeted Tier Execution

Run specific tiers or feature suites:

```bash
# Tier 1 only
node --experimental-strip-types --test test/e2e/tier1-feature-coverage/*.test.ts

# Tier 2 only
node --experimental-strip-types --test test/e2e/tier2-boundary-corner/*.test.ts

# Tier 3 only
node --experimental-strip-types --test test/e2e/tier3-pairwise-combinations/*.test.ts

# Tier 4 only
node --experimental-strip-types --test test/e2e/tier4-real-world-scenarios/*.test.ts
```

### 5.3 Automated Integration Command

The root package runner executes the full E2E test suite:

```bash
pnpm test
# or
pnpm test:e2e
```

---

## 6. Interactive DOM Challenge Testbed (NEXUS LAB)

In addition to the opaque mock E2E suite, the repository includes a standalone React 19 + Vite 7 challenge testbed at `test/complex-html-testing/` (NEXUS LAB) featuring 12 interactive DOM obstacle challenges designed to benchmark AI agent browser automation:

| Challenge | Module            | Obstacle & Validation Focus                                                 |
| :-------- | :---------------- | :-------------------------------------------------------------------------- |
| **C01**   | `C01Click.tsx`    | Click precision, event listeners, dynamic button states                     |
| **C02**   | `C02Shadow.tsx`   | Open & closed Shadow DOM boundaries, nested component penetration           |
| **C03**   | `C03Form.tsx`     | Complex forms, validation states, custom dropdowns, token boundary matching |
| **C04**   | `C04Timing.tsx`   | Debounced buttons, delayed render elements, async animation settle          |
| **C05**   | `C05Scroll.tsx`   | Infinite scroll feeds, virtualized list rendering, `scroll_until_found`     |
| **C06**   | `C06Keyboard.tsx` | Keydown streams, modifier chords, platform shortcuts                        |
| **C07**   | `C07Drag.tsx`     | HTML5 Drag-and-Drop interactions and dropzone boundaries                    |
| **C08**   | `C08Modal.tsx`    | Modal dialog backdrop traps, modal auto-isolation, z-index overlays         |
| **C09**   | `C09Visual.tsx`   | Canvas element rendering, visual fallback PCIE, icon recognition            |
| **C10**   | `C10State.tsx`    | React state transitions, optimistic updates, async data fetching            |
| **C11**   | `C11Grid.tsx`     | Responsive CSS Grid, dense auto-flow layout alignments                      |
| **C12**   | `C12Omega.tsx`    | Multi-step combined omega scenario requiring all skills                     |

### Running the Challenge Testbed

```bash
# Option A: Fast static server (zero external build dependencies)
node test/complex-html-testing/serve.mjs

# Option B: Interactive Vite dev server with Hot Module Reload
cd test/complex-html-testing
pnpm install
pnpm dev
# Opens at http://localhost:5173
```

---

## 7. Package-Level Unit & Integration Suites

For package-level development and fast feedback during refactoring:

```bash
# Chrome Extension Unit & Integration Tests (Vitest, 49+ suites)
pnpm --filter chrome-mcp-server test

# Native Messaging Bridge & MCP Server Tests (Jest)
pnpm --filter mcp-chrome-bridge test

# Monorepo Strict TypeScript Typecheck
pnpm typecheck
```
