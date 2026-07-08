# Inventory OCR (bundled card)

Snap photos with your phone to organize, categorize, and count your stuff —
where things are, how many you have, and what they are.

This is a **bundled sample card** for the HTTP Server Manager. When the card
starts, `Start.sh` clones (or updates) the app from
[`tallen5431/InventoryOCR`](https://github.com/tallen5431/InventoryOCR),
creates a Python virtual environment, installs the requirements, and launches
the Dash web app.

## What it does

- 📷 **Phone-first capture** — the photo field opens your camera on mobile so you
  can snap items on the spot; attach multiple photos per item.
- 🗂️ **Organize** — give every item a **Category** and a **Location**, plus a
  **Quantity** and notes. Type-ahead suggests categories/locations you've used.
- 🔎 **Find fast** — search across name/category/location/notes, and filter the
  table by category and location.
- 📊 **At-a-glance totals** — KPI cards (items, total quantity, low-stock,
  categories) and an overview grouped by location and by category.
- 📤 **Export** — one-click CSV export of your whole inventory.
- 🧪 **OCR (optional)** — pull text off labels/boxes with the OCR Lab when the
  Tesseract binary is installed.

## Configuration

The card runs with these environment variables (edit them from the manager's
**Edit** dialog):

| Variable            | Default | Purpose |
| ------------------- | ------- | ------- |
| `HOST`              | `0.0.0.0` | Bind address |
| `PORT`              | `8001`  | Port the app listens on |
| `URL_PREFIX`        | *(empty)* | Serve at site root. Set to `/inventory` only behind a reverse proxy on that path. |
| `INVENTORY_OCR_BRANCH` | `main` | Branch of the InventoryOCR repo to run |
| `GITHUB_TOKEN`      | *(unset)* | GitHub PAT (repo read scope) if the repo is private |

## Data & persistence

Your inventory (`src/inventory.json`) and saved photos (`src/assets/`) live
inside the cloned `src/` folder and are ignored by git, so they survive
restarts and app updates (`git pull` never touches them).

## OCR dependency (optional)

Text extraction needs the Tesseract binary:

```bash
sudo apt-get install -y tesseract-ocr
```

Without it, the inventory features work normally and OCR simply returns empty
text.
