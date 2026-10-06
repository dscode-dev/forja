# Art direction baseline

Anime fantasy with simple, expressive, charismatic characters. Include male and female characters. Use high-quality assets; the PR-07 2D baseline below is developer-approved, with physical quality/performance acceptance separate. Avoid overly perfect or ornamented fantasy designs and unnecessarily dark terminology.

Character identity should survive at mobile viewing sizes: clear silhouette, readable face/expression and restrained detail. Alquimista, Estrategista and Oráculo need distinct recognizable roles without obscuring the [AI contract](domains/ai.md).

RPG framing lives in characters, composition, missions, animation and feedback. Financial typography, currency, sign, estimate/actual status and dates remain immediately readable. Do not place critical amounts over busy artwork, rely on color alone or use fantasy labels as substitutes for financial terms. Plan scalable text, contrast and motion controls in UI specifications.

No production asset placeholders or unlicensed assets. Track source, commercial rights, attribution and modifications for shipped assets. Preview/concept art is explicitly non-production until reviewed for quality, rights and device budgets.

Before introducing new art styles or rendering formats, review references, tokens, motion/device budgets and provenance. Implementation still requires its scoped user authorization.

## PR-07 presentation pipeline

Approved on 2026-10-06: 2D anime, a welcoming urban atelier, adult male/female protagonists in everyday clothing, restrained modern fantasy. The original candidate artwork and exact prompts/hashes/rights record belong to [asset provenance](assets/PR-07-art.md); visual/compression review on device and final distribution review remain open. Do not infer the user's gender/career/financial health from the catalogue selection. Current idle is a static neutral pose; no financial mood, reward/XP or invented animation. PresentationArt holds separate world, neutral/warm portraits and optional idle frames; replacement preserves the UI/session contract. No equipment/customization persistence is approved.

Tokens: cream canvas #F5F2E8; paper #FFFDF7; ink #253133; primary sage #284E46; secondary ink #4E5855; borders #D5D8CA. Body 17, captions 15, values 24, headings 21/28 reference units; explicit +20% comfort mode, wrapping text and ≥48-unit actions. Four primary text destinations, contextual Accounts/Work and opaque money surfaces keep critical values away from illustration. Semantic words accompany every financial state; color alone carries no financial meaning. Motion reduction defaults on. Typography uses Unity's bundled runtime font pending a separately licensed typography change.

Original PNG source retained unchanged: 1536×1024 world, 1024×1536 transparent characters. Explicit Editor import: 2D Default/sRGB, max edge 1024, no mipmaps, non-readable, bilinear/clamp, character alpha, iOS ASTC 6×6. Maximum three baseline textures and ≤10 MiB RGBA-equivalent decoded pixels; compressed texture allocation/driver overhead is measured on device, not inferred from PNG size. Equal character resolution/quality. Optional authored idle frames require a revised budget and device check; current set has none. No particles, 3D world, physics, runtime remote asset download or per-frame scene animation loop.

Reference device: iPhone 15 Pro Max; portrait UI uses current Screen.safeArea and geometry-dependent insets, vertical scrolling and flexible four-destination navigation. Other iPhone ratios require visual checks before supported-device claims. Layout/world view are rebuilt on navigation/session/preference changes, never an Update allocation loop; Update only checks safe-area/dimensions. Profiler marker Forja.UI.Render identifies presentation work without private fields.
