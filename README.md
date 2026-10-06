# Gold vs Markets

A small website that answers one question: **if you had kept buying since 2010, what would gold, silver, Bitcoin or a stock index have done for you, in your own currency, after inflation?**

The same purchases go into every asset on the same dates and for the same amounts, so the only difference is what the money bought.

## Features

- **Assets**: S&P 500, US small caps (Russell 2000), Nifty 50, FTSE (UK), Swiss (SMI), Sweden (OMX), Taiwan, gold, silver, Bitcoin, plus **your own stock or fund** (paste monthly prices; saved in the browser only).
- **22 currencies**: prices are converted from USD each month, so currency moves count.
- **Three ways to buy**: random months and amounts (with a 1,000-investor Monte Carlo), a fixed amount every month, or one lump sum.
- **Inflation**: every result shows the return after inflation, plus two benchmarks: "Keeping up with inflation" and "Cash under the mattress".
- **Any window**: pick start and end months from Jan 2010 to the latest month.
- **Shareable**: settings live in the URL, so "Copy link" reproduces the exact run.
- Works on phones and desktops, light and dark mode. No build step, no dependencies, no tracking.

## Run locally

The page loads `data/prices.json` with `fetch`, so open it through a local server, not by double-clicking the file:

```bash
cd gold-vs-markets
python3 -m http.server 8000
# open http://localhost:8000
```

## Deploy on Vercel (free)

1. Push this folder to a GitHub repository.
2. In Vercel: **Add New → Project → Import** the repository.
3. Framework preset: **Other**. Leave build command and output directory empty (it is a static site).
4. Deploy. Every push to `main` redeploys automatically.

**Custom domain**: buy a domain anywhere (Cloudflare, Namecheap, Porkbun…), then in Vercel open **Project → Settings → Domains → Add** and follow the DNS instructions (usually an `A` record to `76.76.21.21` for the root domain and a `CNAME` to `cname.vercel-dns.com` for `www`). HTTPS is automatic.

Any static host works too: GitHub Pages, Cloudflare Pages or Netlify. Just serve the folder as-is.

## Keeping the data fresh

`scripts/update_data.py` downloads month-end, dividend-adjusted prices from Yahoo Finance, month-end exchange rates and the US CPI, and rewrites `data/prices.json`. Months that Yahoo doesn't have (for example Bitcoin before Sep 2014) are kept from the existing file and rescaled so the series joins smoothly.

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r scripts/requirements.txt
python scripts/update_data.py
```

The GitHub Action in `.github/workflows/update-data.yml` runs this on the 3rd of every month and commits the result, which triggers a Vercel redeploy. You can also run it by hand from the repository's **Actions** tab.

### Adding an asset

1. Add `"<id>": "<Yahoo symbol>"` to `ASSETS` in `scripts/update_data.py`.
2. Add colour tokens `--a-<id>` to both the light and dark blocks at the top of `assets/styles.css`.
3. Run the update script. The new asset gets placeholder name and note fields in `data/prices.json`; edit them to taste.

## How the numbers are made

| | |
|---|---|
| Prices | Month-end, dividend-adjusted closes of US-listed ETFs (SPY, IWM, INDY, EWU, EWL, EWD, EWT, GLD, SLV). Fund fees are already inside the prices. Bitcoin is the spot price. |
| Purchase price | Each purchase happens on a random day: the price is interpolated (geometrically) between the previous and current month-end. "Every month" buys mid-month; "Lump sum" buys at the previous month-end. |
| Returns | Money-weighted annual return (XIRR) on the actual cash flows. |
| After inflation | Each purchase is restated in end-date money using CPI, then XIRR is recomputed. USD uses the US CPI-U; other currencies use an editable yearly rate (approximate 2010–2025 averages). |
| Currencies | Each month's USD price × that month's exchange rate. |

Index proxies are close but not identical to the local indexes: EWU ≈ FTSE 100, EWL ≈ SMI, EWD ≈ OMXS30, INDY ≈ Nifty 50 (with higher fees and Indian taxes at fund level). Bitcoin prices before 2013 come from tiny, unreliable exchanges; treat early-start Bitcoin results as an upper bound.

### Data sources

- ETF and Bitcoin prices (initial file): [digrin.com](https://www.digrin.com) price histories, [Coin Metrics](https://github.com/coinmetrics/data) for Bitcoin before May 2026; Yahoo Finance via `yfinance` for updates.
- Exchange rates: US Federal Reserve H.10 via [datasets/exchange-rates](https://github.com/datasets/exchange-rates) (monthly averages), then Yahoo Finance month-end rates.
- US CPI: Bureau of Labor Statistics CPI-U via [datasets/cpi-us](https://github.com/datasets/cpi-us).

## Disclaimer

This is a history lesson, not financial advice. Past returns say little about future returns, and the backtest ignores personal taxes, brokerage costs and spreads.

## License

MIT
