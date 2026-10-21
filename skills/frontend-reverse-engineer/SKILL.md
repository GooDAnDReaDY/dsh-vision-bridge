---
name: frontend-reverse-engineer
description: Playbook for turning UI screenshots and wireframes into clean code, reconstructing user flows with Mermaid, and performing WCAG accessibility audits.
---

# frontend-reverse-engineer — UI & Design Reverse Engineering

Use this skill when the user uploads web/mobile screenshots, Figma mockups, or wireframes and asks to clone UI, inspect accessibility, or generate interaction diagrams.

## Workflow & Tool Selection

1. **Reconstruct User Flow (#163):**
   - Tool: `vision_ui_flow`
   - Arguments: `{ attachmentIds: ['screen1', 'screen2', 'screen3'], title: 'Onboarding Flow' }`
   - Reconstructs screen states, user actions, triggers, and renders a clean Mermaid (`graph TD`) flowchart.

2. **UI Code Generation (#170):**
   - Tool: `vision_to_code`
   - Arguments: `{ attachmentId, framework: 'react' | 'vue' | 'html-tailwind', styling: 'tailwind' | 'css-modules' }`
   - Generates pixel-accurate, semantic HTML/Tailwind/React code from the visual screenshot.

3. **WCAG Accessibility & Contrast Audit (#167):**
   - Tool: `vision_audit_accessibility`
   - Arguments: `{ attachmentId, standard: 'WCAG_AA' | 'WCAG_AAA' }`
   - Checks color contrast ratios (text vs background), touch target sizes (min 44x44px), and font readability.

4. **Spatial Layout & Bounding Boxes (#138):**
   - Tool: `vision_ui_layout`
   - Returns structured component tree `{ components: [{ type, bbox: [ymin, xmin, ymax, xmax], label }] }`.
