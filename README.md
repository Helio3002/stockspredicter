# 🇳🇵 NEPSE Predictor — Setup Guide

A full-stack NEPSE stock analysis app with live data from Merolagani.com and Sharesansar.com, technical indicators (RSI, MACD, Bollinger Bands), and AI-powered buy/sell signals via Claude.

---

## Files

```
nepse-predictor.html   ← Frontend (open in browser)
server.js              ← Backend proxy server
package.json           ← Node.js dependencies
README.md              ← This file
```

---

## Quick Start

### Step 1 — Install Node.js
Download from https://nodejs.org (version 18 or higher recommended)

### Step 2 — Install dependencies
Open a terminal in this folder and run:
```bash
npm install
```

### Step 3 — Start the backend server
```bash
npm start
```
You should see:
```
🇳🇵 NEPSE Predictor Backend running on http://localhost:3001
```

### Step 4 — Open the frontend
Open `nepse-predictor.html` directly in your browser (double-click it or drag it into Chrome/Firefox).

The status badge in the top-right will show **"Live data"** when the backend is connected, or **"Demo mode"** if the server isn't running.

---

## How It Works

### Data Sources
- **Merolagani.com** — primary source for LTP, 52-week range, P/E, EPS, historical prices
- **Sharesansar.com** — secondary source, fills in missing fields
- Data is cached for **5 minutes** so the sites aren't overloaded

### Signals Calculated
| Indicator | What it measures |
|-----------|-----------------|
| RSI (14) | Momentum — oversold (<35) = buy signal, overbought (>70) = sell signal |
| MACD | Trend direction — bullish/bearish crossover |
| SMA 20 / SMA 50 | Moving average crossovers (golden cross / death cross) |
| Bollinger Bands | Price extremes — near lower band = potential bounce |

### AI Analysis
Each stock gets a Claude AI narrative with:
- Entry zone (Rs X–Y)
- Price target
- Stop-loss level
- Risk rating and timeframe

---

## API Endpoints (Backend)

Once the server is running at `http://localhost:3001`:

| Endpoint | Description |
|----------|-------------|
| `GET /api/stock/NABIL` | Live quote for NABIL |
| `GET /api/stock/NABIL/history?days=90` | 90-day price history |
| `GET /api/market` | NEPSE index summary |
| `GET /api/movers` | Top gainers, losers, most active |
| `GET /api/stocks?symbols=NABIL,NICA,CHCL` | Batch fetch multiple stocks |
| `GET /api/health` | Server health + cache stats |

---

## Troubleshooting

**"Demo mode" shown even after starting the server**
- Make sure `npm start` shows no errors
- Check the server is at port 3001: open http://localhost:3001/api/health in your browser

**Stock data not loading**
- Merolagani and Sharesansar occasionally change their HTML structure. If scraping breaks, the app falls back to demo data automatically.
- You can check scraper errors at `http://localhost:3001/api/stock/NABIL` — any errors are shown in the JSON response.

**"npm not found"**
- Install Node.js from https://nodejs.org first

---

## Disclaimer

This app is for **educational and informational purposes only**. Stock predictions based on technical analysis are not guaranteed. Always do your own research before investing. NEPSE trading involves risk.
