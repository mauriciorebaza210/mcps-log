---
name: frontend-design
description: Creates polished, production-quality frontend interfaces and user experiences that match the existing application and brand.
---

# Frontend Design

Use this skill for all frontend design, UI, UX, onboarding, and walkthrough work.

## Design process

Before editing code:

- Inspect the existing interface, components, styles, and design patterns.
- Understand the complete user workflow.
- Match the existing brand rather than introducing an unrelated visual style.
- Present the proposed experience before implementation when changes are substantial.

## Visual quality

- Create a clear visual hierarchy.
- Match the portal's typography, spacing, colors, borders, shadows, and corner radiuses.
- Avoid generic template-looking interfaces.
- Keep interface copy concise and action-oriented.
- Use subtle, purposeful motion.
- Avoid unnecessary gradients, excessive animation, and decorative clutter.
- Ensure new UI looks intentional on desktop, tablet, and mobile.

## Accessibility

- Support keyboard navigation.
- Use visible focus states.
- Add appropriate ARIA labels.
- Maintain sufficient color contrast.
- Respect prefers-reduced-motion.
- Manage focus correctly for modals, popovers, and walkthrough steps.

## Walkthrough tutorials

When creating an onboarding walkthrough:

- Use a polished welcome screen before the spotlight tour.
- Highlight real interface elements using stable data-tour attributes.
- Never rely on generated class names, visible text, or deeply nested selectors.
- Keep the initial walkthrough focused on essential tasks.
- Keep each explanation short and action-oriented.
- Include Back, Next, Skip, Close, and Finish controls.
- Show progress such as “Step 3 of 10.”
- Automatically scroll targets into view.
- Ensure tooltips do not cover their highlighted targets.
- Handle missing, hidden, loading, or conditionally rendered targets safely.
- Support route changes, tabs, modals, collapsed navigation, and mobile layouts.
- Provide a manual way to restart the tutorial.
- Preserve all existing business logic.

## Validation

Test:

- Desktop and mobile layouts
- Narrow screens
- Modals and overlays
- Tooltip positioning
- Scrolling and clipping
- Stacking contexts and z-index
- Keyboard navigation
- Slow-loading data
- Missing walkthrough targets
- First-time and returning-user behavior