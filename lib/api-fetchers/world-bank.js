const { Client } = require('pg')

async function getDb() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  })
  await client.connect()
  return client
}

const INDICATORS = [
  'NY.GDP.MKTP.CD', 'NY.GDP.MKTP.KD.ZG', 'EG.ELC.ACCS.ZS',
  'IT.NET.USER.ZS', 'SE.XPD.TOTL.GD.ZS', 'SP.DYN.LE00.IN',
  'RL.EST', 'CC.EST', 'PV.EST', 'NE.TRD.GNFS.ZS',
  'GB.XPD.RSDV.GD.ZS', 'EG.ELC.RNEW.ZS', 'EN.ATM.CO2E.PC'
]

async function fetchIndicator(code) {
  const url = `https://api.worldbank.org/v2/country/all/indicator/${code}?format=json&per_page=300&mrv=1`
  console.log('  Fetching: ' + code)
  const res = await fetch(url)
  if (!res.ok) return {}
  const data = await res.json()
  if (!data[1]) return {}
  const result = {}
  for (const row of data[1]) {
    if (row.value !== null && row.countryiso3code) {
      result[row.countryiso3code] = row.value
    }
  }
  return result
}

function norm(v, min, max, inv) {
  if (v == null) return null
  const n = ((Math.min(Math.max(v, min), max) - min) / (max - min)) * 100
  return inv ? 100 - n : n
}

function score(id, d) {
  if (id === 'economic_output') {
    const g = d['NY.GDP.MKTP.CD']
    const gr = d['NY.GDP.MKTP.KD.ZG']
    const gs = g ? norm(Math.log(g), Math.log(1e8), Math.log(25e12)) : null
    if (!gs) return null
    return gs * 0.7 + (norm(gr, -5, 10) || 50) * 0.3
  }
  if (id === 'infrastructure') {
    const a = norm(d['EG.ELC.ACCS.ZS'], 0, 100)
    const b = norm(d['IT.NET.USER.ZS'], 0, 100)
    if (!a && !b) return null
    return ((a || 0) + (b || 0)) / 2
  }
  if (id === 'human_capital') {
    const life = norm(d['SP.DYN.LE00.IN'], 50, 85)
    if (!life) return null
    return (norm(d['SE.XPD.TOTL.GD.ZS'], 1, 8) || 50) * 0.4 + life * 0.6
  }
  if (id === 'governance') {
    const a = norm(d['RL.EST'], -2.5, 2.5)
    const b = norm(d['CC.EST'], -2.5, 2.5)
    const c = norm(d['PV.EST'], -2.5, 2.5)
    if (!a && !b) return null
    return (a||50)*0.35 + (b||50)*0.35 + (c||50)*0.30
  }
  if (id === 'trade_networks') {
    return norm(d['NE.TRD.GNFS.ZS'], 0, 200)
  }
  if (id === 'technology') {
    const rd = norm(d['GB.XPD.RSDV.GD.ZS'], 0, 5)
    const net = norm(d['IT.NET.USER.ZS'], 0, 100)
    if (!rd && !net) return null
    return (rd||0)*0.6 + (net||50)*0.4
  }
  if (id === 'environmental_resilience') {
    const ren = norm(d['EG.ELC.RNEW.ZS'], 0, 100)
    const co2 = norm(d['EN.ATM.CO2E.PC'], 0, 20, true)
    if (!ren && !co2) return null
    return (ren||50)*0.5 + (co2||50)*0.5
  }
  if (id === 'natural_resources') {
    return norm(d['EG.ELC.ACCS.ZS'], 0, 100)
  }
  return null
}

function composite(scores) {
  const w = {economic_output:0.12,infrastructure:0.09,human_capital:0.08,governance:0.08,trade_networks:0.06,technology:0.09,environmental_resilience:0.04,natural_resources:0.10}
  let sum=0, tot=0
  for (const [k,v] of Object.entries(scores)) {
    if (v!=null && w[k]) { sum+=v*w[k]; tot+=w[k] }
  }
  return tot===0 ? null : sum/tot
}

function pos(s) {
  return s>=75?'dominant':s>=60?'strong':s>=45?'moderate':s>=30?'emerging':'vulnerable'
}

const METRIC_META = {
  economic_output:{name:'Economic Output & Trajectory',tier:1,weight:12},
  infrastructure:{name:'Infrastructure Development Index',tier:1,weight:9},
  human_capital:{name:'Human Capital & Demography',tier:2,weight:8},
  governance:{name:'Governance & Institutional Strength',tier:2,weight:8},
  trade_networks:{name:'Trade Network & Interdependence',tier:2,weight:6},
  technology:{name:'Technological Innovation Capacity',tier:2,weight:9},
  environmental_resilience:{name:'Environmental Resilience',tier:3,weight:4},
  natural_resources:{name:'Natural Resources & Energy Security',tier:1,weight:10}
}

async function main() {
  console.log('PolarisIndex Pipeline Starting...')
  const db = await getDb()
  const { rows: countries } = await db.query('SELECT iso3, name FROM countries WHERE is_active = true')
  console.log('Countries to score: ' + countries.length)

  console.log('Fetching World Bank data...')
  const all = {}
  for (const code of INDICATORS) {
    try {
      all[code] = await fetchIndicator(code)
      await new Promise(r => setTimeout(r, 300))
    } catch(e) {
      console.log('Failed: ' + code)
      all[code] = {}
    }
  }

  console.log('Scoring...')
  const ranked = []
  const metricIds = Object.keys(METRIC_META)

  for (const country of countries) {
    const d = {}
    for (const code of INDICATORS) {
      if (all[code][country.iso3] != null) d[code] = all[code][country.iso3]
    }

    const scores = {}
    for (const id of metricIds) {
      scores[id] = score(id, d)
      if (scores[id] != null) {
        const m = METRIC_META[id]
        await db.query(
          'INSERT INTO metric_scores (country_iso3,metric_id,metric_name,tier,score,weight,confidence,data_vintage) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [country.iso3, id, m.name, m.tier, Math.round(scores[id]*100)/100, m.weight, 0.85, new Date().toISOString().split('T')[0]]
        )
      }
    }

    const ps = composite(scores)
    if (ps != null) ranked.push({iso3: country.iso3, score: ps})
  }

  ranked.sort((a,b) => b.score - a.score)

  for (let i=0; i<ranked.length; i++) {
    const c = ranked[i]
    await db.query(
      'INSERT INTO composite_scores (country_iso3,polaris_score,positioning,global_rank) VALUES ($1,$2,$3,$4)',
      [c.iso3, Math.round(c.score*100)/100, pos(c.score), i+1]
    )
  }

  await db.end()
  console.log('Done! Scored ' + ranked.length + ' countries')
  console.log('Top 5:')
  ranked.slice(0,5).forEach((c,i) => console.log('  ' + (i+1) + '. ' + c.iso3 + ' - ' + c.score.toFixed(1)))
}

main().catch(e => { console.error('FAILED:', e); process.exit(1) })

