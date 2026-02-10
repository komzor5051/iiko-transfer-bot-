# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Telegram bot for warehouse/kitchen staff to create transfer (перемещение) requests at ".Шаурма" restaurant in Novosibirsk. Two roles:
- **Kitchen (Кухня)**: staff selects products from catalog → list is sent as a message to a Telegram group (no iiko document)
- **Warehouse (Склад)**: staff selects products from catalog → an internal transfer document is created in iiko (**warehouse → kitchen**) + message sent to the group

All operations are logged to Google Sheets. All UI messages are in Russian. The bot only works in private chats — group messages are silently dropped by middleware in `bot.js`.

## Commands

```bash
npm install      # Install dependencies
npm start        # Run the bot (node src/index.js)
npm run dev      # Run with nodemon (auto-restart on changes)
```

No tests, no linter, no build step.

## Architecture

Monolith — all bot logic lives in `src/index.js` (~837 lines). Five source files:

- `src/index.js` — Commands, callbacks, state machine, CATALOG, cron job, startup
- `src/bot.js` — Telegraf instance: group-message filter, logging middleware, global error handler
- `src/config/env.js` — Environment variable validation (exits on missing required vars)
- `src/services/iikoService.js` — iiko Server REST API v2 client (auth, products, stores, transfer documents)
- `src/services/googleSheetsService.js` — Google Sheets CRUD (append rows, update status, history, daily stats)

### Product Selection: Catalog-Based (not text search)

Products are **NOT** searched by text input. A hardcoded `CATALOG` array in `index.js` defines categories (Овощи, Бакалея, Соуса, etc.) with product names. Users navigate: **category → product → quantity**.

Each catalog product name is matched to iiko nomenclature via `findProductInIiko()` (exact match first, then partial string match — bidirectional `includes()`). If no iiko match is found, the item is logged but skipped when creating the iiko document.

**To add/remove products**: edit the `CATALOG` array in `index.js`. Run the bot — startup logs show which catalog items matched/unmatched against iiko.

### User Flow State Machine

In-memory `userStates` Map tracks conversation state per user. States:

1. `/start` → choose role (Kitchen / Warehouse)
2. `select_category` → user picks a category from inline keyboard (`cat:{index}`)
3. User picks a product (`prod:{catIndex}:{prodIndex}`) → `enter_quantity`
4. User types quantity (e.g. `5` or `5 кг`) → item added → back to `select_category`
5. User clicks "Переместить" → `confirm` → transfer executed

State is cleared on `/start`, cancel, or completion. State is lost on bot restart (no persistence).

### Callback Data Format

Telegram inline keyboard callbacks (limited to 64 bytes):
- `role_kitchen`, `role_warehouse` — role selection
- `cat:{index}` — category selection (index into CATALOG array)
- `prod:{catIndex}:{prodIndex}` — product selection
- `finish_adding`, `confirm_transfer`, `retry_transfer`, `back_to_cats`, `cancel`, `back_to_menu`, `history`

### iiko Server API Integration

Uses iiko Server REST API v2 (not Cloud API). Key details:
- Base URL: `https://shaurma-dzerzhinskogo-2-2.iiko.it:443/resto`
- Auth: `GET /resto/api/auth?login=&pass=` returns a session key string (~15 min lifetime)
- `ensureValidSession()` handles automatic re-authentication
- `makeRequest()` retries on 401/403 by re-authenticating (max 2 retries)
- Products endpoint (`/resto/api/products`) and stores endpoint (`/resto/api/corporation/stores`) return **XML** (parsed with `fast-xml-parser`)
- Transfer document: `POST /resto/api/v2/documents/internalTransfer` with `storeFromId` = warehouse and `storeToId` = kitchen
- Products cache: loaded at startup into global `PRODUCTS` array in `index.js`; refreshed via `/refresh` command

### Google Sheets Structure

Sheet "Transfer Logs" columns (A-J):
`Timestamp | Role | Items (JSON) | Telegram ID | Username | iiko Document ID | iiko Doc Number | Status | Error Message | Raw Text`

Status lifecycle: `NEW` → `SENT` (kitchen) or `IIKO_OK` / `IIKO_ERROR` (warehouse)

All timestamps use `Asia/Novosibirsk` timezone.

### Daily Report

Cron job (`node-cron`) at 21:30 Novosibirsk time sends summary to `TRANSFER_GROUP_ID`. Also triggered manually via `/report`.

## Bot Commands

- `/start` — Main menu (role selection)
- `/help` — Usage instructions
- `/refresh` — Reload product nomenclature from iiko
- `/report` — Trigger daily report manually
- `/stores` — Debug: list all iiko stores with IDs (use to discover `KITCHEN_STORE_ID` / `WAREHOUSE_STORE_ID`)

## Environment Variables

Required (bot exits without these):
- `TELEGRAM_BOT_TOKEN`
- `GOOGLE_SHEET_ID`
- `GOOGLE_SERVICE_ACCOUNT_JSON` (full JSON string, not a file path)
- `IIKO_PASSWORD`

Optional (with defaults):
- `IIKO_BASE_URL` (default: `https://shaurma-dzerzhinskogo-2-2.iiko.it:443/resto`)
- `IIKO_LOGIN` (default: `Artem`)
- `KITCHEN_STORE_ID` — UUID of Kitchen store in iiko (required for warehouse transfers; discover via `/stores` command)
- `WAREHOUSE_STORE_ID` — UUID of Warehouse store in iiko (required for warehouse transfers; discover via `/stores` command)
- `TRANSFER_GROUP_ID` — Telegram group chat ID for notifications (hardcoded fallback: `-5104426077`)
- `ADMIN_TELEGRAM_IDS` — Comma-separated admin Telegram IDs

## Gotchas

- **README.md is stale** — describes an old "writeoff bot" with text-based parsing. The actual bot uses catalog-based product selection. Ignore README.md; use this file.
- **Transfer direction**: warehouse → kitchen (`storeFrom` = warehouse, `storeTo` = kitchen). The `formatGroupMessage()` displays "Склад -> Кухня".
- **XML responses**: iiko products and stores endpoints return XML, not JSON. Single-item XML responses may parse as objects instead of arrays — code uses `Array.isArray()` check.
- **No store IDs in `.env.example`**: `KITCHEN_STORE_ID` and `WAREHOUSE_STORE_ID` must be discovered using the `/stores` bot command, then added to `.env`.

## Deployment

Deployed on **Railway** (`railway.json` configured). Uses Nixpacks builder, `npm start`, auto-restart on failure (max 10 retries). No health check endpoint — bot uses long polling.
