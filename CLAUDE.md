# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Telegram bot for warehouse/kitchen staff to create transfer (перемещение) requests. Two roles:
- **Kitchen**: staff selects products → list is sent as a message to a Telegram group (no iiko document)
- **Warehouse**: staff selects products → an internal transfer document is created in iiko (kitchen → warehouse) + message sent to the group

All operations are logged to Google Sheets.

## Commands

```bash
npm install      # Install dependencies
npm start        # Run the bot (node src/index.js)
npm run dev      # Run with nodemon (auto-restart on changes)
```

### Bot Commands
- `/start` — Main menu (choose role: Kitchen or Warehouse)
- `/refresh` — Reload products from iiko
- `/report` — Send daily report to the Telegram group
- `/help` — Show help

## Architecture

```
src/
├── index.js                    # Entry point: commands, callbacks, state machine, cron job
├── bot.js                      # Telegraf instance with logging middleware and error handler
├── config/env.js               # Environment variables validation & export
└── services/
    ├── iikoService.js          # iiko Server REST API v2 client (auth, products, transfer docs)
    └── googleSheetsService.js  # Google Sheets logging (append rows, update status, history, daily stats)
```

### User Flow State Machine

In-memory `userStates` Map tracks conversation state per user.

1. User selects **role** (Kitchen / Warehouse) → `search_product`
2. User types **product name** to search iiko nomenclature → selects from results → `enter_quantity`
3. User enters **quantity** (e.g. `5` or `5 кг`) → item added, back to `search_product`
4. User clicks "Переместить" → `confirm` → transfer executed

**Kitchen confirmation**: sends formatted message to `TRANSFER_GROUP_ID` + logs to Sheets (status: SENT)
**Warehouse confirmation**: creates iiko transfer document (kitchen → warehouse) + sends message to group + logs to Sheets (status: IIKO_OK/IIKO_ERROR)

State is cleared on `/start`, cancel, or completion.

### iiko Server API Integration

Uses iiko Server REST API v2 (not Cloud API). Key details:
- Auth: `GET /resto/api/auth` returns a session key string (expires ~15 minutes)
- `IikoService.ensureValidSession()` handles automatic re-authentication
- `makeRequest()` retries on 401/403 by re-authenticating (max 2 retries)
- Products endpoint returns **XML** (parsed with `fast-xml-parser`)
- Transfer documents: `POST /resto/api/v2/documents/outgoing`
- Products cache loaded at startup: `PRODUCTS` (in `index.js`)

### Google Sheets Structure

Sheet "Transfer Logs" columns (A-J):
`Timestamp | Role | Items (JSON) | Telegram ID | Username | iiko Document ID | iiko Doc Number | Status | Error Message | Raw Text`

Status lifecycle: `NEW` → `SENT` (kitchen) or `IIKO_OK` / `IIKO_ERROR` (warehouse)

All timestamps use `Asia/Novosibirsk` timezone.

### Daily Report

A cron job (`node-cron`) runs at 21:30 Novosibirsk time, sending a summary to `TRANSFER_GROUP_ID`. Also triggered manually via `/report`.

## Environment Variables

Required in `.env`:
- `TELEGRAM_BOT_TOKEN` — Bot token from @BotFather
- `GOOGLE_SHEET_ID` — Google Spreadsheet ID
- `GOOGLE_SERVICE_ACCOUNT_JSON` — Service account credentials (full JSON string)
- `IIKO_PASSWORD` — iiko Server API password

Optional:
- `IIKO_BASE_URL` — iiko Server URL (default: `https://shaurma-dzerzhinskogo-2-2.iiko.it:443/resto`)
- `IIKO_LOGIN` — iiko username (default: `Artem`)
- `KITCHEN_STORE_ID` — UUID of the Kitchen store in iiko
- `WAREHOUSE_STORE_ID` — UUID of the Warehouse store in iiko
- `TRANSFER_GROUP_ID` — Telegram group ID for transfer notifications
- `ADMIN_TELEGRAM_IDS` — Comma-separated admin Telegram IDs

## Key Implementation Details

- Product search in `bot.on('text')` filters `PRODUCTS` cache by `name.includes(searchLower)`, returns max 8 results
- Inline keyboard button callbacks are limited to 64 bytes; product IDs are passed as `select_product:{uuid}`
- Kitchen role only sends messages to the Telegram group, no iiko integration
- Warehouse role creates iiko transfer document (`documents/outgoing`) with `storeFrom: KITCHEN_STORE_ID` and `storeTo: WAREHOUSE_STORE_ID`
- The bot uses Telegraf's `editMessageText` for inline keyboard interactions to avoid message spam
