# ACG sealed collector — deployment candidate

This candidate imports byte-identical sealed ACCEPT and STATE engines. The additional Python adapter changes only file bindings, transport and operational supervision. It is not the original Windows launcher, and it must not be presented as byte-identical launcher execution.

Required configuration: a new isolated worker service, one replica, persistent volume mounted at /data, TWELVE_DATA_API_KEY secret, and explicit ACG_CONTINUOUS_CAPTURE=ENABLED. No public domain is required. The data-provider key is never shipped here. Existing MongoDB or broker credentials are neither needed nor used.

Before activation build the container, verify all tests, mount the volume and confirm the required data-provider quota. Running the adapter without --once/--serve only verifies integrity. --once performs one capture. --serve requires the activation flag and refuses an unmounted Linux /data. It polls at 30-second UTC slots during the configured research session, approximately four time-series requests per minute after initial catch-up. Catch-up can use extra pages. This is an ongoing provider and hosting workload.

Every run validates sealed code and baseline archives. Persistent storage uses first-seen market observations as its authoritative record, logs revisions without applying them, and recovers caches after interrupted writes. Original protocol documents are copied unchanged. Windows baseline filenames are explicitly rebound to the identical bundled archives; stored JSON is never rewritten. The STATE source/output directory bindings point at the same volume.

Market failures are recorded and retried at the next slot. Integrity or consistency failures stop the process. A stale collection.lock after abrupt termination requires audit rather than automatic removal. Heartbeat, fetch results, failure records, signal decisions, outcomes and companion records are stored on the volume. A running service is not proof of timely observations or broker fills.

The planned boundary is 2026-11-16T00:00:00Z. This new storage must establish its own fresh in-session readiness before then. No local readiness marker or previous live ledger is included. If that requirement fails, a separately versioned future boundary is needed. Operational uptime and actual timeliness must still be checked before treating the cohort as valid.

This package contains no order-placement capability. The sealed engines simulate both central and stress proxy execution. No Bybit quotes are supplied. Parent formal review criteria and STATE training/evaluation design remain those of the sealed protocols. Periodic analysis/report generation is a separate milestone.

Local validation used Windows Python 3.14. Linux Python 3.12 container build/startup is a required cloud validation step, not an already observed success.
