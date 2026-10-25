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

async function main() {
    const stateFile = 'state.json';
    let state = { positions: {}, notified: {} };
    if (fs.existsSync(stateFile)) state = JSON.parse(fs.readFileSync(stateFile));

    console.log('Đang quét dữ liệu...');
    const tickers = await fetchJson(`${BINANCE}/ticker/24hr`);
    if (!tickers) return;

    const topCoins = tickers.filter(t => t.symbol.endsWith('USDT') && parseFloat(t.quoteVolume) > 10000000)
        .sort((a,b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume)).slice(0, 30);

    for (const coin of topCoins) {
        const sym = coin.symbol;
        // Lấy nến 3m để check khớp lệnh nhanh
        const kl = await fetchJson(`${BINANCE}/klines?symbol=${sym}&interval=3m&limit=5`);
        if (!kl || kl.length < 2) continue;
        
        const currentPrice = parseFloat(kl[kl.length-1][4]);
        
        // LOGIC TEST: Nếu có kèo nào đang chờ (WAITING) và giá hiện tại chạm Entry
        for (const key in state.positions) {
            const p = state.positions[key];
            if (p.sym === sym && p.state === 'WAITING') {
                const isLong = p.type === 'LONG';
                const hit = isLong ? (currentPrice <= p.avgEntry) : (currentPrice >= p.avgEntry);
                
                if (hit && !state.notified[key]) {
                    p.state = 'RUNNING';
                    state.notified[key] = true;
                    await sendTG(`🟢 <b>KHỚP LỆNH</b>\nCoin: <b>${sym}</b>\nEntry: ${p.avgEntry}\nGiá hiện tại: ${currentPrice}`);
                    console.log('Đã báo khớp:', sym);
                }
            }
        }
    }

    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    console.log('Hoàn tất!');
}
main();
