/**
 * NEPSE Predictor — Backend Proxy Server
 * Scrapes live stock data from Merolagani.com and Sharesansar.com
 * Exposes a clean REST API for the frontend
 *
 * Run: npm install && npm start
 * Server listens on http://localhost:3001
 */

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const NodeCache = require('node-cache');

const app = express();
const PORT = 3001;

// Cache data for 5 minutes to avoid hammering the sites
const cache = new NodeCache({ stdTTL: 300 });

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────────
// SHARED HTTP CLIENT
// ─────────────────────────────────────────────────
const http = axios.create({
  timeout: 12000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Cache-Control': 'no-cache',
  }
});

// ─────────────────────────────────────────────────
// SCRAPER: MEROLAGANI
// URL: https://merolagani.com/StockQuote.aspx?symbol=NABIL
// ─────────────────────────────────────────────────
async function scrapeFromMerolagani(symbol) {
  const url = `https://merolagani.com/StockQuote.aspx?symbol=${symbol.toUpperCase()}`;
  const { data } = await http.get(url);
  const $ = cheerio.load(data);

  const clean = (str) => (str || '').replace(/,/g, '').trim();
  const num = (str) => parseFloat(clean(str)) || null;

  // Merolagani layout — table rows with labels and values
  const ltp = num($('[id$="lblLTP"]').text()) || num($('.ltp').first().text());
  const change = clean($('[id$="lblChange"]').text() || $('.change').first().text());
  const pctChange = clean($('[id$="lblPerChange"]').text() || $('.per-change').first().text());
  const open = num($('[id$="lblOpen"]').text());
  const high = num($('[id$="lblHigh"]').text());
  const low = num($('[id$="lblLow"]').text());
  const prevClose = num($('[id$="lblPreviousClose"]').text());
  const volume = num($('[id$="lblVolume"]').text());
  const high52 = num($('[id$="lbl52WeekHigh"]').text());
  const low52 = num($('[id$="lbl52WeekLow"]').text());
  const marketCap = clean($('[id$="lblMarketCap"]').text());
  const eps = num($('[id$="lblEPS"]').text());
  const pe = num($('[id$="lblPE"]').text());
  const bookValue = num($('[id$="lblBookValue"]').text());
  const pbRatio = num($('[id$="lblPBV"]').text());

  if (!ltp) throw new Error('Could not parse Merolagani data for ' + symbol);

  return {
    source: 'merolagani',
    symbol: symbol.toUpperCase(),
    ltp,
    change: parseFloat(change) || null,
    pctChange: parseFloat(pctChange) || null,
    open, high, low, prevClose, volume,
    high52, low52, marketCap, eps, pe, bookValue, pbRatio
  };
}

// ─────────────────────────────────────────────────
// SCRAPER: SHARESANSAR
// URL: https://www.sharesansar.com/company/nabil
// ─────────────────────────────────────────────────
async function scrapeFromSharesansar(symbol) {
  const url = `https://www.sharesansar.com/company/${symbol.toLowerCase()}`;
  const { data } = await http.get(url);
  const $ = cheerio.load(data);

  const clean = (str) => (str || '').replace(/,/g, '').trim();
  const num = (str) => parseFloat(clean(str)) || null;

  // Sharesansar layout
  const ltp = num($('.company-ltp').first().text()) || num($('[class*="ltp"]').first().text());
  const change = num($('.company-change').first().text());
  const pctChange = num($('.company-percent').first().text());
  const open = num($('td:contains("Open")').next().text());
  const high = num($('td:contains("High")').next().text());
  const low = num($('td:contains("Low")').next().text());
  const volume = num($('td:contains("Volume")').next().text());
  const prevClose = num($('td:contains("Prev")').next().text());
  const high52 = num($('td:contains("52 Week High")').next().text());
  const low52 = num($('td:contains("52 Week Low")').next().text());
  const eps = num($('td:contains("EPS")').next().text());
  const pe = num($('td:contains("P/E")').next().text());
  const bookValue = num($('td:contains("Book Value")').next().text());

  if (!ltp) throw new Error('Could not parse Sharesansar data for ' + symbol);

  return {
    source: 'sharesansar',
    symbol: symbol.toUpperCase(),
    ltp, change, pctChange,
    open, high, low, prevClose, volume,
    high52, low52, eps, pe, bookValue
  };
}

// ─────────────────────────────────────────────────
// SCRAPER: MEROLAGANI MARKET SUMMARY (NEPSE index)
// ─────────────────────────────────────────────────
async function scrapeNepseIndex() {
  const url = 'https://merolagani.com/MarketSummary.aspx';
  const { data } = await http.get(url);
  const $ = cheerio.load(data);

  const clean = (str) => (str || '').replace(/,/g, '').trim();
  const num = (str) => parseFloat(clean(str)) || null;

  return {
    index: num($('[id$="lblIndex"]').text()) || num($('.index-value').first().text()),
    change: clean($('[id$="lblIndexChange"]').text()),
    pctChange: clean($('[id$="lblIndexPerChange"]').text()),
    turnover: clean($('[id$="lblTurnover"]').text()),
    totalTrades: clean($('[id$="lblTotalTrades"]').text()),
    tradedShares: clean($('[id$="lblTradedShares"]').text()),
    tradedCompanies: clean($('[id$="lblTradedCompanies"]').text()),
    source: 'merolagani'
  };
}

// ─────────────────────────────────────────────────
// SCRAPER: TOP GAINERS & LOSERS from Merolagani
// ─────────────────────────────────────────────────
async function scrapeTopMovers() {
  const url = 'https://merolagani.com/MarketSummary.aspx';
  const { data } = await http.get(url);
  const $ = cheerio.load(data);

  const parseTable = (tableSelector) => {
    const rows = [];
    $(tableSelector).find('tr').each((i, row) => {
      if (i === 0) return; // skip header
      const cells = $(row).find('td');
      if (cells.length < 3) return;
      rows.push({
        symbol: $(cells[0]).text().trim(),
        ltp: parseFloat($(cells[1]).text().replace(/,/g, '')) || null,
        change: $(cells[2]).text().trim(),
      });
    });
    return rows.slice(0, 10);
  };

  return {
    gainers: parseTable('[id$="gvTopGainer"]'),
    losers: parseTable('[id$="gvTopLoser"]'),
    active: parseTable('[id$="gvMostActive"]'),
  };
}

// ─────────────────────────────────────────────────
// SCRAPER: HISTORICAL PRICES from Merolagani
// ─────────────────────────────────────────────────
async function scrapeHistoricalPrices(symbol, days = 90) {
  const url = `https://merolagani.com/StockQuote.aspx?symbol=${symbol.toUpperCase()}`;
  const { data } = await http.get(url);
  const $ = cheerio.load(data);

  const prices = [];
  $('[id$="gvHistory"] tr, #ctl00_ContentPlaceHolder1_LiveTrading1_gvHistory tr').each((i, row) => {
    if (i === 0) return;
    const cells = $(row).find('td');
    if (cells.length < 4) return;
    const date = $(cells[0]).text().trim();
    const close = parseFloat($(cells[4]).text().replace(/,/g, '')) ||
                  parseFloat($(cells[3]).text().replace(/,/g, '')) || null;
    const volume = parseFloat($(cells[5]).text().replace(/,/g, '')) || null;
    const high = parseFloat($(cells[2]).text().replace(/,/g, '')) || null;
    const low = parseFloat($(cells[3]).text().replace(/,/g, '')) || null;
    if (close) prices.push({ date, close, high, low, volume });
  });

  return prices.slice(0, days);
}

// ─────────────────────────────────────────────────
// MERGE: combine data from both sources
// ─────────────────────────────────────────────────
function mergeStockData(ml, ss) {
  // Prefer Merolagani as primary, fill gaps with Sharesansar
  return {
    symbol: ml.symbol,
    ltp: ml.ltp || ss.ltp,
    change: ml.change ?? ss.change,
    pctChange: ml.pctChange ?? ss.pctChange,
    open: ml.open || ss.open,
    high: ml.high || ss.high,
    low: ml.low || ss.low,
    prevClose: ml.prevClose || ss.prevClose,
    volume: ml.volume || ss.volume,
    high52: ml.high52 || ss.high52,
    low52: ml.low52 || ss.low52,
    marketCap: ml.marketCap,
    eps: ml.eps || ss.eps,
    pe: ml.pe || ss.pe,
    bookValue: ml.bookValue || ss.bookValue,
    pbRatio: ml.pbRatio,
    sources: ['merolagani', 'sharesansar'],
    fetchedAt: new Date().toISOString()
  };
}

// ─────────────────────────────────────────────────
// API ROUTES
// ─────────────────────────────────────────────────

/**
 * GET /api/stock/:symbol
 * Returns merged stock data from both sources
 */
app.get('/api/stock/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const cacheKey = `stock_${symbol}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ ...cached, fromCache: true });

  const results = await Promise.allSettled([
    scrapeFromMerolagani(symbol),
    scrapeFromSharesansar(symbol)
  ]);

  const ml = results[0].status === 'fulfilled' ? results[0].value : null;
  const ss = results[1].status === 'fulfilled' ? results[1].value : null;

  if (!ml && !ss) {
    return res.status(404).json({
      error: `No data found for symbol: ${symbol}`,
      merolaganiError: results[0].reason?.message,
      sharesansarError: results[1].reason?.message
    });
  }

  const stockData = ml && ss ? mergeStockData(ml, ss) : (ml || ss);
  cache.set(cacheKey, stockData);
  res.json(stockData);
});

/**
 * GET /api/stock/:symbol/history?days=90
 * Returns historical price data
 */
app.get('/api/stock/:symbol/history', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const days = parseInt(req.query.days) || 90;
  const cacheKey = `history_${symbol}_${days}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ symbol, prices: cached, fromCache: true });

  try {
    const prices = await scrapeHistoricalPrices(symbol, days);
    if (!prices.length) throw new Error('No historical data');
    cache.set(cacheKey, prices);
    res.json({ symbol, prices, source: 'merolagani' });
  } catch (err) {
    res.status(500).json({ error: err.message, symbol });
  }
});

/**
 * GET /api/market
 * Returns NEPSE index summary
 */
app.get('/api/market', async (req, res) => {
  const cached = cache.get('market_summary');
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    const data = await scrapeNepseIndex();
    cache.set('market_summary', data);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/movers
 * Returns top gainers, losers, most active
 */
app.get('/api/movers', async (req, res) => {
  const cached = cache.get('movers');
  if (cached) return res.json({ ...cached, fromCache: true });

  try {
    const data = await scrapeTopMovers();
    cache.set('movers', data);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/stocks?symbols=NABIL,NICA,CHCL
 * Batch fetch multiple stocks (uses cache aggressively)
 */
app.get('/api/stocks', async (req, res) => {
  const symbols = (req.query.symbols || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!symbols.length) return res.status(400).json({ error: 'Provide ?symbols=SYM1,SYM2' });

  const results = await Promise.allSettled(
    symbols.map(sym => {
      const cached = cache.get(`stock_${sym}`);
      if (cached) return Promise.resolve(cached);
      return Promise.allSettled([scrapeFromMerolagani(sym), scrapeFromSharesansar(sym)])
        .then(([ml, ss]) => {
          const data = ml.status === 'fulfilled' && ss.status === 'fulfilled'
            ? mergeStockData(ml.value, ss.value)
            : (ml.status === 'fulfilled' ? ml.value : ss.value);
          cache.set(`stock_${sym}`, data);
          return data;
        });
    })
  );

  const data = {};
  results.forEach((r, i) => {
    data[symbols[i]] = r.status === 'fulfilled' ? r.value : { error: r.reason?.message };
  });
  res.json(data);
});

/**
 * GET /api/health
 * Health check + cache stats
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()) + 's',
    cache: { keys: cache.keys().length, stats: cache.getStats() },
    sources: ['merolagani.com', 'sharesansar.com']
  });
});

// ─────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🇳🇵 NEPSE Predictor Backend running on http://localhost:${PORT}`);
  console.log(`\nEndpoints:`);
  console.log(`  GET /api/stock/:symbol          → Stock quote (merged)`);
  console.log(`  GET /api/stock/:symbol/history  → Price history`);
  console.log(`  GET /api/market                 → NEPSE index`);
  console.log(`  GET /api/movers                 → Top gainers/losers`);
  console.log(`  GET /api/stocks?symbols=A,B,C   → Batch fetch`);
  console.log(`  GET /api/health                 → Server health\n`);
});
