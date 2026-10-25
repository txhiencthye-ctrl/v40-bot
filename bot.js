const fs = require('fs');
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT = process.env.TG_CHAT;
const BINANCE = 'https://fapi.binance.com/fapi/v1';

async function fetchJson(url) {
    try { const r = await fetch(url); if (r.ok) return await r.json(); } catch (e) {}
    return null;
}

async function sendTG(msg) {
    if (!TG_TOKEN || !TG_CHAT) return;
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TG_CHAT, text: msg, parse_mode: 'HTML' })
    });
}

function calcEMA(closes, p) { const e = new Array(closes.length).fill(0); let s = 0, k = 2 / (p + 1); for (let i = 0; i < closes.length; i++) { s += closes[i]; e[i] = i < p ? s / (i + 1) : closes[i] * k + e[i - 1] * (1 - k); } return e; }
function calcATR(k, p) { const a = new Array(k.length).fill(0); if (k.length <= p) return a; const tr = [0]; for (let i = 1; i < k.length; i++) tr.push(Math.max(k[i].h - k[i].l, Math.abs(k[i].h - k[i - 1].c), Math.abs(k[i].l - k[i - 1].c))); let s = 0; for (let i = 1; i <= p; i++) s += tr[i]; a[p] = s / p; for (let i = p + 1; i < k.length; i++) a[i] = (a[i - 1] * (p - 1) + tr[i]) / p; return a; }
function findPBLower(k, i, atr, ema50, ema200) { const a = atr[i], c = k[i].c; if (c < ema50[i]) return null; let pIdx = i, pv = -Infinity; for (let j = i - 20; j <= i; j++) if (k[j].h > pv) { pv = k[j].h; pIdx = j; } if (pIdx > i - 2 || pIdx < i - 12) return null; let sv = Infinity; for (let j = Math.max(0, pIdx - 20); j < pIdx; j++) if (k[j].l < sv) sv = k[j].l; const leg = pv - sv; if (leg < 3 * a) return null; const fib = (r) => pv - r * leg; let avgEntry = (fib(0.5) + fib(0.618)) / 2; let sl = sv - 0.75 * a; const risk = Math.abs(avgEntry - sl); if (!risk) return null; return { type: 'LONG', entryType: 'LIMIT', sigT: k[i].t, avgEntry, slTarget: sl, tpTarget: avgEntry + 3 * risk, rr: 3 }; }
function evaluateEngine(klines, i, s) { const isL = s.type === 'LONG'; const limit = s.avgEntry, slOrig = s.slTarget, tp = s.tpTarget; const risk = Math.abs(limit - slOrig); const last = klines.length - 1; let fillJ = -1, fillTime = null; if (s.entryType === 'MARKET') { fillJ = i; fillTime = klines[i].t; } else { for (let j = i + 1; j <= Math.min(i + 12, last); j++) { if (isL ? klines[j].l <= limit : klines[j].h >= limit) { fillJ = j; fillTime = klines[j].t; break; } } if (fillJ === -1) return { state: 'EXPIRED', netR: 0, fillTime: null }; } let finalState = 'RUNNING', closeIdx = -1, grossR = 0; for (let j = fillJ + 1; j <= last; j++) { if (isL ? klines[j].l <= slOrig : klines[j].h >= slOrig) { grossR = -1; finalState = 'SL'; closeIdx = j; break; } if (isL ? klines[j].h >= tp : klines[j].l <= tp) { grossR = s.rr; finalState = 'TP'; closeIdx = j; break; } if (j - fillJ >= 60) { finalState = 'TIME'; closeIdx = j; break; } } return { state: finalState, netR: grossR, grossR, fillTime, closeTime: closeIdx >= 0 ? klines[closeIdx].t : null }; }

async function main() {
    let state = { positions: {}, btcRegime: null, universe: [] };
    if (fs.existsSync('data.json')) state = JSON.parse(fs.readFileSync('data.json'));

    const tickers = await fetchJson(`${BINANCE}/ticker/24hr`);
    if (!tickers) return;
    
    // Cập nhật BTC
    const btcKl = await fetchJson(`${BINANCE}/klines?symbol=BTCUSDT&interval=4h&limit=200`);
    if (btcKl) {
        const closes = btcKl.map(x => parseFloat(x[4]));
        state.btcRegime = { price: closes[closes.length-1], ret30: (closes[closes.length-1]/closes[closes.length-180]-1)*100 };
        state.btcRegime.routerMode = state.btcRegime.ret30 > 3 ? 'V40_BULL' : 'OFF';
    }

    // Lấy top 30 coin
    const topCoins = tickers.filter(t => t.symbol.endsWith('USDT') && parseFloat(t.quoteVolume) > 10000000).sort((a,b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume)).slice(0, 30);
    state.universe = topCoins.map(c => c.symbol);

    for (const coin of topCoins) {
        const sym = coin.symbol;
        const kl = await fetchJson(`${BINANCE}/klines?symbol=${sym}&interval=4h&limit=300`);
        if (!kl) continue;
        
        const kc = kl.map(x => ({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] })).slice(0, -1);
        const closes = kc.map(x => x.c); const atr = calcATR(kc, 14); const ema50 = calcEMA(closes, 50); const ema200 = calcEMA(closes, 200);

        // Quét 180 nến gần nhất (30 ngày)
        for (let j = Math.max(210, kc.length - 180); j < kc.length; j++) {
            const sigL = findPBLower(kc, j, atr, ema50, ema200);
            if (sigL) {
                const key = `v40_${sym}_${sigL.sigT}`;
                if (!state.positions[key]) {
                    sigL.sym = sym; sigL.zone = 'LOWER';
                    sigL.eval = evaluateEngine(kc, j, sigL); sigL.state = sigL.eval.state;
                    state.positions[key] = sigL;
                    if (sigL.state === 'WAITING') await sendTG(`🎯 <b>SIGNAL</b> ${sym}`);
                }
            }
        }
    }

    fs.writeFileSync('data.json', JSON.stringify(state, null, 2));
}
main();
