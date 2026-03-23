---
name: pdf-reader
description: Read and extract text from PDF files. Handles local files and URLs.
allowed-tools: Bash(pdf-reader:*),Bash(pdftotext:*),Bash(pdfinfo:*),Bash(curl:*)
---

# PDF Reader

Extract text from PDF files using pdftotext.

## Commands

```bash
# Extract text from local PDF
pdftotext /path/to/file.pdf -

# Get PDF info (pages, size, etc)
pdfinfo /path/to/file.pdf

# Fetch and read PDF from URL
curl -sL "<url>" -o /tmp/doc.pdf && pdftotext /tmp/doc.pdf -
```

## Tips
- Use `-layout` flag to preserve formatting: `pdftotext -layout file.pdf -`
- Use `-f N -l M` for specific pages: `pdftotext -f 1 -l 5 file.pdf -`
- Scanned PDFs (image-only) won't have extractable text
