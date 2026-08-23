import express from 'express'
import cors from 'cors'

/* ── Config (env only — no secrets in code) ── */
const PORT = process.env.PORT || 4000
const GITHUB_TOKEN = process.env.GITHUB_TOKEN
const GITHUB_USERNAME = process.env.GITHUB_USERNAME || 'rrlWakai'
const CACHE_TTL_MS = 6 * 60 * 60 * 1000 // 6h — contribution data is not real-time

/* ── CORS ──
   Localhost dev origins are always allowed; the deployed frontend origin is
   provided via the FRONTEND_URL environment variable (set in Render's dashboard).
   Trailing slashes are normalized so pasting "https://site.vercel.app/" still works. */
const LOCAL_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
  'https://lumbo-rhen-rhen-26.vercel.app/'
]

const FRONTEND_URL = process.env.FRONTEND_URL?.trim().replace(/\/+$/, '')

const ALLOWED_ORIGINS = new Set([...LOCAL_ORIGINS, ...(FRONTEND_URL ? [FRONTEND_URL] : [])])

const app = express()

app.use(
  cors({
    // Credentials remain disabled — this API exchanges no cookies/browser auth.
    origin(origin, cb) {
      // No Origin header → curl, Render health checks, same-origin/proxied calls
      if (!origin || ALLOWED_ORIGINS.has(origin)) {
        return cb(null, true)
      }
      console.warn(`CORS blocked origin: ${origin}`)
      return cb(new Error('Not allowed by CORS'))
    },
  }),
)

/* ── GitHub GraphQL ── */
const CONTRIBUTIONS_QUERY = `
query($login: String!) {
  user(login: $login) {
    login
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks {
          contributionDays {
            date
            contributionCount
          }
        }
      }
    }
  }
}`

async function fetchContributionCalendar() {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: CONTRIBUTIONS_QUERY, variables: { login: GITHUB_USERNAME } }),
  })

  if (!res.ok) {
    throw new Error(`GitHub API responded with status ${res.status}`)
  }

  const payload = await res.json()
  if (payload.errors?.length) {
    throw new Error(payload.errors[0]?.message || 'GitHub GraphQL error')
  }

  const calendar = payload.data?.user?.contributionsCollection?.contributionCalendar
  if (!calendar || !Array.isArray(calendar.weeks)) {
    throw new Error('Unexpected response shape from GitHub API')
  }

  return calendar
}

/* ── Transform: level bucketing + streaks, so the frontend stays logic-free ── */
function levelFromCount(count) {
  if (count <= 0) return 0
  if (count <= 2) return 1
  if (count <= 5) return 2
  if (count <= 9) return 3
  return 4
}

function transformCalendar(calendar) {
  const days = []
  for (const week of calendar.weeks) {
    for (const day of week.contributionDays ?? []) {
      const count = day.contributionCount ?? 0
      days.push({
        date: String(day.date).slice(0, 10),
        count,
        level: levelFromCount(count),
      })
    }
  }

  let longestStreak = 0
  let runningStreak = 0
  for (const day of days) {
    if (day.count > 0) {
      runningStreak += 1
      if (runningStreak > longestStreak) longestStreak = runningStreak
    } else {
      runningStreak = 0
    }
  }

  let currentStreak = 0
  for (let i = days.length - 1; i >= 0; i--) {
    if (days[i].count > 0) currentStreak += 1
    else break
  }

  return {
    totalContributions:
      typeof calendar.totalContributions === 'number'
        ? calendar.totalContributions
        : days.reduce((sum, d) => sum + d.count, 0),
    currentStreak,
    longestStreak,
    days,
  }
}

/* ── In-memory cache (6h TTL, single inflight request, stale-on-error) ── */
const cache = { data: null, fetchedAt: 0, inflight: null }

async function getActivity() {
  if (cache.data && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data
  }

  if (!cache.inflight) {
    cache.inflight = fetchContributionCalendar()
      .then((calendar) => {
        cache.data = transformCalendar(calendar)
        cache.fetchedAt = Date.now()
        return cache.data
      })
      .finally(() => {
        cache.inflight = null
      })
  }

  return cache.inflight
}

/* ── Routes ── */
app.get('/', (_req, res) => {
  res.status(200).json({ status: 'ok' })
})

app.get('/api/github-contributions', async (_req, res) => {
  try {
    if (!GITHUB_TOKEN) {
      return res.status(500).json({ error: 'Server misconfigured: GITHUB_TOKEN is not set' })
    }
    const data = await getActivity()
    return res.json(data)
  } catch (err) {
    console.error('[github-contributions]', err.message)
    // Serve stale cache rather than fail, e.g. on rate-limit hiccups
    if (cache.data) {
      return res.json(cache.data)
    }
    return res.status(500).json({ error: 'Failed to load GitHub activity' })
  }
})

/* ── Error handler — keeps every failure a JSON response ── */
app.use((err, _req, res, _next) => {
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed' })
  }
  console.error('[server]', err.message)
  return res.status(500).json({ error: 'Internal server error' })
})

app.listen(PORT, () => {
  console.log(`GitHub activity API listening on port ${PORT} (user: ${GITHUB_USERNAME})`)
  console.log(`CORS allowed origins: ${[...ALLOWED_ORIGINS].join(', ')}`)
  if (!FRONTEND_URL) {
    console.warn('FRONTEND_URL is not set — only localhost development origins are allowed')
  }
})
