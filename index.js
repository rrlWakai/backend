import express from 'express'
import cors from 'cors'
import { rateLimit } from 'express-rate-limit'
import { GoogleGenAI } from '@google/genai'

/* ── Config (env only — no secrets in code) ── */
const PORT = process.env.PORT || 4000
const GITHUB_TOKEN = process.env.GITHUB_TOKEN
const GITHUB_USERNAME = process.env.GITHUB_USERNAME || 'rrlWakai'
const CACHE_TTL_MS = 6 * 60 * 60 * 1000 // 6h — contribution data is not real-time
const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite'

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

/* Render sits behind its own reverse proxy, so req.ip (used by the chat
   rate limiter) is only correct when Express trusts the first hop. */
app.set('trust proxy', 1)

app.use(
  cors({
    // Credentials remain disabled — this API exchanges no cookies/browser auth.
    origin(origin, cb) {
      // No Origin header → curl, Render health checks, same-origin/proxied calls
      if (!origin || ALLOWED_ORIGINS.has(origin)) {
        return cb(null, true)
      }
      console.warn(`CORS blocked origin: ${origin}`)
      return cb(new Error('Not allowed by CORSs'))
    },
  }),
)

app.use(express.json({ limit: '64kb' }))

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

/* ═══════════════════════════════════════
   AI CHAT — Gemini-backed portfolio assistant
   Free-tier quota is scarce, so every request is
   rate-limited, validated, truncated and short.
   ═══════════════════════════════════════ */

const CHAT_SYSTEM_PROMPT = `You are the chat assistant on Rhen-Rhen Lumbo's portfolio site. Rhen-Rhen is a software engineer and website business developer based in San Pablo City, Laguna, Philippines.

Rules:
- Answer only questions about Rhen-Rhen: his skills, projects, education, availability and how to reach him. Politely redirect anything else (other people, politics, general coding help, etc.) back to his portfolio, and suggest lumborhenrhen@gmail.com for anything else.
- Keep replies under 80 words. Friendly and casual; short Taglish (Filipino-English mix) is welcome.
- Never invent clients, prices, dates or timelines. If you don't know or aren't sure, say so plainly and point to lumborhenrhen@gmail.com.
- Always answer with ONLY a JSON object, no markdown and no code fences: {"reply": "...", "action": null}
- "action" is null, unless the reply would be helped by the page scrolling — then use exactly one of: "scroll:experience", "scroll:projects", "scroll:education", "scroll:certifications", "scroll:contact".

Facts you may use:
- Stack: React, TypeScript, JavaScript, Node.js, Express, Supabase, MongoDB, MySQL, PostgreSQL, Tailwind, Framer Motion, Flutter, Dart, Git, Vite, Figma, Postman, Vercel.
- Projects: KRiB — reservation system for a hospitality client that sends SMS to the owner through Semaphore on new bookings. Premier Rentals — reservation system. Yuhrum Villas and Timeless Resort — hospitality websites, shown in the gallery.
- Education: BS Information Technology, major in Web and Mobile Application Development, Laguna State Polytechnic University, 3rd year.
- Open for: business websites, web applications, reservation systems, custom business systems.
- Contact: lumborhenrhen@gmail.com, github.com/rrlWakai.`

/* Shown whenever Gemini itself fails (invalid key, 429, timeout, blocked…).
   Always HTTP 200 so the widget renders a normal reply — raw errors never
   leave this process. */
const CHAT_FALLBACK_REPLY =
  'Ay, parang nagkakaproblema ang assistant ko ngayon. Email mo na lang ako directly sa lumborhenrhen@gmail.com and I will get back to you soon. Salamat!'

const CHAT_RATE_LIMIT_REPLY =
  'Ang dami ng tanong lately — pahinga muna ako saglit, try again in a minute. Or email na lang sa lumborhenrhen@gmail.com anytime.'

const ALLOWED_ACTIONS = new Set([
  'scroll:experience',
  'scroll:projects',
  'scroll:education',
  'scroll:certifications',
  'scroll:contact',
])

const CHAT_MAX_MESSAGES = 6 // last N turns kept, older history dropped
const CHAT_MAX_TEXT = 500 // characters per message
const CHAT_MAX_OUTPUT_TOKENS = 250

const genai = GEMINI_API_KEY ? new GoogleGenAI({ apiKey: GEMINI_API_KEY }) : null

/* Reusable model call — sanitised messages in, raw model text out. */
async function askGemini(messages) {
  if (!genai) {
    throw new Error('GEMINI_API_KEY is not set')
  }

  const response = await genai.models.generateContent({
    model: GEMINI_MODEL,
    contents: messages.map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
    config: {
      systemInstruction: CHAT_SYSTEM_PROMPT,
      maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS,
    },
  })

  const text = response.text
  if (!text || !text.trim()) {
    throw new Error('Gemini returned an empty response')
  }
  return text.trim()
}

/* Keeps only well-formed turns: valid roles, non-empty text, last 6 only,
   each truncated. Leading "model" turns are dropped (Gemini needs the
   conversation to start with a user message). Returns null if nothing
   usable is left. */
function sanitizeMessages(input) {
  if (!Array.isArray(input)) return null

  const cleaned = []
  for (const m of input) {
    if (!m || typeof m !== 'object') continue
    const role = m.role === 'user' || m.role === 'model' ? m.role : null
    const text = typeof m.text === 'string' ? m.text.trim().slice(0, CHAT_MAX_TEXT) : ''
    if (!role || !text) continue
    cleaned.push({ role, text })
  }

  const recent = cleaned.slice(-CHAT_MAX_MESSAGES)
  while (recent.length > 0 && recent[0].role === 'model') recent.shift()
  return recent.length > 0 ? recent : null
}

/* Parses the model's JSON reply defensively: strips code fences, falls back
   to the whole text as the reply, and only accepts whitelisted actions. */
function parseModelReply(raw) {
  let candidate = raw.trim()

  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) candidate = fenced[1].trim()

  if (!candidate.startsWith('{')) {
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start !== -1 && end > start) candidate = candidate.slice(start, end + 1)
  }

  try {
    const parsed = JSON.parse(candidate)
    if (parsed && typeof parsed.reply === 'string' && parsed.reply.trim()) {
      const action =
        typeof parsed.action === 'string' && ALLOWED_ACTIONS.has(parsed.action)
          ? parsed.action
          : null
      return { reply: parsed.reply.trim(), action }
    }
  } catch {
    /* not JSON — fall through and treat the whole text as the reply */
  }

  return { reply: raw, action: null }
}

/* Quota guard: 8 requests per IP per minute, per the Gemini free tier */
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 8,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { reply: CHAT_RATE_LIMIT_REPLY, action: null },
})

app.post('/api/chat', chatLimiter, (req, res) => {
  const messages = sanitizeMessages(req.body?.messages)
  if (!messages) {
    return res.status(400).json({ error: 'messages must be a non-empty array of { role, text }' })
  }

  askGemini(messages)
    .then((raw) => res.json(parseModelReply(raw)))
    .catch((err) => {
      // Includes 429 quota errors — logged here, friendly 200 sent instead
      console.error('[chat] Gemini request failed:', err?.message || err)
      return res.json({ reply: CHAT_FALLBACK_REPLY, action: null })
    })
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
