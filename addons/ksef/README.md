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
- **Multi-company** — each company has its own NIP, KSeF token and optional
  Fakturownia account.
- **Agent tools** — `ksef_list_invoices`, `ksef_create_invoice`,
  `ksef_send_invoice`, `ksef_mark_paid`, `ksef_sync`,
  `ksef_import_fakturownia`, `ksef_list_companies` are exposed over the
  app's MCP endpoint, so agents can issue and manage invoices.

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
  rejected rather than silently mis-declared.
- Sync reaches back at most 80 days (KSeF caps a query at 3 months) — older
  history comes from the Fakturownia import.
- Attachments and UPO downloads are not implemented.
- Cost invoices are metadata-only: their XML is not downloaded, so they have
  no line items in the detail view.
- Amount filters and bank-statement payment matching are future work.
