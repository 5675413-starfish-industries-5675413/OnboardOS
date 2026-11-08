# Frontend reference lock — November 8, 2026

Scope: the existing React/Vite application, from public sign-in through role dashboards, investigation, frozen review, and coaching settings. No new backend capability or simulated production state.

The user selected Stripe in Refero as the build target. This direct implementation supersedes the earlier Framer-only palette in document 16 for the actual application.

## References and decisions

| Decision | Source | Adaptation and role |
| --- | --- | --- |
| White canvas, navy text, compact type, violet interactions | Refero Stripe style `ff64110d-58dd-4e18-a500-0a95073943b1` | `#061b31` text, `#50617a` secondary text, `#533afd` actions, 4px controls and 6px panels; system sans fallback, no proprietary font dependency |
| Persistent navigation, thin dividers, generous page heading | [Stripe balance overview](https://refero.design/pages/5437adc9-5763-4b7c-ad7a-69ba8f66320a) | Existing routes and page-section anchors only; no decorative search or invented capabilities |
| Focused sign-in surface and strong primary action | [Stripe login](https://refero.design/pages/8ecc9826-f5cf-4314-a6df-6640f1d7834b) | Keep Cognito redirect, add product context; no duplicate password form |
| Settings grouped by purpose | [Stripe settings](https://refero.design/pages/91e811d7-8573-4f0c-879b-c524bcf5fe76) | Coaching section navigation and distinct save/publish area |
| Restrained technical content | Refero Tailscale style `5d884659-1d6b-4b82-8ccd-dbb0434667a8` | Borrow compact readable information density only; do not import red branding or large card radii |
| Code as explanatory content | Refero SST style `7b6c53c7-7145-476e-aed8-f2367eef3adb` | Monospace for actual configuration and evidence identifiers only |

Preserve: white surfaces, navy hierarchy, violet action/selection, fine borders, small radii, desktop workspace structure with mobile stacking. Gradients belong only to public decorative background. Semantic result colors retain their existing meanings. No fake charts, pass rates, customers, deployment badges, or new dependencies. Workflow sequencing and authority remain in existing contracts and handlers. The login workflow diagram explains steps; it is not execution evidence.

QA target: desktop and mobile renderings of login, role dashboards, session, review and coaching; keyboard focus, horizontal tables, loading/error/denial/empty states, and existing failure/authorization tests. Fixture-based browser checks must be labeled local UI checks, never AWS verification.
