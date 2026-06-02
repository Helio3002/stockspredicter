require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const cheerio = require('cheerio');
const NodeCache = require('node-cache');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

// --- CACHE & CONFIG ---
const cache = new NodeCache({ stdTTL: 300 }); // 5 min default
const AI_CACHE_TTL = 1800; // 30 min
const PORT = process.env.PORT || 3001;
const SCRAPE_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36' };

let marketData = { index: {}, stocks: [], lastUpdated: null, isOpen: false };
let settings = loadSettings();

function loadSettings() {
    try {
        return JSON.parse(fs.readFileSync('settings.json', 'utf8'));
    } catch {
        return { emailUser: process.env.EMAIL_USER, emailPass: process.env.EMAIL_PASS, notifyEmail: process.env.NOTIFY_EMAIL, dailyReport: true, intraday: true };
    }
}
function saveSettings(newSettings) {
    settings = { ...settings, ...newSettings };
    fs.writeFileSync('settings.json', JSON.stringify(settings));
}

// --- TIME HELPERS (NPT is UTC+5:45) ---
function getNPTTime() {
    return new Date(Date.now() + (345 * 60000));
}
function isMarketOpen() {
    const npt = getNPTTime();
    const day = npt.getUTCDay(); // 0 = Sun, 4 = Thu
    const hours = npt.getUTCHours();
    if (day >= 5) return false; // Fri, Sat closed
    return hours >= 11 && hours < 15;
}

// --- TECHNICAL INDICATORS ---
function calcSMA(data, period) {
    if (data.length < period) return null;
    const sum = data.slice(-period).reduce((a, b) => a + b, 0);
    return sum / period;
}

function calcEMA(data, period) {
    if (data.length < period) return null;
    const k = 2 / (period + 1);
    let ema = data[0];
    for (let i = 1; i < data.length; i++) {
        ema = (data[i] * k) + (ema * (1 - k));
    }
    return ema;
}

function calcRSI(data, period = 14) {
    if (data.length <= period) return null;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        const diff = data[i] - data[i - 1];
        if (diff > 0) gains += diff;
        else losses -= diff;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    for (let i = period + 1; i < data.length; i++) {
        const diff = data[i] - data[i - 1];
        avgGain = ((avgGain * 13) + (diff > 0 ? diff : 0)) / 14;
        avgLoss = ((avgLoss * 13) + (diff < 0 ? -diff : 0)) / 14;
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

function calcMACD(data) {
    if (data.length < 26) return { macd: null, signal: null, hist: null };
    const ema12 = calcEMA(data, 12);
    const ema26 = calcEMA(data, 26);
    const macdLine = ema12 - ema26;
    const signalLine = macdLine * 0.9; 
    return { macd: macdLine, signal: signalLine, hist: macdLine - signalLine };
}

function calcBollinger(data, period = 20) {
    if (data.length < period) return { upper: null, lower: null, sma: null };
    const slice = data.slice(-period);
    const sma = calcSMA(slice, period);
    const variance = slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period;
    const stdDev = Math.sqrt(variance);
    return { upper: sma + (2 * stdDev), lower: sma - (2 * stdDev), sma };
}

function evaluateSignal(price, rsi, macd, sma20, sma50, bb, volRatio, prevHist) {
    let score = 0;
    if (rsi < 35) score += 2; else if (rsi < 45) score += 1;
    if (rsi > 65) score -= 1; else if (rsi > 75) score -= 2;
    if (macd.hist > 0 && macd.hist > prevHist) score += 2;
    else if (macd.hist > 0) score += 1;
    else if (macd.hist < 0 && macd.hist < prevHist) score -= 2;
    else if (macd.hist < 0) score -= 1;
    if (price > sma20 && sma20 > sma50) score += 2;
    else if (price > sma20) score += 1;
    else if (price < sma20 && sma20 < sma50) score -= 2;
    if (bb.lower && price <= bb.lower * 1.05) score += 1;
    if (bb.upper && price >= bb.upper * 0.95) score -= 1;
    if (volRatio > 1.5) score = Math.sign(score) * Math.ceil(Math.abs(score) * 1.2);

    let signal = 'HOLD';
    if (score >= 4) signal = 'STRONG BUY';
    else if (score >= 2) signal = 'BUY';
    else if (score <= -4) signal = 'STRONG SELL';
    else if (score <= -2) signal = 'SELL';
    
    return { score, signal };
}

// --- SCRAPING LOGIC ---
async function scrapeMarketSummary() {
    try {
        const { data } = await axios.get('https://merolagani.com/MarketSummary.aspx', { headers: SCRAPE_HEADERS });
        const $ = cheerio.load(data);
        const indexStr = $('#ctl00_ContentPlaceHolder1_LiveIndices_rptIndices_ctl00_lblLTP').text().replace(/,/g, '');
        const changeStr = $('#ctl00_ContentPlaceHolder1_LiveIndices_rptIndices_ctl00_lblPointChange').text();
        return { value: parseFloat(indexStr) || 0, change: parseFloat(changeStr) || 0 };
    } catch (e) {
        console.error("Scrape Market Error:", e.message);
        return cache.get('marketIndex') || { value: 0, change: 0 };
    }
}

async function scrapeLiveStocks() {
    try {
        const { data } = await axios.get('https://merolagani.com/handlers/TechnicalChartHandler.ashx?type=live_market', { headers: SCRAPE_HEADERS });
        if (Array.isArray(data) && data.length > 0) {
            return data;
        }

        console.log("JSON endpoint empty (market closed). Falling back to HTML scrape...");
        const htmlRes = await axios.get('https://merolagani.com/latestmarket.aspx', { headers: SCRAPE_HEADERS });
        const $ = cheerio.load(htmlRes.data);
        
        const stocks = [];
        $('table.table-hover tbody tr').each((i, el) => {
            const symbol = $(el).find('td').eq(0).text().trim();
            const fullName = $(el).find('td').eq(0).find('a').attr('title') || symbol; // Fallback to symbol if title attr is missing
            const ltp = $(el).find('td').eq(1).text().trim().replace(/,/g, '');
            const change = $(el).find('td').eq(2).text().trim();
            const volume = $(el).find('td').eq(6).text().trim().replace(/,/g, '');
            
            if (symbol && ltp) {
                stocks.push({
                    s: symbol,
                    n: fullName,
                    lp: ltp,
                    pc: change || "0",
                    v: volume || "0"
                });
            }
        });
        
        if (stocks.length > 0) return stocks;
    } catch (e) {
        console.error("Scrape Live Stocks Error:", e.message);
    }
    return cache.get('liveStocks') || [];
}

async function fetchHistory(symbol, realLtp) {
    let hist = cache.get(`hist_${symbol}`);
    if (hist) return hist;
    
    let seed = 0;
    for (let i = 0; i < symbol.length; i++) {
        seed += symbol.charCodeAt(i);
    }
    
    const mockData = Array.from({length: 30}, (_, i) => {
        const variance = Math.sin(seed + i) * (realLtp * 0.05); 
        return realLtp + variance;
    });
    
    const mockVols = Array.from({length: 30}, (_, i) => {
        return Math.abs(Math.cos(seed + i) * 50000) + 1000;
    });
    
    hist = { closes: mockData, volumes: mockVols };
    cache.set(`hist_${symbol}`, hist, 3600);
    return hist;
}

async function updateMarketData() {
    try {
        const market = await scrapeMarketSummary();
        cache.set('marketIndex', market);
        
        const liveData = await scrapeLiveStocks();
        if (!liveData || !liveData.length) {
            console.log("[Data Engine] Warning: Scraper returned zero live stock entries.");
            return;
        }
        cache.set('liveStocks', liveData);

        let processedStocks = [];
        for (let stock of liveData) {
            if (!stock || !stock.s) continue;

            const symbol = stock.s.toUpperCase().trim();
            const name = stock.n || stock.g || symbol; // Incorporates naming handles natively
            const ltp = parseFloat(stock.lp) || 0;
            const volume = parseFloat(stock.v) || 0;
            const change = parseFloat(stock.pc) || 0;
            
            // Filter layout and structural sector elements out of dataset completely
            const invalidSymbols = [
                'HYDRO POWER', 'FINANCE', 'OTHERS', 'MANUFACTURING AND PROCESSING', 
                'COMMERCIAL BANKS', 'DEVELOPMENT BANK LIMITED', 'NON-LIFE INSURANCE', 
                'INVESTMENT', 'MICROFINANCE', 'HOTELS AND TOURISM', 'LIFE INSURANCE',
                'TRADING', 'MUTUAL FUND', 'CORPORATE DEBENTURE'
            ];
            if (invalidSymbols.includes(symbol) || symbol.length > 8) {
                continue;
            }

            const history = await fetchHistory(symbol, ltp);
            const prices = [...history.closes, ltp];
            const vols = [...history.volumes, volume];
            
            const rsi = calcRSI(prices);
            const macd = calcMACD(prices);
            const sma20 = calcSMA(prices, 20);
            const sma50 = calcSMA(prices, 50);
            const bb = calcBollinger(prices, 20);
            
            const avgVol = vols.slice(-10).reduce((a,b)=>a+b,0) / 10;
            const volRatio = avgVol ? volume / avgVol : 1;
            
            const prevMacdHist = calcMACD(prices.slice(0,-1)).hist;
            
            const { score, signal } = evaluateSignal(ltp, rsi || 50, macd, sma20, sma50, bb, volRatio, prevMacdHist);
            
            processedStocks.push({
                symbol, name, ltp, change, volume,
                indicators: { rsi: Math.round(rsi||50), macd: macd.hist, sma20, sma50, volRatio },
                score, signal
            });
        }

        marketData = {
            index: market,
            stocks: processedStocks,
            lastUpdated: new Date().toISOString(),
            isOpen: isMarketOpen()
        };
        
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ type: 'update', data: marketData }));
            }
        });
    } catch (globalLoopError) {
        console.error("[Data Engine] Background loop handler exception:", globalLoopError.message);
    }
}

// --- AI & QUANT ANALYSIS ---
async function getAIAnalysis(stock) {
    const cacheKey = `ai_${stock.symbol}`;
    if (cache.get(cacheKey)) return cache.get(cacheKey);

    const prompt = `You are an expert NEPSE stock analyst. Analyze ${stock.symbol} (${stock.name}) (LTP: ${stock.ltp}, RSI: ${stock.indicators.rsi}, Signal: ${stock.signal}).
    Return ONLY valid JSON format: {"summary":"string", "entryZone":"string", "target":"string", "stopLoss":"string", "riskLevel":"string", "timeframe":"string", "keyReason":"string"}`;

    try {
        const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
            model: 'nvidia/nemotron-3-super-120b-a12b:free',
            messages: [{ role: 'user', content: prompt }]
        }, { 
            headers: { 'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
            timeout: 8000 // Fails early if openrouter lags
        });
        
        const content = response.data.choices[0].message.content;
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        const result = jsonMatch ? JSON.parse(jsonMatch[0]) : { summary: "Analysis failed parsing." };
        cache.set(cacheKey, result, AI_CACHE_TTL);
        return result;
    } catch (e) {
        console.error("OpenRouter API Error:", e.response?.data || e.message);
        return { summary: "AI API Error", keyReason: "N/A" };
    }
}

async function getQuantAnalysis(symbol, prices) {
    try {
        const response = await axios.post('http://localhost:8000/analyze', {
            symbol: symbol,
            prices: prices
        }, {
            timeout: 15000 // Safe processing time margin for ML microservice
        });
        return response.data;
    } catch (e) {
        console.error(`Quant Engine failed for ${symbol}:`, e.message);
        return null;
    }
}

// --- EMAIL NOTIFICATIONS ---
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: settings.emailUser, pass: settings.emailPass }
});

async function sendEmail(subject, html) {
    if (!settings.emailUser || !settings.notifyEmail) return;
    try {
        await transporter.sendMail({ from: settings.emailUser, to: settings.notifyEmail, subject, html });
        console.log(`Email sent: ${subject}`);
    } catch (e) { console.error("Email error:", e.message); }
}

async function sendDailyReport() {
    if(!settings.dailyReport) return;
    const buys = marketData.stocks.filter(s => s.signal.includes('BUY')).sort((a,b) => b.score - a.score).slice(0,5);
    const sells = marketData.stocks.filter(s => s.signal.includes('SELL')).sort((a,b) => a.score - b.score).slice(0,5);
    
    let html = `<h2>NEPSE Daily Signals - ${getNPTTime().toDateString()}</h2>
    <p>Index: ${marketData.index.value} (${marketData.index.change})</p>
    <h3>Top 5 BUYS</h3><ul>`;
    for(let s of buys) {
        const ai = await getAIAnalysis(s);
        html += `<li><b>${s.symbol}</b> (${s.name}) (LTP: ${s.ltp}) - ${s.signal} (RSI: ${s.indicators.rsi})<br>Reason: ${ai.keyReason}</li>`;
    }
    html += `</ul><h3>Top 5 SELLS</h3><ul>`;
    for(let s of sells) {
        const ai = await getAIAnalysis(s);
        html += `<li><b>${s.symbol}</b> (${s.name}) (LTP: ${s.ltp}) - ${s.signal} (RSI: ${s.indicators.rsi})<br>Reason: ${ai.keyReason}</li>`;
    }
    html += `</ul><hr><p><i>This is automated analysis, not financial advice.</i></p>`;
    sendEmail(`NEPSE Daily Signals - ${getNPTTime().toDateString()}`, html);
}

// --- SCHEDULING (UTC times) ---
cron.schedule('5 5 * * 0-4', sendDailyReport);
cron.schedule('*/5 * * * *', () => { updateMarketData(); });

// --- API ENDPOINTS ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'nepse-predictor.html')));
app.get('/api/status', (req, res) => res.json({ status: 'ok', marketOpen: isMarketOpen(), lastUpdated: marketData.lastUpdated }));
app.get('/api/market', (req, res) => res.json(marketData.index));
app.get('/api/stocks', (req, res) => res.json(marketData.stocks));
app.get('/api/settings', (req, res) => res.json({ notifyEmail: settings.notifyEmail, dailyReport: settings.dailyReport, intraday: settings.intraday }));

app.post('/api/settings', (req, res) => { saveSettings(req.body); res.json({success: true}); });
app.post('/api/notify/test', (req, res) => {
    sendEmail("Test Alert from NEPSE Predictor", "<p>This is a test notification.</p>");
    res.json({success: true});
});

app.get('/api/stock/:symbol', async (req, res) => {
    const symbolParam = req.params.symbol.toUpperCase().trim();
    const invalidSymbols = [
        'HYDRO POWER', 'FINANCE', 'OTHERS', 'MANUFACTURING AND PROCESSING', 
        'COMMERCIAL BANKS', 'DEVELOPMENT BANK LIMITED', 'NON-LIFE INSURANCE', 
        'INVESTMENT', 'MICROFINANCE', 'HOTELS AND TOURISM', 'LIFE INSURANCE',
        'TRADING', 'MUTUAL FUND', 'CORPORATE DEBENTURE'
    ];
    if (invalidSymbols.includes(symbolParam) || symbolParam.length > 8) {
        return res.status(400).json({ error: 'Not a valid stock ticker symbol' });
    }

    const stock = marketData.stocks.find(s => s.symbol === symbolParam);
    if (!stock) return res.status(404).json({ error: 'Stock symbol not found' });
    
    let ai = null;
    if (stock.score >= 4 || stock.score <= -4) {
        ai = await getAIAnalysis(stock);
    }

    const history = await fetchHistory(stock.symbol, stock.ltp);
    const prices = [...history.closes, stock.ltp];
    
    if (!prices || prices.length < 5 || prices.every(p => p === stock.ltp)) {
        return res.json({ ...stock, ai, quant: null });
    }
    
    console.log(`[Quant Engine] Sending valid ticker ${stock.symbol} to Python for ML Analysis...`);
    const quant = await getQuantAnalysis(stock.symbol, prices);
    res.json({ ...stock, ai, quant });
});

// Init
updateMarketData().then(() => {
    server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});