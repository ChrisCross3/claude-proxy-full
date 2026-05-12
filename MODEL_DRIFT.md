# Model registry
Single source of truth: `src/models/registry.ts` (`MODELS`).
Drift-Test: `src/__tests__/model-drift.test.ts`.
Historische Audit-Tabelle vor Phase-2-Refactor entfernt (Commit 8f4cbb1 hat MODEL_MAP/AVAILABLE_MODELS aufgelöst).
Beim Hinzufügen eines Modells: registry.ts editieren — Routen, /models, /metrics-Labels werden daraus abgeleitet.
