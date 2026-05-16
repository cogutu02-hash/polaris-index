// ============================================
// POLARISINDEX — WORLD BANK DATA FETCHER
// lib/api-fetchers/world-bank.js
// Runs every 4 hours via GitHub Actions
// ============================================

const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// ─── WORLD BANK INDICATORS TO FETCH ───────────
const WB_INDICATORS = [
  // Economic Output
  { code: 'NY.GDP.MKTP.CD',    metric: 'economic_output',  label: 'GDP (current USD)',        weight: 0.4 },
  { code: 'NY.GDP.MKTP.KD.ZG', metric: 'economic_output',  label: 'GDP growth rate (%)',      weight: 0.3 },
  { code: 'NY.GDP.MKTP.PP.CD', metric: 'economic_output',  label: 'GDP PPP (current USD)',    weight: 0.3 },

  // Infrastructure
  { code: 'EG.ELC.ACCS.ZS',    metric: 'infrastructure',   label: 'Electricity access (%)',   weight: 0.4 },
  { code: 'IT.NET.USER.ZS',    metric: 'infrastructure',   label: 'Internet users (%)',       weight: 0.3 },

  // Human Capital
  { code: 'SE.XPD.TOTL.GD.ZS', metric: 'human_capital',   label: 'Education spend (% GDP)',  weight: 0.4 },
  { code: 'SP.DYN.LE00.IN',    metric: 'human_capital',   label: 'Life expectancy (years)',  weight: 0.4 },

  // Governance
  { code: 'RL.EST',             metric: 'governance',       label: 'Rule of law estimate',    weight: 0.35 },
  { code: 'CC.EST',             metric: 'governance',       label: 'Control of corruption',   weight: 0.35 },
  { code: 'PV.EST',             metric: 'governance',       label: 'Political stability',     weight: 0.3 },

  // Trade
  { code: 'NE.TRD.GNFS.ZS',   metric: 'trade_networks',   label: 'Trade (% of GDP)',        weight: 0.5 },
  { code: 'BX.KLT.DINV.WD.GD.ZS', metric: 'trade_networks', label: 'FDI inflows (% GDP)', weight: 0.5 },

  // Technology
  { code: 'GB.XPD.RSDV.GD.ZS', metric: 'technology',      label: 'R&D expenditure (% GDP)', weight: 0.5 },
  { code: 'IT.NET.USER.ZS',    metric: 'technology',       label: 'Internet penetration',    weight: 0.5 },

  // Environment
  { code: 'EG.ELC.RNEW.ZS',   metric: 'environmental_resilience', label: 'Renewable energy (%)', weight: 0.5 },
  { code: 'EN.ATM.CO2E.PC',   metric: 'environmental_resilience', label: 'CO2 per capita',       weight: 0.5 },

  // Natural Resources
  { code: 'EG.ELC.ACCS.ZS',   metric: 'natural_resources', label: 'Energy access',           weight: 0.5 },
]

// ─── FETCH ONE INDICATOR FROM WORLD BANK ──────
async function fetchIndicator(indicatorCode) {
  const url = `https://api.worldbank.org/v2/country/all/indicator/${indicatorCode}?format=json&per_page=300&mrv=1`

  console.log(`  Fetching: ${indicatorCode}`)

  const res = await fetch(url)
  if (!res.ok) throw new Error(`World Bank API error: ${res.status}`)

  const data = await res.json()

  // World Bank returns [metadata, data_array]
  if (!data[1]) return {}

  // Build map: iso3 → value
  const result = {}
  for (const row of data[1]) {
    if (row.value !== null && row.countryiso3code) {
      result[row.countryiso3code] = {
        value: row.value,
        year: row.date
      }
    }
  }

  return result
}

// ─── NORMALISE VALUE TO 0-100 ─────────────────
function normalise(value, min, max, invert = false) {
  if (value === null || value === undefined) return null
  const clamped = Math.min(Math.max(value, min), max)
  const normalised = ((clamped - min) / (max - min)) * 100
  return invert ? 100 - normalised : normalised
}

// ─── SCORING RULES PER METRIC ─────────────────
function scoreMetric(metricId, indicators) {
  switch (metricId) {

    case 'economic_output': {
      const gdp = indicators['NY.GDP.MKTP.CD']?.value
      const growth = indicators['NY.GDP.MKTP.KD.ZG']?.value
      const gdpScore = normalise(Math.log(gdp || 1), Math.log(1e8), Math.log(25e12))
      const growthScore = normalise(growth, -5, 10)
      if (!gdpScore) return null
      return (gdpScore * 0.7) + ((growthScore || 50) * 0.3)
    }

    case 'infrastructure': {
      const electricity = indicators['EG.ELC.ACCS.ZS']?.value
      const internet = indicators['IT.NET.USER.ZS']?.value
      const elScore = normalise(electricity, 0, 100)
      const intScore = normalise(internet, 0, 100)
      if (!elScore && !intScore) return null
      return ((elScore || 0) * 0.5) + ((intScore || 0) * 0.5)
    }

    case 'human_capital': {
      const education = indicators['SE.XPD.TOTL.GD.ZS']?.value
      const life = indicators['SP.DYN.LE00.IN']?.value
      const eduScore = normalise(education, 1, 8)
      const lifeScore = normalise(life, 50, 85)
      if (!lifeScore) return null
      return ((eduScore || 50) * 0.4) + ((lifeScore) * 0.6)
    }

    case 'governance': {
      const law = indicators['RL.EST']?.value
      const corruption = indicators['CC.EST']?.value
      const stability = indicators['PV.EST']?.value
      // WB governance indicators range from -2.5 to +2.5
      const lawScore = normalise(law, -2.5, 2.5)
      const corrScore = normalise(corruption, -2.5, 2.5)
      const stabScore = normalise(stability, -2.5, 2.5)
      if (!lawScore && !corrScore) return null
      return (
        ((lawScore || 50) * 0.35) +
        ((corrScore || 50) * 0.35) +
        ((stabScore || 50) * 0.30)
      )
    }

    case 'trade_networks': {
      const trade = indicators['NE.TRD.GNFS.ZS']?.value
      const fdi = indicators['BX.KLT.DINV.WD.GD.ZS']?.value
      const tradeScore = normalise(trade, 0, 200)
      const fdiScore = normalise(fdi, -2, 10)
      if (!tradeScore) return null
      return ((tradeScore) * 0.6) + ((fdiScore || 50) * 0.4)
    }

    case 'technology': {
      const rd = indicators['GB.XPD.RSDV.GD.ZS']?.value
      const internet = indicators['IT.NET.USER.ZS']?.value
      const rdScore = normalise(rd, 0, 5)
      const intScore = normalise(internet, 0, 100)
      if (!rdScore && !intScore) return null
      return ((rdScore || 0) * 0.6) + ((intScore || 50) * 0.4)
    }

    case 'environmental_resilience': {
      const renewables = indicators['EG.ELC.RNEW.ZS']?.value
      const co2 = indicators['EN.ATM.CO2E.PC']?.value
      const renScore = normalise(renewables, 0, 100)
      const co2Score = normalise(co2, 0, 20, true) // inverted — lower is better
      if (!renScore && !co2Score) return null
      return ((renScore || 50) * 0.5) + ((co2Score || 50) * 0.5)
    }
