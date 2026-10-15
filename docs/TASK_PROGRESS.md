# Task activity and text artifacts

The task dialog displays actual execution stages, attempt budget, elapsed time, recent heartbeat, task events, and the final outcome. It polls while queued, assigned, running or awaiting review and preserves historical activity when reopened. It does not infer a completion percentage from model turns. Long results are collapsed to keep activity visible on mobile. Original request exposes the stored description and acceptance criteria.

`GET /api/orgs/:orgId/tasks/:id/progress` first authorizes task visibility. It returns up to 60 recent lifecycle events, work-state events associated with the latest run's agent and start/finish interval, and the latest attempt's last 100 log lines. Commands/details and raw log output additionally require that agent's existing `runtime.logs` permission. Unrelated agent work and later tasks are excluded; stopped attempts have no live heartbeat. All output is redacted again at read time. Migration 16 indexes task/run/activity lookups.

Text artifacts are served with `charset=utf-8`. Task files open in an escaped React text preview: `Blob.text()` decodes UTF-8, no produced HTML executes, and mobile does not need an asynchronous popup. This also fixes existing stored artifacts without rewriting their bytes or hashes. The original task request remains JSON UTF-8 throughout submission/storage/runtime delivery.

Regression assertions in `apps/server/test/api.test.ts` cover Vietnamese artifact bytes/charset, live/finished task activity, inaccessible tasks, and task readers without runtime-log permission.
