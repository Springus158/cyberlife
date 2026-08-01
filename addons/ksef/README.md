# KSeF — Polish e-invoicing 🇵🇱

**This addon is built for the Polish market.** It integrates Cyber Life with
KSeF (Krajowy System e-Faktur), Poland's mandatory national e-invoicing
system, using the KSeF 2.0 REST API. If you don't invoice under Polish VAT
rules, this addon is not for you.

## What it does

- **Browse everything in one place** — your sales invoices and incoming cost
  invoices, pulled straight from KSeF (`Subject1`/`Subject2` metadata
  queries with an incremental `PermanentStorage` cursor).
- **Issue invoices without leaving the app** — builds FA(3) XML and submits
  it through an encrypted KSeF online session; the assigned KSeF number
  lands back on the invoice. Proformas stay local (they are not KSeF
  documents).
- **Track payments** — a manual paid/unpaid flag (KSeF knows nothing about
  payments), with an *Unpaid Invoices* widget and a *KSeF Today* widget for
  documents that arrived today.
- **Import your Fakturownia.pl history** — a one-time, re-runnable import of
  all invoices (numbers, payment statuses, contractors and `gov_id`, i.e.
  the KSeF number, which deduplicates the imported history against KSeF
  sync results). Numbering continues your Fakturownia pattern
  (`{nr}/{mm}/{yyyy}` tokens) and the print view mirrors Fakturownia's
  classic template.
- **Dual mode (per company)** — with *Tryb Fakturownia: Dual* the
  Fakturownia account stays the system of record: invoices created here are
  created there too (their numbering wins), the KSeF submission goes
  through Fakturownia's integration (`send_to_ksef`), paid/unpaid toggles
  are pushed to Fakturownia first, and every KSeF sync also refreshes the
  last 12 months from Fakturownia — both directions, deduplicated by KSeF
  number or invoice number + NIP. Switch the mode to *Wyłączony* for an
  entity that should talk to KSeF directly (no Fakturownia account
  needed).
- **Multi-company** — each company has its own NIP, KSeF token and optional
  Fakturownia account; exactly one company is active at a time (picker in
  the page bar scopes every page).
- **Bank statements (Wyciągi)** — upload iPKO Biznes statement PDFs (or the
  iPKO "HISTORIA BIEŻĄCA" export), automatic transaction↔invoice matching,
  row coloring by state, and a per-bank statement-mirror report for the
  accountant.
- **Invoice file archive (Pliki)** — original PDFs/scans of documents kept
  in the per-addon blob store (`~/.cyberlife/addon-data/ksef/files/…`,
  future R2 mirror), sha256-deduplicated. Files pair with invoice records
  automatically (NIP checksum + amounts + dates + number heuristics; OCR
  handled at import time); unmatched ones are browsable and can be paired
  by hand or turned into a new cost record. Every invoice table shows a
  PDF column with an inline preview; images (PNG/JPG) convert to PDF on
  upload.
- **Agent tools** — `ksef_list_invoices`, `ksef_create_invoice`,
  `ksef_send_invoice`, `ksef_mark_paid`, `ksef_sync`,
  `ksef_import_fakturownia`, `ksef_list_companies`,
  `ksef_list_unmatched_files`, `ksef_attach_file` are exposed over the
  app's MCP endpoint, so agents can issue and manage invoices and pair
  archived documents.

## Setup

1. Enable the addon (Settings → Addons → KSeF).
2. Settings → Addons → KSeF: add a company — name, NIP, KSeF token
   (generated in the MF taxpayer application for the company context),
   environment (`prod` unless testing).
3. Optional: fill the Fakturownia subdomain + API token and press
   **Import from Fakturownia**.
4. Open the **Invoices** module: `r` syncs with KSeF, `n` creates an
   invoice, `j`/`k` + `Enter` browse.

Tokens are stored in the app's state via addon storage, never in addon
files. All KSeF traffic goes through the app's addon HTTP proxy (the KSeF
API sends no CORS headers); allowed hosts are declared in `addon.json`.

**Credentials are agent-readable.** Addon storage is exposed through the
`addons_storage_get` tool, so any agent with the `addons` skill enabled can
read the KSeF and Fakturownia tokens kept here. Turn that skill off in
Settings → Agent Skills if that is not acceptable.

## Current limitations

- Correction invoices (korekty) are not issued from the addon yet — issue
  them in KSeF/Fakturownia and they'll appear via sync.
- Only the 23/8/5/0% VAT rates are supported; `zw`/`np` and other rates are
  rejected rather than silently mis-declared. The 0% rate is declared as
  **domestic** (`P_13_6_1`) — WDT and export need `P_13_6_2`/`_3` and are
  not supported.
- Sending requires the company address (FA(3) makes `Podmiot1/Adres`
  mandatory) — fill it in Settings before the first send.
- Sync reaches back at most 80 days (KSeF caps a query at 3 months) — older
  history comes from the Fakturownia import.
- KSeF rate-limits reads hard (metadata queries: 20/h, XML downloads: 64/h)
  and calls out sub-15-minute polling as misuse — sync on demand, not on a
  timer.
- Attachments and UPO downloads are not implemented.
- Cost invoices are metadata-only: their XML is not downloaded, so they have
  no line items in the detail view.
- The Fakturownia list API is not documented to include `gov_id` on list
  rows; if it is absent, imported invoices dedup against KSeF sync by
  number + seller NIP instead of the KSeF number.
- Amount filters and bank-statement payment matching are future work.
