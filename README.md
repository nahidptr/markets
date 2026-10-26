# Gold vs Markets

**What if you had kept buying gold, silver, Bitcoin or the world's stock markets since 2010?**
Pick your currency, how you would have bought, and what to compare. Every purchase goes into every asset on the same day and for the same amount, so the only difference is what the money bought. Every result is checked against inflation.

## Features

- **22 assets with flags**: S&P 500, Nasdaq 100, US small caps, Canada, Brazil, Europe, UK, Germany, France, Switzerland, Sweden, Japan, China, Hong Kong, South Korea, Taiwan, Australia, World (ACWI), Emerging Markets, gold, silver and Bitcoin.
- **Add a stock you know**: paste monthly prices for any stock or fund (stored in the browser only).
- **22 currencies**, converted month by month, so currency moves count.
- **Three ways to buy**: random months, amounts and days (plus a 1,000-investor simulation), a fixed amount every month, or one lump sum.
- **Inflation built in**: return after inflation for every asset, plus "Keeping up with inflation" and "Cash under the mattress" benchmarks.
- **Chart views**: value, gain %, value after inflation, price (start = 100) and drawdown, with a log scale and per-asset toggles.
- **Shareable**: every setting lives in the URL.
- **Mobile first**: sticky section tabs and a bottom-sheet for settings on phones; side-by-side layout on desktop. Light and dark mode.
- No tracking, no cookies, no backend.

## Develop

Requires Node 20+.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (simulation maths, data file checks, updater)
npm run build      # production build in dist/
npm run preview    # serve dist/ locally
```

Project layout:

```
index.html               page shell
src/main.js              UI, state, URL handling
src/sim.js               pure simulation maths (XIRR, schedules, inflation) – unit tested
src/chart.js             dependency-free SVG chart
src/styles.css           design tokens and layout (light + dark)
public/data/prices.json  all price, FX and CPI data
public/flags/            round flag and asset icons (flag-icons, MIT)
scripts/update-data.mjs  monthly data updater (no dependencies)
tests/                   node:test suites
```

## Keeping the data fresh

The data is updated automatically, so it never sits three months out of date:

1. `.github/workflows/update-data.yml` runs on the 2nd, 5th and 10th of every month. It downloads the latest month-end prices (Yahoo Finance), exchange rates and US CPI, runs the tests, and commits `public/data/prices.json` if anything changed.
2. Vercel sees the commit and redeploys within a minute.
3. If the data is ever more than two months old, the workflow fails (GitHub emails you) and the site shows an **outdated** badge next to the date.

To update by hand: `npm run update-data` (or **Actions → Update price data → Run workflow** on GitHub). `npm run check-data` tells you how old the data is.

> After pushing to GitHub, open **Settings → Actions → General → Workflow permissions** and choose **Read and write permissions**, so the workflow can commit.

### Adding an asset

Add an entry to `assets` in `public/data/prices.json` with `id`, `name`, `short`, `ticker` (Yahoo symbol), `group` (`americas`, `europe`, `asia`, `global`, `metals`, `crypto`), `flag` (a file name in `public/flags/`) and `note`, plus `"prices": []`. Run `npm run update-data` and the history is filled in.

## Deploy

**Vercel (free):** push to GitHub → Vercel → **Add New → Project** → import the repo. The Vite preset is detected (build `npm run build`, output `dist`). Every push to `main` redeploys.

**Custom domain:** buy one anywhere (Cloudflare, Namecheap, Porkbun…), then **Project → Settings → Domains → Add** in Vercel and follow the DNS instructions. HTTPS is automatic.

Cloudflare Pages, Netlify and GitHub Pages also work: build command `npm run build`, output folder `dist`.

## How the numbers are made

| | |
|---|---|
| Prices | Month-end, dividend-adjusted closes of US-listed ETFs (fees already deducted). Bitcoin is the spot price. |
| Purchase price | Interpolated geometrically between the previous and current month-end at the purchase day. |
| Returns | Money-weighted annual return (XIRR) on the actual cash flows. |
| After inflation | Each purchase restated in end-date money with CPI, then XIRR again. USD uses US CPI-U; other currencies use an editable yearly rate (approximate 2010–2025 averages). |
| Currencies | Each month's USD price × that month's exchange rate. |

Country ETFs track their markets closely but are not the exact local index (e.g. EWJ ≈ Nikkei/TOPIX, EWG ≈ DAX, EWU ≈ FTSE 100, FXI = FTSE China 50). Bitcoin prices before 2013 come from tiny exchanges; treat early-start Bitcoin results as an upper bound.

**Data sources.** Initial history: digrin.com price histories, Coin Metrics (Bitcoin), US Federal Reserve H.10 exchange rates (via github.com/datasets/exchange-rates), US BLS CPI-U (via github.com/datasets/cpi-us). Monthly updates: Yahoo Finance chart API and the same CPI dataset.

## Disclaimer

A history lesson, not financial advice. Past returns say little about future returns. Taxes, brokerage costs and spreads are not included.

## License

MIT. Flag icons from [flag-icons](https://github.com/lipis/flag-icons) (MIT).
