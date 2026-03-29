```markdown
# Design System Document: The Precision Engine

## 1. Overview & Creative North Star
### The Creative North Star: "The Architectural Ledger"
In the world of B2B SaaS and lead automation, "clean" is often synonymous with "empty." This design system rejects that. Our North Star, **The Architectural Ledger**, treats data as a premium asset. We move beyond the "SaaS Template" look by utilizing high-contrast editorial typography (Manrope) against a clinical, functional body (Inter). 

The system breaks the rigid grid through **Intentional Asymmetry**: using wide gutters and left-heavy alignments to create a sense of forward momentum. We replace the "boxiness" of traditional dashboards with layered tonal surfaces, creating a UI that feels like a high-end physical tool—weighted, reliable, and expertly calibrated.

---

## 2. Colors & Surface Philosophy
The palette is rooted in deep navies and slate grays to establish authority, punctuated by a vibrant 'Action' Blue that serves as the system's pulse.

### The "No-Line" Rule
**Borders are a failure of hierarchy.** To maintain a premium feel, designers are prohibited from using 1px solid borders to section off the UI. Instead:
- Define boundaries through background color shifts (e.g., a `surface-container-low` section sitting on a `surface` background).
- Use white space (Token `8` or `10`) to create "invisible" gutters that guide the eye more effectively than a line ever could.

### Surface Hierarchy & Nesting
Treat the UI as a series of stacked architectural plates. 
- **Base Layer:** `surface` (#f7f9fb)
- **Primary Layout Blocks:** `surface-container-low` (#f2f4f6)
- **Interactive Cards/Modals:** `surface-container-lowest` (#ffffff) to provide "pop" without shadows.
- **Deep Content/Sidebars:** `surface-container-high` (#e6e8ea) for utility zones.

### Signature Textures
- **The Power Gradient:** For high-intent actions (Primary CTAs), use a subtle linear gradient from `primary` (#000000) to `primary_container` (#00174b). This adds a "weighted" feel that flat color lacks.
- **Glassmorphism:** For floating API status overlays or "Testing" states, use `surface_container_lowest` at 80% opacity with a `20px` backdrop-blur.

---

## 3. Typography
We use a dual-typeface system to balance "Data-Centricity" with "Editorial Authority."

- **Display & Headlines (Manrope):** These are our "Editorial" voices. Use `display-lg` and `headline-md` with tight letter-spacing (-0.02em) to give the tool a sophisticated, modern B2B brand presence.
- **Body & Labels (Inter):** The "Functional" voice. Inter is used for all data points, lead lists, and automation logic. 
- **The Hierarchy Strategy:** Large headlines in `on_surface` contrast against smaller, muted labels in `on_surface_variant`. This ensures the user knows *what* they are looking at before they dive into the *details*.

---

## 4. Elevation & Depth
We eschew the "Drop Shadow" in favor of **Tonal Layering**.

- **The Layering Principle:** Depth is achieved by "stacking." A lead selection card (`surface-container-lowest`) sits on a workspace background (`surface-container-low`). The contrast is subtle, professional, and reduces visual noise.
- **Ambient Shadows:** Only for detached elements (e.g., a floating automation builder node). Use a blur of `32px` at 6% opacity using the `on_surface` color.
- **The "Ghost Border" Fallback:** If accessibility requires a stroke (e.g., input focus), use `outline_variant` (#c6c6cd) at 20% opacity. 

---

## 5. Components

### API Connection States
Status is communicated through "Luminous Orbs" rather than text alone:
- **Connected:** `on_primary_container` (#497cff) with a soft outer glow.
- **Testing:** A pulse animation transitioning between `secondary` and `secondary_fixed_dim`.
- **Error:** `error` (#ba1a1a) text paired with an `error_container` background.

### Selection & Field Toggles
- **Checkboxes:** When checked, the checkbox uses `surface_tint` (#0053db) with a white glyph. Unchecked states should not be empty boxes; use a soft `surface-container-highest` fill to indicate "available space."
- **Toggles:** Use a "Slide-and-Fill" approach. The track should be `surface-container-high`, and the thumb should be `primary`. When active, the track transitions to `on_primary_container`.

### Buttons
- **Primary:** High-contrast `primary` background. No border. Use `label-md` uppercase for a "Precision Tool" feel.
- **Secondary:** `secondary_container` background with `on_secondary_container` text.
- **Tertiary:** No background. Use `on_surface_variant` with a subtle underline on hover.

### Lead Lists & Data Tables
- **Forbid Dividers:** Use vertical spacing (Token `4`) between rows. 
- **Alternating Tones:** Use `surface-container-low` and `surface-container-lowest` to differentiate rows.
- **Field Selection:** Use "Chips" (`secondary_fixed`) for tags like "Lead Score" or "Source."

---

## 6. Do’s and Don’ts

### Do:
- **Use Intentional Asymmetry:** Align high-level stats to the left and automation controls to the right to create a logical flow.
- **Embrace Breathing Room:** Use the Spacing Scale `16` (3.5rem) for major section padding. Lead scraping is data-heavy; the UI must feel airy to prevent fatigue.
- **Leverage Tonal Transitions:** Use `surface-dim` for inactive dashboard states to focus the user’s eye on active automation streams.

### Don’t:
- **Never use 100% Black for text:** Always use `on_surface` (#191c1e) to keep the "Editorial" feel soft on the eyes.
- **Avoid "The Grid Wall":** Do not place more than 3 data containers in a single horizontal row. It creates "clutter," the enemy of this system.
- **No Heavy Borders:** If you feel the urge to draw a line, try a background color shift or a `0.1rem` (Token `0.5`) padding increase instead. 

---

## 7. Spacing & Roundedness
- **Radius:** Use `md` (0.375rem) for most data containers to maintain a "crisp" feel. Use `full` only for status chips and action buttons to distinguish them from data blocks.
- **Spacing:** Stick to the `4` (0.9rem) and `8` (1.75rem) tokens for internal card padding to ensure a consistent rhythmic "beat" throughout the application.```