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

    case 'natural_resources': {
      const energy = indicators['EG.ELC.ACCS.ZS']?.value
      return normalise(energy, 0, 100)
    }

    default:
      return null
  }
}

// ─── CALCULATE COMPOSITE POLARIS SCORE ────────
function calculatePolarisScore(metricScores) {
  const weights = {
    economic_output: 0.12,
    military_capability: 0.10,
    natural_resources: 0.10,
    infrastructure: 0.09,
    technology: 0.09,
    human_capital: 0.08,
    governance: 0.08,
    trade_networks: 0.06,
    geopolitical_influence: 0.04,
    environmental_resilience: 0.04,
    information_power: 0.04,
    soft_power: 0.03,
    // remaining 13% distributed to scored metrics
  }

  let totalWeight = 0
  let weightedSum = 0

  for (const [metricId, score] of Object.entries(metricScores)) {
    if (score !== null && weights[metricId]) {
      weightedSum += score * weights[metricId]
      totalWeight += weights[metricId]
    }
  }

  if (totalWeight === 0) return null
  // Normalise for missing metrics
  return (weightedSum / totalWeight) * 100 / 100
}

// ─── POSITIONING LABEL ────────────────────────
function getPositioning(score) {
  if (score >= 75) return 'dominant'
  if (score >= 60) return 'strong'
  if (score >= 45) return 'moderate'
  if (score >= 30) return 'emerging'
  return 'vulnerable'
}

// ─── MAIN FETCH & SCORE PIPELINE ──────────────
async function runPipeline() {
  console.log('🌍 PolarisIndex Data Pipeline Starting...')
  console.log(`⏰ ${new Date().toISOString()}`)

  // 1. Get all countries from DB
  const { data: countries, error: countryError } = await supabase
    .from('countries')
    .select('iso3, iso2, name')
    .eq('is_active', true)

  if (countryError) throw countryError
  console.log(`📊 Scoring ${countries.length} countries`)

  // 2. Fetch all indicators from World Bank
  console.log('\n📡 Fetching World Bank indicators...')
  const allIndicatorData = {}

  const uniqueIndicators = [...new Set(WB_INDICATORS.map(i => i.code))]

  for (const code of uniqueIndicators) {
    try {
      allIndicatorData[code] = await fetchIndicator(code)
      await new Promise(r => setTimeout(r, 300)) // rate limit courtesy delay
    } catch (err) {
      console.error(`  ❌ Failed: ${code} — ${err.message}`)
      allIndicatorData[code] = {}
    }
  }

  // 3. Score each country
  console.log('\n🧮 Calculating scores...')
  const metricScoreRows = []
  const compositeRows = []
  const countryScores = []

  for (const country of countries) {
    const iso3 = country.iso3
    const countryIndicators = {}

    // Collect this country's indicator values
    for (const [code, data] of Object.entries(allIndicatorData)) {
      if (data[iso3]) {
        countryIndicators[code] = data[iso3]
      }
    }

    // Score each metric
    const metricScores = {}
    const metricIds = ['economic_output','infrastructure','human_capital','governance',
                       'trade_networks','technology','environmental_resilience','natural_resources']

    for (const metricId of metricIds) {
      const score = scoreMetric(metricId, countryIndicators)
      metricScores[metricId] = score

      if (score !== null) {
        const metricDef = {
          economic_output: { name: 'Economic Output & Trajectory', tier: 1, weight: 12 },
          infrastructure: { name: 'Infrastructure Development Index', tier: 1, weight: 9 },
          human_capital: { name: 'Human Capital & Demography', tier: 2, weight: 8 },
          governance: { name: 'Governance & Institutional Strength', tier: 2, weight: 8 },
          trade_networks: { name: 'Trade Network & Economic Interdependence', tier: 2, weight: 6 },
          technology: { name: 'Technological Innovation Capacity', tier: 2, weight: 9 },
          environmental_resilience: { name: 'Environmental Resilience & Climate Risk', tier: 3, weight: 4 },
          natural_resources: { name: 'Natural Resources & Energy Security', tier: 1, weight: 10 },
        }[metricId]

        metricScoreRows.push({
          country_iso3: iso3,
          metric_id: metricId,
          metric_name: metricDef.name,
          tier: metricDef.tier,
          score: Math.round(score * 100) / 100,
          weight: metricDef.weight,
          raw_value: countryIndicators,
          source_ids: ['world_bank'],
          confidence: 0.85,
          data_vintage: new Date().toISOString().split('T')[0]
        })
      }
    }

    // Calculate composite
    const polaris = calculatePolarisScore(metricScores)
    if (polaris !== null) {
      countryScores.push({ iso3, score: polaris, metricScores })
      compositeRows.push({
        country_iso3: iso3,
        polaris_score: Math.round(polaris * 100) / 100,
        positioning: getPositioning(polaris),
        tier1_score: Math.round(((metricScores.economic_output || 0) +
                                  (metricScores.infrastructure || 0) +
                                  (metricScores.natural_resources || 0)) / 3 * 100) / 100,
        tier2_score: Math.round(((metricScores.human_capital || 0) +
                                  (metricScores.governance || 0) +
                                  (metricScores.technology || 0) +
                                  (metricScores.trade_networks || 0)) / 4 * 100) / 100,
        tier3_score: Math.round(((metricScores.environmental_resilience || 0)) * 100) / 100,
      })
    }
  }

  // 4. Assign global ranks
  countryScores.sort((a, b) => b.score - a.score)
  countryScores.forEach((c, i) => {
    const row = compositeRows.find(r => r.country_iso3 === c.iso3)
    if (row) row.global_rank = i + 1
  })

  // 5. Write to Supabase
  console.log('\n💾 Writing to database...')

  if (metricScoreRows.length > 0) {
    const { error: metricError } = await supabase
      .from('metric_scores')
      .insert(metricScoreRows)
    if (metricError) console.error('Metric score insert error:', metricError)
    else console.log(`  ✅ ${metricScoreRows.length} metric scores written`)
  }

  if (compositeRows.length > 0) {
    const { error: compositeError } = await supabase
      .from('composite_scores')
      .insert(compositeRows)
    if (compositeError) console.error('Composite score insert error:', compositeError)
    else console.log(`  ✅ ${compositeRows.length} composite scores written`)
  }

  // 6. Update data source last_fetched
  await supabase
    .from('data_sources')
    .update({ last_fetched_at: new Date().toISOString(), last_success_at: new Date().toISOString() })
    .like('source_key', 'wb_%')

  console.log('\n✅ Pipeline complete!')
  console.log(`📈 Scored ${compositeRows.length} countries`)
  console.log(`🏆 Top 3: ${countryScores.slice(0,3).map(c => `${c.iso3} (${c.score.toFixed(1)})`).join(', ')}`)
}

// ─── RUN ──────────────────────────────────────
runPipeline().catch(err => {
  console.error('❌ Pipeline failed:', err)
  process.exit(1)
})

