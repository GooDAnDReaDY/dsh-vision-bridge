---
name: image-qa-consensus
description: Playbook for visual inspection, multi-model consensus, pixel diffing, and searching visual memory.
---

# image-qa-consensus — Visual Inspection & Cross-Model Verification

Use this skill when high precision is required, when single-model hallucination must be eliminated, or when comparing before/after screenshots.

## Workflow & Tool Selection

1. **Multi-Model Consensus (#155):**
   - Tool: `vision_consensus`
   - Arguments: `{ attachmentId, question, minAgreement: 2 }`
   - Dispatches image to multiple vision providers concurrently, synthesizes agreed facts, and reports discrepancies.

2. **Visual Memory Semantic Search (#171):**
   - Tool: `vision_memory_search`
   - Arguments: `{ query: 'diagram with database', limit: 5 }`
   - Searches through all previously processed images and attachments in session memory.

3. **Visual Diffing & Temporal Comparison (#161, #149):**
   - Tools: `vision_diff` (semantic before/after), `vision_pixel_diff` (pixel-level heatmap overlay).
   - Ideal for regression testing UI updates.

4. **Self-Check Hypothesis Verification (#156):**
   - Tool: `vision_self_check`
   - Arguments: `{ attachmentId, hypothesis: 'The primary button is active and green' }`
   - Verifies visual assertions with confidence ratings (0-100%).
