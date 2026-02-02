# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Telegram bot for warehouse staff to create write-off documents (акты списания) in iiko restaurant management system. Logs all operations to Google Sheets.

## Commands

```bash
npm install      # Install dependencies
npm start        # Run the bot
npm run dev      # Run with nodemon (auto-restart on changes)
```

### Bot Commands
- `/start` — Main menu
- `/writeoff` — Start writeoff flow
- `/refresh` — Reload stores and accounts from iiko
- `/help` — Show help

## Architecture

```
src/
├── index.js                    # Main entry point, bot commands & callback handlers
├── bot.js                      # Telegraf bot instance with middleware
├── config/env.js               # Environment variables validation & export
└── services/
    ├── iikoService.js          # iiko Server API client (REST API v2)
    └── googleSheetsService.js  # Google Sheets logging
```

### User Flow State Machine

The bot uses an in-memory `userStates` Map to track conversation state per user:
1. `select_account` → User selecting expense account
2. `waiting_items` → Waiting for text message with items to write off
3. `confirm` → Showing parsed items for confirmation

State is cleared on `/start`, `/writeoff`, cancel, or completion.

### iiko Server API Integration

Uses iiko Server REST API v2 (not Cloud API). Key endpoints:
- `GET /resto/api/auth` — Session authentication (returns session key)
- `GET /resto/api/corporation/stores` — List warehouses/stores
- `GET /resto/api/v2/entities/list?rootType=Account` — Expense accounts
- `POST /resto/api/v2/documents/writeoff` — Create write-off document

Session keys expire after ~15 minutes; `iikoService` handles automatic re-authentication.

### Writeoff Document Structure

```javascript
{
  dateIncoming: "2024-01-15T10:30",  // ISO format
  status: "NEW",                      // or "PROCESSED"
  storeId: "uuid",                    // Required: warehouse UUID
  accountId: "uuid",                  // Required: expense account UUID
  items: [{ productId: "uuid", amount: 5 }]
}
```

### Google Sheets Structure

Sheet "Writeoff Logs" columns (A-L):
`Timestamp | Store ID | Store Name | Account ID | Account Name | Raw Message | Parsed Items (JSON) | Telegram ID | iiko Document ID | iiko Doc Number | Status | Error Message`

Status values: `NEW` → `IIKO_OK` or `IIKO_ERROR`

## Environment Variables

Required in `.env`:
- `TELEGRAM_BOT_TOKEN` — Bot token from @BotFather
- `GOOGLE_SHEET_ID` — Google Spreadsheet ID
- `GOOGLE_SERVICE_ACCOUNT_JSON` — Service account credentials JSON
- `IIKO_PASSWORD` — iiko Server API password
- `IIKO_BASE_URL` — iiko Server URL (default: resto subdomain)
- `IIKO_LOGIN` — iiko username

## Item Parsing Format

Users send items as: `помидор 5 кг; огурец 3 кг` or one per line.
Supported units: кг, kg, г, g, л, l, шт, pcs.

### Product Matching

Products are loaded from iiko at startup and cached in `PRODUCTS`. The `matchItemsToProducts()` function matches user input to iiko nomenclature by:
1. Exact name match (case-insensitive)
2. Partial name match (contains)
3. Code/num match

Items without a match are shown with warning and skipped when creating the writeoff document.
