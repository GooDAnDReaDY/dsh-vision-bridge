---
name: doc-intelligence
description: Playbook for extracting structured data, LaTeX formulas, complex tables, and text from PDF documents and images with dsh-vision-bridge.
---

# doc-intelligence — Document & Data Extraction Playbook

Use this skill when the user provides documents, PDF files, invoices, receipts, spreadsheets, or scientific papers and requests text, formulas, tables, or JSON extraction.

## Workflow & Tool Selection

1. **PDF Documents & Direct Uploads:**
   - If user uploads or references a `.pdf` file, the plugin automatically renders pages to 150 DPI PNGs via `/upload-pdf`.
   - Work with the generated page attachments sequentially.

2. **Mathematical Formulas & Equations (#141):**
   - Tool: `vision_extract_formula`
   - Arguments: `{ attachmentId, format: 'latex' | 'katex' | 'asciimath' }`
   - Accurately captures sub/superscripts, fractions (`\frac`), matrices, Greek symbols, integrals, and summations.

3. **Complex Tables & Spreadsheets (#142):**
   - Tool: `vision_extract_table`
   - Arguments: `{ attachmentId, format: 'markdown' | 'html' | 'csv' | 'json' }`
   - Preserves column alignments, merged cells (`colspan`/`rowspan`), currencies, and numeric precision.

4. **Structured Invoices, Receipts & Forms (#144):**
   - Tool: `vision_extract_structured`
   - Arguments: `{ attachmentId, schema: 'total, date, vendor, items, tax', documentType: 'invoice' | 'receipt' | 'passport' }`
   - Returns strict typed JSON matching the requested schema.

5. **Barcodes & QR Codes (#143):**
   - Tool: `vision_scan_barcode`
   - Decodes QR URLs, EAN-13, UPC, and Code-128 without LLM token waste.
