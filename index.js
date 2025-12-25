import dotenv from 'dotenv'
dotenv.config()
import express from 'express'
import cors from 'cors'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import PDFDocument from 'pdfkit'
import nodemailer from 'nodemailer'
import { LICENSE_TERMS, DEFAULT_TERMS } from './licenseTerms.js'
import { buildBeatLicenseContract, buildProducerAgreement } from './contracts.js'
import { createClient } from '@supabase/supabase-js'
import authRoutes from './authRoutes.js'
import settingsRoutes from './settingsRoutes.js'
import beatsRoutes from './beatsRoutes.js'
import collabRoutes from './collabRoutes.js'
import salesRoutes from './salesRoutes.js'

const app = express()
app.use(cors())
app.use(express.json())
app.use(authRoutes)
app.use(settingsRoutes)
app.use('/beats', beatsRoutes)
app.use(collabRoutes)
app.use(salesRoutes)

// Supabase service-role client for server-side credit management
const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

let supabase = null
if (supabaseUrl && supabaseServiceKey) {
  supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  })
} else {
  console.warn('[server] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY; credit routes disabled')
}

const REGION = process.env.AWS_REGION
const BUCKET = process.env.S3_BUCKET

if (!REGION || !BUCKET) {
  console.warn('[s3-server] Missing AWS_REGION or S3_BUCKET env vars')
}

const s3 = new S3Client({
  region: REGION,
  credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  } : undefined
})

// Email transporter (optional; skips if missing creds)
let transporter = null
if (process.env.SMTP_HOST && process.env.SMTP_USER) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  })
}

// ---- Recording Lab credits ----

const RECORDING_SESSION_COST = 200
const SIGNUP_BONUS_CREDITS = 1000
const CREDIT_PACKS = [
  { id: 'pack_500', credits: 500, priceUsd: 5 },
  { id: 'pack_1200', credits: 1200, priceUsd: 10 },
  { id: 'pack_3000', credits: 3000, priceUsd: 20 },
]

const RECORDING_PLANS = {
  studio_lite: {
    id: 'studio_lite',
    name: 'Studio Lite',
    monthlyPriceUsd: 9.99,
    monthlyCredits: 2000,
    priority: false,
  },
  studio_pro: {
    id: 'studio_pro',
    name: 'Studio Pro',
    monthlyPriceUsd: 19.99,
    monthlyCredits: 6000,
    priority: true,
  },
}

const ensureCreditsRow = async (userId) => {
  if (!supabase) return null
  if (!userId) return null
  const { data, error } = await supabase
    .from('recording_credits')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()
  if (error) throw error
  if (data) return data
  const { data: inserted, error: insertError } = await supabase
    .from('recording_credits')
    .insert({ user_id: userId, balance: SIGNUP_BONUS_CREDITS })
    .select('*')
    .single()
  if (insertError) throw insertError
  if (inserted) {
    await supabase.from('recording_credit_history').insert({
      user_id: userId,
      delta: SIGNUP_BONUS_CREDITS,
      balance_after: inserted.balance,
      reason: 'Signup bonus',
      source: 'signup',
    })
  }
  return inserted
}

const parseUserId = (req) => {
  const authHeader = req.headers['x-user-id'] || req.headers['x-userid']
  if (authHeader && typeof authHeader === 'string') return authHeader
  return null
}

// GET /credits/balance -> { balance, costPerSession, packs, plans }
app.get('/credits/balance', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'Supabase not configured' })
    const userId = parseUserId(req)
    if (!userId) return res.status(401).json({ error: 'Missing user id' })

    const row = await ensureCreditsRow(userId)
    const balance = row?.balance ?? 0

    res.json({
      balance,
      costPerSession: RECORDING_SESSION_COST,
      packs: CREDIT_PACKS,
      plans: Object.values(RECORDING_PLANS),
      currentPlanId: row?.current_plan_id || null,
      priorityProcessing: !!row?.priority_processing,
    })
  } catch (err) {
    console.error('[credits/balance] error', err)
    res.status(500).json({ error: 'Failed to load balance' })
  }
})

// POST /credits/use { amount? } -> deduct credits when starting a session
app.post('/credits/use', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'Supabase not configured' })
    const userId = parseUserId(req)
    if (!userId) return res.status(401).json({ error: 'Missing user id' })

    const amount = Number.isFinite(req.body?.amount)
      ? Math.floor(req.body.amount)
      : RECORDING_SESSION_COST
    if (amount <= 0) return res.status(400).json({ error: 'Invalid amount' })

    const row = await ensureCreditsRow(userId)
    const current = row?.balance ?? 0
    if (current < amount) {
      return res.status(402).json({ error: 'Insufficient credits', balance: current })
    }

    const newBalance = current - amount
    const { data, error } = await supabase
      .from('recording_credits')
      .update({ balance: newBalance })
      .eq('user_id', userId)
      .select('balance')
      .single()
    if (error) throw error

    await supabase.from('recording_credit_history').insert({
      user_id: userId,
      delta: -amount,
      balance_after: data.balance,
      reason: 'Recording Lab session',
      source: 'session',
    })

    res.json({ balance: data.balance })
  } catch (err) {
    console.error('[credits/use] error', err)
    res.status(500).json({ error: 'Failed to use credits' })
  }
})

// POST /credits/add { packId?, credits?, reason?, source?, meta? }
// Intended to be called after successful payment / purchase webhook.
app.post('/credits/add', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'Supabase not configured' })
    const userId = req.body?.userId || parseUserId(req)
    if (!userId) return res.status(401).json({ error: 'Missing user id' })

    let creditsToAdd = 0
    let source = req.body?.source || 'purchase'
    let reason = req.body?.reason || 'Credit purchase'

    if (req.body?.packId) {
      const pack = CREDIT_PACKS.find((p) => p.id === req.body.packId)
      if (!pack) return res.status(400).json({ error: 'Invalid packId' })
      creditsToAdd = pack.credits
      reason = `Credit pack ${pack.id}`
      source = 'purchase'
    } else if (Number.isFinite(req.body?.credits)) {
      creditsToAdd = Math.floor(req.body.credits)
    }

    if (!Number.isFinite(creditsToAdd) || creditsToAdd <= 0) {
      return res.status(400).json({ error: 'Invalid credits amount' })
    }

    const row = await ensureCreditsRow(userId)
    const current = row?.balance ?? 0
    const newBalance = current + creditsToAdd

    const { data, error } = await supabase
      .from('recording_credits')
      .update({ balance: newBalance })
      .eq('user_id', userId)
      .select('balance')
      .single()
    if (error) throw error

    await supabase.from('recording_credit_history').insert({
      user_id: userId,
      delta: creditsToAdd,
      balance_after: data.balance,
      reason,
      source,
      meta: req.body?.meta || null,
    })

    res.json({ balance: data.balance })
  } catch (err) {
    console.error('[credits/add] error', err)
    res.status(500).json({ error: 'Failed to add credits' })
  }
})

// POST /subscriptions/sync { userId, planId }
// Called by billing webhook or cron on renewal; resets monthly credits.
app.post('/subscriptions/sync', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'Supabase not configured' })
    const userId = req.body?.userId
    const planId = req.body?.planId
    if (!userId || !planId) return res.status(400).json({ error: 'userId and planId required' })

    const plan = RECORDING_PLANS[planId]
    if (!plan) return res.status(400).json({ error: 'Unknown planId' })

    const row = await ensureCreditsRow(userId)
    const newBalance = plan.monthlyCredits

    const { data, error } = await supabase
      .from('recording_credits')
      .update({
        balance: newBalance,
        current_plan_id: plan.id,
        priority_processing: !!plan.priority,
      })
      .eq('user_id', userId)
      .select('balance,current_plan_id,priority_processing')
      .single()
    if (error) throw error

    await supabase.from('recording_credit_history').insert({
      user_id: userId,
      delta: newBalance,
      balance_after: data.balance,
      reason: `Subscription renewal (${plan.name})`,
      source: 'subscription',
    })

    res.json({
      balance: data.balance,
      currentPlanId: data.current_plan_id,
      priorityProcessing: data.priority_processing,
    })
  } catch (err) {
    console.error('[subscriptions/sync] error', err)
    res.status(500).json({ error: 'Failed to sync subscription' })
  }
})

// Request a presigned URL for uploading a file
// Body: { filename: string, contentType: string, folder?: string }
app.post('/api/upload-url', async (req, res) => {
  try {
    const { filename, contentType, folder } = req.body || {}
    if (!filename || !contentType) {
      return res.status(400).json({ error: 'filename and contentType required' })
    }
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_')
    const key = `${folder ? folder + '/' : ''}${Date.now()}-${safeName}`
    const command = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType })
    const url = await getSignedUrl(s3, command, { expiresIn: 60 })
    const publicUrl = `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`
    res.json({ uploadUrl: url, key, publicUrl })
  } catch (err) {
    console.error('[s3-server] upload-url error', err)
    res.status(500).json({ error: 'Failed to create presigned URL' })
  }
})

// Lightweight proxy for YouTube feeds / channel pages so the frontend
// can load recent uploads without running into CORS restrictions.
// Query: ?url=<full YouTube channel/handle/playlist URL or handle starting with @>
app.get('/api/youtube-feed', async (req, res) => {
  const raw = req.query.url
  if (!raw) {
    return res.status(400).json({ error: 'url query param is required' })
  }

  // Normalise handle-only input like "@name"
  let target = raw.trim()
  if (target.startsWith('@')) {
    target = `https://www.youtube.com/${target}`
  } else if (!/^https?:\/\//i.test(target)) {
    target = `https://www.youtube.com/${target}`
  }

  try {
    // Playlist: scrape a few video ids from HTML
    if (target.includes('playlist?list=')) {
      const resp = await fetch(target)
      if (!resp.ok) {
        return res.status(502).json({ error: 'Failed to load playlist page' })
      }
      const html = await resp.text()
      const ids = [...html.matchAll(/watch\?v=([a-zA-Z0-9_-]{11})/g)].map(
        (m) => m[1],
      )
      const unique = Array.from(new Set(ids)).slice(0, 6)
      const videos = unique.map((id, idx) => ({
        videoId: id,
        title: `Playlist Video ${idx + 1}`,
        published: null,
      }))
      return res.json({ videos })
    }

    // Resolve channel id for channel/@handle/user URLs
    let channelId = null
    const direct = target.match(/youtube\.com\/channel\/([a-zA-Z0-9_-]+)/)
    if (direct) {
      channelId = direct[1]
    } else {
      const resp = await fetch(target)
      if (!resp.ok) {
        return res.status(502).json({ error: 'Failed to load channel page' })
      }
      const html = await resp.text()
      const match =
        html.match(/channelId":"(UC[^"]+)/) ||
        html.match(/"externalId":"(UC[^"]+)/)
      if (match) channelId = match[1]
    }

    if (!channelId) {
      return res.status(400).json({ error: 'Unable to resolve channel ID' })
    }

    const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`
    const feedResp = await fetch(feedUrl)
    if (!feedResp.ok) {
      return res.status(502).json({ error: 'Failed to fetch channel feed' })
    }
    const xml = await feedResp.text()

    // Simple XML parsing via regex for <entry> blocks
    const entries = [...xml.matchAll(/<entry>[\s\S]*?<\/entry>/g)]
    const videos = entries.slice(0, 6).map((m) => {
      const block = m[0]
      const idMatch = block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)
      const titleMatch = block.match(/<title>([^<]+)<\/title>/)
      return {
        videoId: idMatch ? idMatch[1] : null,
        title: titleMatch ? titleMatch[1] : 'Untitled',
        published: null,
      }
    })
      .filter((v) => v.videoId)
      .slice(0, 3)

    return res.json({ videos })
  } catch (err) {
    console.error('[youtube-feed] error', err)
    return res.status(500).json({ error: 'Failed to resolve YouTube feed' })
  }
})

// Generate license PDF, upload to S3, email link
// Body: {
//   beatTitle,
//   license,
//   buyerEmail,
//   amount,
//   buyerName?,
//   producerName?,
//   orderId?
// }
app.post('/api/generate-license', async (req, res) => {
  try {
    const {
      beatTitle,
      license,
      buyerEmail,
      amount,
      buyerName,
      producerName,
      orderId,
    } = req.body || {}
    if (!beatTitle || !license || !buyerEmail || !amount) {
      return res.status(400).json({ error: 'Missing fields' })
    }
    const licenseId = 'lic_' + Date.now()
    // Create PDF in memory
    const doc = new PDFDocument({ margin: 50 })
    const chunks = []
    doc.on('data', c => chunks.push(c))
    doc.on('end', async () => {
      const pdfBuffer = Buffer.concat(chunks)
      const key = `licenses/${licenseId}.pdf`
      // Upload PDF to S3
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: pdfBuffer, ContentType: 'application/pdf' }))
      const publicUrl = `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`
      // Email (if transporter configured)
      if (transporter) {
        try {
          await transporter.sendMail({
            from: process.env.EMAIL_FROM || 'no-reply@example.com',
            to: buyerEmail,
            subject: `Your ${license} License for ${beatTitle}`,
            text: `Thank you for licensing ${beatTitle}. Download your license PDF: ${publicUrl}`,
            html: `<p>Thank you for licensing <strong>${beatTitle}</strong>.</p><p>License Type: <strong>${license}</strong><br/>Amount Paid: $${amount}</p><p><a href="${publicUrl}">Download License PDF</a></p>`
          })
        } catch (e) {
          console.warn('[license-email] send failed', e.message)
        }
      }
      res.json({ licenseId, publicUrl })
    })
    // PDF content
    doc.fontSize(18).text('RiddimBase License Certificate', { align: 'center' })
    doc.moveDown()
    doc.fontSize(12).text(`License ID: ${licenseId}`)
    doc.text(`Date: ${new Date().toISOString().slice(0,10)}`)
    doc.text(`Buyer Email: ${buyerEmail}`)
    doc.moveDown(0.5)
    doc.text(`Beat Title: ${beatTitle}`)
    doc.text(`License Type: ${license}`)
    doc.text(`Amount Paid: $${amount} USD`)
    doc.moveDown()
    const terms = (LICENSE_TERMS[license] && LICENSE_TERMS[license].length) ? LICENSE_TERMS[license] : DEFAULT_TERMS
    doc.fontSize(11).text('Terms:', { underline: true })
    doc.fontSize(10).list(terms)
    doc.moveDown()
    // Append full Beat Licensing Agreement text on a new page
    const contractText = buildBeatLicenseContract({
      date: new Date().toISOString().slice(0, 10),
      buyerName: buyerName || buyerEmail,
      producerName: producerName || 'Producer',
      beatTitle,
      licenseType: license,
      orderId: orderId || licenseId,
    })
    doc.addPage()
    doc.fontSize(14).text('Beat Licensing Agreement', { align: 'center' })
    doc.moveDown()
    doc.fontSize(10).text(contractText, { align: 'left' })
    doc.moveDown()
    doc.text('Thank you for supporting Caribbean producers!', { align: 'center' })
    doc.end()
  } catch (err) {
    console.error('[generate-license] error', err)
    res.status(500).json({ error: 'Failed to generate license' })
  }
})

// On-demand Producer Agreement PDF
// Query/body: { producerName, email }
app.post('/api/producer-agreement', async (req, res) => {
  try {
    const { producerName, email } = req.body || {}
    if (!producerName || !email) {
      return res.status(400).json({ error: 'producerName and email are required' })
    }
    const agreementId = 'producer_agreement_' + Date.now()
    const doc = new PDFDocument({ margin: 50 })
    const chunks = []
    doc.on('data', c => chunks.push(c))
    doc.on('end', async () => {
      const pdfBuffer = Buffer.concat(chunks)
      const key = `agreements/${agreementId}.pdf`
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: pdfBuffer,
        ContentType: 'application/pdf'
      }))
      const publicUrl = `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`
      if (transporter) {
        try {
          await transporter.sendMail({
            from: process.env.EMAIL_FROM || 'no-reply@riddimbasesound.com',
            to: email,
            subject: 'Your RiddimBase Producer Agreement',
            text: `Welcome to RiddimBase. Your Producer Agreement is attached and available here: ${publicUrl}`,
            html: `<p>Welcome to <strong>RiddimBase</strong>.</p><p>Your Producer Agreement is ready. You can download it here:</p><p><a href="${publicUrl}">Download Producer Agreement</a></p>`
          })
        } catch (e) {
          console.warn('[producer-agreement] email send failed', e.message)
        }
      }
      res.json({ agreementId, publicUrl })
    })
    const text = buildProducerAgreement({
      date: new Date().toISOString().slice(0, 10),
      producerName,
    })
    doc.fontSize(16).text('RiddimBase Producer Agreement', { align: 'center' })
    doc.moveDown()
    doc.fontSize(10).text(text, { align: 'left' })
    doc.end()
  } catch (err) {
    console.error('[producer-agreement] error', err)
    res.status(500).json({ error: 'Failed to generate producer agreement' })
  }
})

// Supabase client for boosted_beats and future admin APIs
// Reuse the supabase client declared near the top of this file.
const paypalWebhookId = process.env.PAYPAL_WEBHOOK_ID || null

const supabaseAvailable = () => !!supabase

// Helper: increment a daily metric row in a table (beat_metrics_daily or producer_metrics_daily).
async function incrementDailyMetric(table, match) {
  const todayIso = new Date().toISOString()
  // Try to find existing row for this key
  const { data, error } = await supabase
    .from(table)
    .select('id,value')
    .match(match)
    .maybeSingle()

  if (error && error.code !== 'PGRST116') {
    throw error
  }

  if (data && data.id) {
    const newVal = (data.value || 0) + 1
    const { error: updErr } = await supabase
      .from(table)
      .update({ value: newVal, updated_at: todayIso })
      .eq('id', data.id)
    if (updErr) throw updErr
  } else {
    const payload = { ...match, value: 1, created_at: todayIso, updated_at: todayIso }
    const { error: insErr } = await supabase.from(table).insert(payload)
    if (insErr) throw insErr
  }
}

// Track a beat play in beat_metrics_daily and producer_metrics_daily.
// Body: { beatId: uuid, producerId?: uuid }
app.post('/api/metrics/beat-play', async (req, res) => {
  const { beatId, producerId } = req.body || {}
  if (!beatId) {
    return res.status(400).json({ error: 'beatId is required' })
  }
  if (!supabaseAvailable()) {
    console.warn('[metrics] Supabase not configured, skipping beat-play persist')
    return res.status(200).json({ ok: false, stored: false })
  }
  const day = new Date().toISOString().slice(0, 10)
  try {
    await incrementDailyMetric('beat_metrics_daily', {
      beat_id: beatId,
      metric: 'plays',
      day,
    })
    if (producerId) {
      await incrementDailyMetric('producer_metrics_daily', {
        producer_id: producerId,
        metric: 'plays',
        day,
      })
    }
    res.status(200).json({ ok: true, stored: true })
  } catch (err) {
    console.error('[metrics] beat-play error', err)
    // We still return 200 so the frontend never breaks playback.
    res.status(200).json({ ok: false, stored: false })
  }
})

// Track arbitrary producer-level metrics (likes, followers, etc.).
// Body: { producerId: uuid, metric: 'likes' | 'followers', delta: 1 | -1 }
app.post('/api/metrics/producer', async (req, res) => {
  const { producerId, metric, delta } = req.body || {}
  if (!producerId || !metric || !delta) {
    return res.status(400).json({ error: 'producerId, metric and delta are required' })
  }
  if (!supabaseAvailable()) {
    console.warn('[metrics] Supabase not configured, skipping producer metric')
    return res.status(200).json({ ok: false, stored: false })
  }
  const day = new Date().toISOString().slice(0, 10)
  try {
    // Read existing value (if any)
    const { data, error } = await supabase
      .from('producer_metrics_daily')
      .select('id,value')
      .match({ producer_id: producerId, metric, day })
      .maybeSingle()

    if (error && error.code !== 'PGRST116') {
      throw error
    }

    const todayIso = new Date().toISOString()
    if (data && data.id) {
      const next = (data.value || 0) + Number(delta)
      const clamped = next < 0 ? 0 : next
      const { error: updErr } = await supabase
        .from('producer_metrics_daily')
        .update({ value: clamped, updated_at: todayIso })
        .eq('id', data.id)
      if (updErr) throw updErr
    } else {
      const value = delta > 0 ? Number(delta) : 0
      const { error: insErr } = await supabase
        .from('producer_metrics_daily')
        .insert({
          producer_id: producerId,
          metric,
          day,
          value,
          created_at: todayIso,
          updated_at: todayIso,
        })
      if (insErr) throw insErr
    }

    res.status(200).json({ ok: true, stored: true })
  } catch (err) {
    console.error('[metrics] producer metric error', err)
    res.status(200).json({ ok: false, stored: false })
  }
})

// -------- Admin users API (live data for Admin panel) --------
// Returns a flattened list of Supabase auth users for the AdminUsers screen.
// Shape: [{ id, email, banned, producer, createdAt, lastSignInAt }]
app.get('/admin/users', async (req, res) => {
  if (!supabaseAvailable()) {
    return res.status(500).json({ error: 'Supabase not configured on server' })
  }

  try {
    const { data, error } = await supabase.auth.admin.listUsers({
      page: 1,
      perPage: 1000
    })

    if (error) {
      console.error('[admin/users] listUsers error', error)
      return res.status(500).json({ error: 'Failed to load users' })
    }

    const src = Array.isArray(data?.users) ? data.users : (Array.isArray(data) ? data : [])

    const users = src.map((u) => ({
      id: u.id,
      email: u.email,
      banned: !!u.user_metadata?.banned,
      producer: !!u.user_metadata?.producer,
      createdAt: u.created_at || null,
      lastSignInAt: u.last_sign_in_at || null
    }))

    res.json(users)
  } catch (err) {
    console.error('[admin/users] unexpected error', err)
    res.status(500).json({ error: 'Failed to load users' })
  }
})

// Helper: fetch a user and merge user_metadata changes safely
async function updateUserMetadata(userId, patch) {
  const { data, error } = await supabase.auth.admin.getUserById(userId)
  if (error || !data?.user) {
    throw error || new Error('User not found')
  }
  const meta = data.user.user_metadata || {}
  const { data: updated, error: updateError } =
    await supabase.auth.admin.updateUserById(userId, {
      user_metadata: { ...meta, ...patch },
    })
  if (updateError) throw updateError
  return updated?.user || data.user
}

// Mark a user as banned in user_metadata
app.post('/admin/users/:id/ban', async (req, res) => {
  if (!supabaseAvailable()) {
    return res
      .status(500)
      .json({ error: 'Supabase not configured on server' })
  }
  const { id } = req.params
  try {
    const user = await updateUserMetadata(id, { banned: true })
    res.json({ ok: true, id: user.id, banned: true })
  } catch (err) {
    console.error('[admin/users ban] error', err)
    res.status(500).json({ error: 'Failed to ban user' })
  }
})

// Flag a user as a producer in user_metadata
app.post('/admin/users/:id/producer', async (req, res) => {
  if (!supabaseAvailable()) {
    return res
      .status(500)
      .json({ error: 'Supabase not configured on server' })
  }
  const { id } = req.params
  try {
    const user = await updateUserMetadata(id, { producer: true })
    res.json({ ok: true, id: user.id, producer: true })
  } catch (err) {
    console.error('[admin/users producer] error', err)
    res.status(500).json({ error: 'Failed to approve producer' })
  }
})

// Trigger a Supabase password recovery email for the user
app.post('/admin/users/:id/reset-password', async (req, res) => {
  if (!supabaseAvailable()) {
    return res
      .status(500)
      .json({ error: 'Supabase not configured on server' })
  }
  const { id } = req.params
  try {
    const { data, error } = await supabase.auth.admin.getUserById(id)
    if (error || !data?.user?.email) {
      console.error('[admin/users reset] getUser error', error)
      return res.status(404).json({ error: 'User not found' })
    }
    const email = data.user.email
    const { error: linkError } = await supabase.auth.admin.generateLink({
      type: 'recovery',
      email,
    })
    if (linkError) {
      console.error('[admin/users reset] generateLink error', linkError)
      return res.status(500).json({ error: 'Failed to trigger reset email' })
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('[admin/users reset] unexpected error', err)
    res.status(500).json({ error: 'Failed to reset password' })
  }
})

// -------- Admin beats moderation API (Supabase beats table) --------
app.post('/admin/beats/:id/hide', async (req, res) => {
  if (!supabaseAvailable()) {
    return res
      .status(500)
      .json({ error: 'Supabase not configured on server' })
  }
  const { id } = req.params
  try {
    const { data, error } = await supabase
      .from('beats')
      .update({ hidden: true })
      .eq('id', id)
      .select()
      .maybeSingle()
    if (error) {
      console.error('[admin/beats hide] error', error)
      return res.status(500).json({ error: 'Failed to hide beat' })
    }
    res.json({ ok: true, beat: data })
  } catch (err) {
    console.error('[admin/beats hide] unexpected', err)
    res.status(500).json({ error: 'Failed to hide beat' })
  }
})

app.post('/admin/beats/:id/flag', async (req, res) => {
  if (!supabaseAvailable()) {
    return res
      .status(500)
      .json({ error: 'Supabase not configured on server' })
  }
  const { id } = req.params
  try {
    const { data, error } = await supabase
      .from('beats')
      .update({ flagged: true })
      .eq('id', id)
      .select()
      .maybeSingle()
    if (error) {
      console.error('[admin/beats flag] error', error)
      return res.status(500).json({ error: 'Failed to flag beat' })
    }
    res.json({ ok: true, beat: data })
  } catch (err) {
    console.error('[admin/beats flag] unexpected', err)
    res.status(500).json({ error: 'Failed to flag beat' })
  }
})

app.delete('/admin/beats/:id', async (req, res) => {
  if (!supabaseAvailable()) {
    return res
      .status(500)
      .json({ error: 'Supabase not configured on server' })
  }
  const { id } = req.params
  try {
    const { error } = await supabase.from('beats').delete().eq('id', id)
    if (error) {
      console.error('[admin/beats delete] error', error)
      return res.status(500).json({ error: 'Failed to delete beat' })
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('[admin/beats delete] unexpected', err)
    res.status(500).json({ error: 'Failed to delete beat' })
  }
})

// -------- Admin dashboard metrics (global counts) --------
app.get('/admin/metrics', async (req, res) => {
  if (!supabaseAvailable()) {
    return res
      .status(500)
      .json({ error: 'Supabase not configured on server' })
  }
  try {
    const now = new Date()
    const currentYear = now.getFullYear()
    const currentMonth = now.getMonth()
    const nowIso = now.toISOString()

    const [
      beatsCountResp,
      salesResp,
      subsResp,
      ticketsOpenResp,
      reportsOpenResp,
      agentsResp,
      usersResp,
      activeBoostsResp,
    ] = await Promise.all([
      supabase.from('beats').select('id', { count: 'exact', head: true }),
      supabase.from('sales').select('beat_id,amount,created_at'),
      supabase.from('subscriptions').select('plan_id,status'),
      supabase
        .from('support_tickets')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'open'),
      supabase
        .from('reports')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'open'),
      supabase
        .from('support_agents')
        .select('id', { count: 'exact', head: true })
        .eq('active', true),
      supabase.auth.admin.listUsers({ page: 1, perPage: 1000 }),
      supabase
        .from('boosted_beats')
        .select('beat_id,tier,expires_at')
        .gt('expires_at', nowIso),
    ])

    const totalBeats = beatsCountResp?.count || 0

    const salesRows = salesResp?.data || []
    const totalSales = salesRows.length
    let monthlyRevenue = 0
    let monthlySales = 0
    for (const s of salesRows) {
      if (!s.created_at) continue
      const d = new Date(s.created_at)
      if (d.getFullYear() === currentYear && d.getMonth() === currentMonth) {
        monthlySales += 1
        monthlyRevenue += Number(s.amount || 0)
      }
    }

    const subsRows = subsResp?.data || []
    let activeStarter = 0
    let activePro = 0
    let activeProducerPro = 0
    for (const sub of subsRows) {
      if (sub.status !== 'active') continue
      if (sub.plan_id === 'starter') activeStarter += 1
      else if (sub.plan_id === 'pro') activePro += 1
      else if (sub.plan_id === 'producer-pro') activeProducerPro += 1
    }

    const openTickets = ticketsOpenResp?.count || 0
    const openReports = reportsOpenResp?.count || 0
    const activeAgents = agentsResp?.count || 0

    const totalUsers = Array.isArray(usersResp?.data?.users)
      ? usersResp.data.users.length
      : Array.isArray(usersResp?.data)
      ? usersResp.data.length
      : 0

    // Build a simple "top beats" list using sales counts and active boost tiers.
    const salesByBeat = new Map()
    for (const s of salesRows) {
      const beatId = s.beat_id
      if (!beatId) continue
      const entry = salesByBeat.get(beatId) || {
        beatId,
        sales: 0,
        revenue: 0,
      }
      entry.sales += 1
      entry.revenue += Number(s.amount || 0)
      salesByBeat.set(beatId, entry)
    }

    let topBeats = []
    const salesEntries = Array.from(salesByBeat.values())
      .sort((a, b) => b.sales - a.sales || b.revenue - a.revenue)
      .slice(0, 10)

    if (salesEntries.length) {
      const ids = salesEntries.map((e) => e.beatId)
      const { data: beatRows, error: beatsErr } = await supabase
        .from('beats')
        .select('id,title,producer,genre,bpm')
        .in('id', ids)
      if (beatsErr) {
        console.warn('[admin/metrics] topBeats beats query error', beatsErr)
      }
      const beatMap = new Map()
      ;(beatRows || []).forEach((b) => {
        beatMap.set(b.id, b)
      })

      const boostMap = new Map()
      const boostRows = activeBoostsResp?.data || []
      for (const row of boostRows) {
        if (!row.beat_id) continue
        const existing = boostMap.get(row.beat_id)
        if (!existing || (row.tier || 0) > existing) {
          boostMap.set(row.beat_id, row.tier || 0)
        }
      }

      topBeats = salesEntries.map((entry) => {
        const beat = beatMap.get(entry.beatId) || {}
        return {
          id: entry.beatId,
          title: beat.title || 'Untitled beat',
          producer: beat.producer || null,
          genre: beat.genre || null,
          bpm: beat.bpm || null,
          // Plays are not persisted globally yet; use sales count as a proxy for now.
          plays: entry.sales,
          sales: entry.sales,
          revenue: entry.revenue,
          boostTier: boostMap.get(entry.beatId) || null,
        }
      })
    }

    res.json({
      totalBeats,
      totalUsers,
      totalSales,
      monthlyRevenue,
      monthlySales,
      openTickets,
      openReports,
      activeAgents,
      activeStarter,
      activePro,
      activeProducerPro,
      topBeats,
    })
  } catch (err) {
    console.error('[admin/metrics] error', err)
    res.status(500).json({ error: 'Failed to load metrics' })
  }
})

// -------- Admin Recording Lab metrics (credits + sessions) --------
// Returns aggregate stats for Recording Lab credits and sessions so the
// admin analytics dashboard can show real-time KPIs.
// Shape:
// {
//   totalCreditsIssued: number,
//   totalCreditsUsed: number,
//   totalCreditsRemaining: number,
//   sessionsCompleted: number,
//   avgCreditsPerSession: number
// }
app.get('/admin/recording-lab', async (req, res) => {
  if (!supabaseAvailable()) {
    return res
      .status(500)
      .json({ error: 'Supabase not configured on server' })
  }

  try {
    const [creditsResp, historyResp] = await Promise.all([
      supabase.from('recording_credits').select('balance'),
      supabase.from('recording_credit_history').select('delta, source'),
    ])

    const creditRows = creditsResp?.data || []
    const historyRows = historyResp?.data || []

    let totalCreditsIssued = 0
    let totalCreditsUsed = 0
    let sessionsCompleted = 0

    for (const row of historyRows) {
      const delta = Number(row.delta) || 0
      if (delta > 0) {
        totalCreditsIssued += delta
      } else if (delta < 0) {
        // Treat negative deltas as usage; sessions specifically use source === 'session'.
        totalCreditsUsed += -delta
        if (row.source === 'session') {
          sessionsCompleted += 1
        }
      }
    }

    const totalCreditsRemaining = creditRows.reduce(
      (sum, r) => sum + (Number(r.balance) || 0),
      0,
    )

    const avgCreditsPerSession =
      sessionsCompleted > 0 ? totalCreditsUsed / sessionsCompleted : 0

    res.json({
      totalCreditsIssued,
      totalCreditsUsed,
      totalCreditsRemaining,
      sessionsCompleted,
      avgCreditsPerSession,
    })
  } catch (err) {
    console.error('[admin/recording-lab] error', err)
    res.status(500).json({ error: 'Failed to load Recording Lab metrics' })
  }
})

// Public list of active boosted beats (for homepage, search, etc.)
// Returns minimal data; frontend joins with beat catalog.
app.get('/api/boosted', async (req, res) => {
  if (!supabaseAvailable()) {
    return res.status(200).json([])
  }
  try {
    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('boosted_beats')
      .select('id, beat_id, producer_id, tier, starts_at, expires_at, priority_score, created_at')
      .gt('expires_at', now)
      .order('priority_score', { ascending: false })
      .order('starts_at', { ascending: false })
      .limit(200)

    if (error) {
      console.error('[boosted] select error', error)
      return res.status(500).json({ error: 'Failed to load boosted beats' })
    }

    res.json(data || [])
  } catch (err) {
    console.error('[boosted] unexpected error', err)
    res.status(500).json({ error: 'Failed to load boosted beats' })
  }
})

// Admin view of active boosts (can be extended with auth later)
app.get('/api/admin/boosts', async (req, res) => {
  if (!supabaseAvailable()) {
    return res.status(200).json({ active: 0, items: [] })
  }
  try {
    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('boosted_beats')
      .select('id, beat_id, producer_id, tier, starts_at, expires_at, priority_score, created_at')
      .gt('expires_at', now)
      .order('priority_score', { ascending: false })
      .order('starts_at', { ascending: false })
      .limit(500)

    if (error) {
      console.error('[admin/boosts] select error', error)
      return res.status(500).json({ error: 'Failed to load boosts' })
    }

    res.json({ active: data?.length || 0, items: data || [] })
  } catch (err) {
    console.error('[admin/boosts] unexpected error', err)
    res.status(500).json({ error: 'Failed to load boosts' })
  }
})

// Create a new boosted beat (server-side Supabase insert)
app.post('/boosts/create', async (req, res) => {
  if (!supabaseAvailable()) {
    return res.status(500).json({ error: 'Boosts not available (Supabase missing)' })
  }
  try {
    const { beat_id, producer_id, days, paypal_order_id } = req.body || {}
    if (!beat_id || !producer_id || !days) {
      return res.status(400).json({ error: 'beat_id, producer_id and days are required' })
    }

    const now = new Date()
    const expires = new Date(now.getTime() + Number(days) * 24 * 60 * 60 * 1000)

    // Simple tier mapping based on days (1,3,7,14,30)
    let tier = 1
    if (days >= 7 && days < 14) tier = 2
    else if (days >= 14) tier = 3

    const priorityScore = tier * 100

    const { data, error } = await supabase
      .from('boosted_beats')
      .insert({
        beat_id,
        producer_id,
        tier,
        starts_at: now.toISOString(),
        expires_at: expires.toISOString(),
        priority_score: priorityScore,
        paypal_order_id: paypal_order_id || null,
      })
      .select('id, beat_id, producer_id, tier, starts_at, expires_at, priority_score')
      .maybeSingle()

    if (error) {
      console.error('[boosts/create] supabase error', error)
      return res.status(500).json({ error: 'Failed to create boost' })
    }

    res.json({ ok: true, boost: data })
  } catch (err) {
    console.error('[boosts/create] unexpected', err)
    res.status(500).json({ error: 'Boost create failed' })
  }
})

// Record a completed job payment (PayPal order) and optionally persist metadata.
// Body: { orderId: string, amount?: number, currency?: string }
app.post('/api/jobs/:jobId/pay', async (req, res) => {
  const { jobId } = req.params || {}
  const { orderId, amount, currency } = req.body || {}
  if (!jobId || !orderId) {
    return res.status(400).json({ error: 'jobId and orderId required' })
  }
  if (!supabaseAvailable()) {
    console.warn('[job-pay] Supabase not configured; skipping persistence')
    return res.status(200).json({ ok: true, stored: false })
  }
  try {
    // Optional: store job payments in a dedicated table.
    // You can create a table:
    // create table if not exists public.job_payments (
    //   id uuid primary key default gen_random_uuid(),
    //   job_id text not null,
    //   paypal_order_id text not null,
    //   amount numeric,
    //   currency text,
    //   created_at timestamptz not null default now()
    // );
    const { error } = await supabase.from('job_payments').insert({
      job_id: jobId,
      paypal_order_id: orderId,
      amount: amount || null,
      currency: currency || null,
    })
    if (error) {
      console.error('[job-pay] insert error', error)
      return res.status(200).json({ ok: true, stored: false })
    }
    return res.status(200).json({ ok: true, stored: true })
  } catch (err) {
    console.error('[job-pay] unexpected error', err)
    return res.status(500).json({ error: 'Failed to record job payment' })
  }
})

// Pause a boost early by expiring it now
app.post('/api/admin/boosts/:id/pause', async (req, res) => {
  if (!supabaseAvailable()) {
    return res.status(503).json({ error: 'Boost service unavailable' })
  }
  const { id } = req.params
  if (!id) return res.status(400).json({ error: 'id is required' })
  try {
    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('boosted_beats')
      .update({ expires_at: now })
      .eq('id', id)
      .select()
      .maybeSingle()
    if (error) {
      console.error('[admin/boosts pause] update error', error)
      return res.status(500).json({ error: 'Failed to pause boost' })
    }
    res.json(data)
  } catch (err) {
    console.error('[admin/boosts pause] unexpected error', err)
    res.status(500).json({ error: 'Failed to pause boost' })
  }
})

// Delete a boost record
app.delete('/api/admin/boosts/:id', async (req, res) => {
  if (!supabaseAvailable()) {
    return res.status(503).json({ error: 'Boost service unavailable' })
  }
  const { id } = req.params
  if (!id) return res.status(400).json({ error: 'id is required' })
  try {
    const { error } = await supabase
      .from('boosted_beats')
      .delete()
      .eq('id', id)
    if (error) {
      console.error('[admin/boosts delete] delete error', error)
      return res.status(500).json({ error: 'Failed to delete boost' })
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('[admin/boosts delete] unexpected error', err)
    res.status(500).json({ error: 'Failed to delete boost' })
  }
})

// Activate or extend a boost after successful payment
// Body: { beatId, producerId, tier }
app.post('/api/boosts/activate', async (req, res) => {
  if (!supabaseAvailable()) {
    return res.status(503).json({ error: 'Boost service unavailable' })
  }
  try {
    const { beatId, producerId, tier } = req.body || {}
    const numericTier = Number(tier)
    if (!beatId || !producerId || !numericTier || ![1, 2, 3].includes(numericTier)) {
      return res.status(400).json({ error: 'beatId, producerId and valid tier (1-3) are required' })
    }

    const boostLengthDays = {
      1: 3,
      2: 7,
      3: 30
    }
    const priorityScore = numericTier * 100

    const now = new Date()
    let expiresAt = new Date(now.getTime() + boostLengthDays[numericTier] * 24 * 60 * 60 * 1000)

    // If there is an existing active boost, extend from its expiry
    const { data: existing, error: existingError } = await supabase
      .from('boosted_beats')
      .select('id, expires_at')
      .eq('beat_id', beatId)
      .order('expires_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (existingError && existingError.code !== 'PGRST116') {
      console.warn('[boosts/activate] existing lookup error', existingError)
    }

    if (existing && existing.expires_at) {
      const currentExpiry = new Date(existing.expires_at)
      const base = currentExpiry > now ? currentExpiry : now
      expiresAt = new Date(base.getTime() + boostLengthDays[numericTier] * 24 * 60 * 60 * 1000)
    }

    const payload = {
      beat_id: beatId,
      producer_id: producerId,
      tier: numericTier,
      starts_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      priority_score: priorityScore
    }

    const { data, error } = await supabase
      .from('boosted_beats')
      .upsert(payload, { onConflict: 'beat_id' })
      .select()
      .maybeSingle()

    if (error) {
      console.error('[boosts/activate] upsert error', error)
      return res.status(500).json({ error: 'Failed to activate boost' })
    }

    res.json(data)
  } catch (err) {
    console.error('[boosts/activate] unexpected error', err)
    res.status(500).json({ error: 'Failed to activate boost' })
  }
})

// User-facing: pause a boost (expires it immediately)
app.post('/api/boosts/:id/pause', async (req, res) => {
  if (!supabaseAvailable()) {
    return res.status(503).json({ error: 'Boost service unavailable' })
  }
  const { id } = req.params
  if (!id) return res.status(400).json({ error: 'id is required' })
  try {
    const now = new Date().toISOString()
    const { data, error } = await supabase
      .from('boosted_beats')
      .update({ expires_at: now })
      .eq('id', id)
      .select()
      .maybeSingle()
    if (error) {
      console.error('[boosts pause] update error', error)
      return res.status(500).json({ error: 'Failed to pause boost' })
    }
    res.json(data)
  } catch (err) {
    console.error('[boosts pause] unexpected error', err)
    res.status(500).json({ error: 'Failed to pause boost' })
  }
})

// User-facing: delete a boost record
app.delete('/api/boosts/:id', async (req, res) => {
  if (!supabaseAvailable()) {
    return res.status(503).json({ error: 'Boost service unavailable' })
  }
  const { id } = req.params
  if (!id) return res.status(400).json({ error: 'id is required' })
  try {
    const { error } = await supabase
      .from('boosted_beats')
      .delete()
      .eq('id', id)
    if (error) {
      console.error('[boosts delete] delete error', error)
      return res.status(500).json({ error: 'Failed to delete boost' })
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('[boosts delete] unexpected error', err)
    res.status(500).json({ error: 'Failed to delete boost' })
  }
})

// Manually activate a subscription record after PayPal approve flow.
// Body: { userId, planId, providerSubscriptionId }
app.post('/api/subscriptions/activate', async (req, res) => {
  if (!supabaseAvailable()) {
    return res.status(503).json({ error: 'Supabase unavailable' })
  }
  try {
    const { userId, planId, providerSubscriptionId } = req.body || {}
    if (!userId || !planId || !providerSubscriptionId) {
      return res.status(400).json({ error: 'userId, planId and providerSubscriptionId required' })
    }
    const currentPeriodEnd = computeSubscriptionPeriodEnd(planId)
    const payload = {
      user_id: userId,
      plan_id: planId,
      status: 'active',
      provider: 'paypal',
      provider_subscription_id: providerSubscriptionId,
      auto_renew: true,
      current_period_end: currentPeriodEnd,
      cancel_at_period_end: false,
    }
    const { data, error } = await supabase
      .from('subscriptions')
      .insert(payload)
      .select()
      .maybeSingle()
    if (error) {
      console.error('[subscriptions/activate] insert error', error)
      return res.status(500).json({ error: 'Failed to activate subscription' })
    }
    res.json(data)
  } catch (err) {
    console.error('[subscriptions/activate] unexpected error', err)
    res.status(500).json({ error: 'Failed to activate subscription' })
  }
})

// Helper to compute next subscription period end (prototype: 30 days)
function computeSubscriptionPeriodEnd(planId) {
  const now = new Date()
  const days = planId === 'starter' || planId === 'pro' ? 30 : 30
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString()
}

// PayPal subscription webhook sketch (for future recurring billing)
// Configure PayPal to POST webhooks to this endpoint.
// Important: in production you must validate the webhook signature using PayPal SDK
// and your PAYPAL_WEBHOOK_ID. This handler only sketches core flows.
app.post('/api/paypal/subscription-webhook', express.json({ type: 'application/json' }), async (req, res) => {
  if (!supabaseAvailable()) {
    return res.status(503).json({ error: 'Supabase unavailable' })
  }
  try {
    const event = req.body
    if (!event || !event.event_type) {
      return res.status(400).json({ error: 'Invalid webhook payload' })
    }

    // TODO: verify PayPal webhook authenticity using SDK + paypalWebhookId

    const eventType = event.event_type
    const resource = event.resource || {}
    const subscriptionId = resource.id || resource.subscription_id
    const customId = resource.custom_id || resource.custom || null

    // We expect custom_id to contain our internal user + plan info, e.g. "user:{userId}|plan:{planId}"
    let userId = null
    let planId = null
    if (typeof customId === 'string') {
      customId.split('|').forEach(part => {
        const [k, v] = part.split(':')
        if (k === 'user') userId = v
        if (k === 'plan') planId = v
      })
    }

    if (eventType === 'BILLING.SUBSCRIPTION.ACTIVATED' || eventType === 'BILLING.SUBSCRIPTION.UPDATED') {
      if (!userId || !planId || !subscriptionId) {
        console.warn('[paypal-sub] missing userId/planId/subscriptionId in activation')
      } else {
        const currentPeriodEnd = computeSubscriptionPeriodEnd(planId)
        const payload = {
          user_id: userId,
          plan_id: planId,
          status: 'active',
          provider: 'paypal',
          provider_subscription_id: subscriptionId,
          auto_renew: true,
          current_period_end: currentPeriodEnd,
          cancel_at_period_end: false
        }
        const { error } = await supabase
          .from('subscriptions')
          .upsert(payload, { onConflict: 'user_id,plan_id' })
        if (error) {
          console.error('[paypal-sub] upsert error', error)
        }
      }
    } else if (eventType === 'PAYMENT.SALE.COMPLETED') {
      if (subscriptionId) {
        const { error } = await supabase
          .from('subscriptions')
          .update({
            last_payment_at: new Date().toISOString(),
            status: 'active'
          })
          .eq('provider_subscription_id', subscriptionId)
        if (error) {
          console.error('[paypal-sub] update last_payment_at error', error)
        }
      }
    } else if (eventType === 'BILLING.SUBSCRIPTION.CANCELLED') {
      if (subscriptionId) {
        const { error } = await supabase
          .from('subscriptions')
          .update({
            status: 'canceled',
            auto_renew: false,
            cancel_at_period_end: true,
            canceled_at: new Date().toISOString()
          })
          .eq('provider_subscription_id', subscriptionId)
        if (error) {
          console.error('[paypal-sub] cancel update error', error)
        }
      }
    }

    res.status(200).json({ ok: true })
  } catch (err) {
    console.error('[paypal-sub] webhook error', err)
    res.status(500).json({ error: 'Webhook handling failed' })
  }
})

const PORT = process.env.PORT || 5001
// Generic notification endpoint (service orders & job requests)
// Body: { kind: 'service-order'|'job-request', event: string, toEmail?: string, payload?: object }
app.post('/api/notify', async (req, res) => {
  try {
    if (!transporter) return res.status(200).json({ skipped: true, reason: 'Email disabled (no transporter)' })
    const { kind, event, toEmail, payload } = req.body || {}
    if (!kind || !event) return res.status(400).json({ error: 'kind and event required' })
    const recipient = toEmail || payload?.buyerEmail || payload?.requesterEmail
    if (!recipient) return res.status(400).json({ error: 'recipient email missing' })
    let subject = 'RiddimBase Notification'
    let text = 'An event occurred.'
    let html = `<p>An event occurred.</p>`
    if (kind === 'service-order') {
      if (event === 'accepted') {
        subject = 'Your service order was accepted'
        text = `Good news! Your order ${payload?.orderId || ''} has been accepted and is now in progress.`
        html = `<p>Good news! Your order <strong>${payload?.orderId || ''}</strong> has been accepted and is now in progress.</p>`
      } else if (event === 'completed') {
        subject = 'Your service order was completed'
        text = `Your order ${payload?.orderId || ''} has been marked completed. Thank you!`
        html = `<p>Your order <strong>${payload?.orderId || ''}</strong> has been marked completed. Thank you for using RiddimBase!</p>`
      }
    } else if (kind === 'job-request') {
      if (event === 'posted') {
        subject = 'Job request received'
        text = `We received your job request ${payload?.title || ''}. Providers will start bidding soon.`
        html = `<p>We received your job request <strong>${payload?.title || ''}</strong>. Providers will start bidding soon.</p>`
      } else if (event === 'assigned') {
        subject = 'Your job request was assigned'
        text = `Job ${payload?.title || ''} has been assigned to a provider.`
        html = `<p>Your job <strong>${payload?.title || ''}</strong> has been assigned to a provider.</p>`
      }
    }
    try {
      await transporter.sendMail({
        from: process.env.EMAIL_FROM || 'no-reply@riddimbasesound.com',
        to: recipient,
        subject,
        text,
        html
      })
    } catch (e) {
      console.warn('[notify] send failed', e.message)
      return res.status(500).json({ error: 'Failed to send email' })
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('[notify] error', err)
    res.status(500).json({ error: 'Notify failed' })
  }
})

// ---------------------------
// Site-wide configuration
// ---------------------------

// Homepage banner defaults (mirror frontend bannerContentService defaults)
const DEFAULT_BANNER_CONTENT = {
  headline: 'Platform Spotlight',
  headlineBold: true,
  headlineItalic: false,
  headlineSize: 'text-2xl',
  headlineFont: 'font-display',
  body: 'Discover authentic Caribbean production. Browse fresh beats & riddims uploaded daily by emerging producers.',
  bodyBold: false,
  bodyItalic: false,
  bodySize: 'text-sm',
  bodyFont: 'font-sans',
}

// Global site social links (footer icons)
const DEFAULT_SOCIALS = [
  { id: 'instagram', network: 'instagram', url: '' },
  { id: 'youtube', network: 'youtube', url: '' },
  { id: 'tiktok', network: 'tiktok', url: '' },
  { id: 'twitter', network: 'twitter', url: '' },
  { id: 'facebook', network: 'facebook', url: '' },
  { id: 'soundcloud', network: 'soundcloud', url: '' },
  { id: 'spotify', network: 'spotify', url: '' },
]

app.get('/api/site/social-links', async (req, res) => {
  if (!supabaseAvailable()) {
    return res.json(DEFAULT_SOCIALS)
  }
  try {
    const { data, error } = await supabase
      .from('site_social_links')
      .select('id,network,url,position')
      .order('position', { ascending: true })

    if (error) {
      console.warn('[site_social_links] select error', error.message)
      return res.json(DEFAULT_SOCIALS)
    }

    if (!data || !data.length) {
      return res.json(DEFAULT_SOCIALS)
    }

    res.json(
      data.map((row) => ({
        id: row.id,
        network: row.network,
        url: row.url || '',
      })),
    )
  } catch (err) {
    console.error('[site_social_links] unexpected error', err)
    res.json(DEFAULT_SOCIALS)
  }
})

app.put('/api/site/social-links', async (req, res) => {
  if (!supabaseAvailable()) {
    return res.status(500).json({ error: 'Supabase not configured on server' })
  }
  const links = Array.isArray(req.body?.links) ? req.body.links : []
  try {
    const cleaned = links.map((l, index) => ({
      id: l.id || l.network,
      network: l.network,
      url: l.url || '',
      position: index,
      updated_at: new Date().toISOString(),
    }))

    if (!cleaned.length) {
      const { error } = await supabase
        .from('site_social_links')
        .delete()
        .neq('id', '')
      if (error) {
        console.error('[site_social_links] delete all error', error)
      }
      return res.json([])
    }

    const { data, error } = await supabase
      .from('site_social_links')
      .upsert(cleaned, { onConflict: 'id' })
      .select('id,network,url,position')
      .order('position', { ascending: true })

    if (error) {
      console.error('[site_social_links] upsert error', error)
      return res.status(500).json({ error: 'Failed to save social links' })
    }

    res.json(
      (data || []).map((row) => ({
        id: row.id,
        network: row.network,
        url: row.url || '',
      })),
    )
  } catch (err) {
    console.error('[site_social_links] unexpected save error', err)
    res.status(500).json({ error: 'Failed to save social links' })
  }
})

// Footer navigation links (About, FAQ, Support, etc.)
const DEFAULT_FOOTER_LINKS = [
  { id: 'about', label: 'About', path: '/about' },
  { id: 'faq', label: 'FAQ', path: '/faq' },
  { id: 'support', label: 'Support', path: '/support' },
  { id: 'terms', label: 'Terms', path: '/terms' },
  { id: 'privacy', label: 'Privacy', path: '/privacy' },
]

app.get('/api/site/footer-links', async (req, res) => {
  if (!supabaseAvailable()) {
    return res.json(DEFAULT_FOOTER_LINKS)
  }
  try {
    const { data, error } = await supabase
      .from('site_footer_links')
      .select('id,label,path,position')
      .order('position', { ascending: true })

    if (error) {
      console.warn('[site_footer_links] select error', error.message)
      return res.json(DEFAULT_FOOTER_LINKS)
    }

    if (!data || !data.length) {
      return res.json(DEFAULT_FOOTER_LINKS)
    }

    res.json(
      data.map((row) => ({
        id: row.id,
        label: row.label,
        path: row.path,
      })),
    )
  } catch (err) {
    console.error('[site_footer_links] unexpected error', err)
    res.json(DEFAULT_FOOTER_LINKS)
  }
})

app.put('/api/site/footer-links', async (req, res) => {
  if (!supabaseAvailable()) {
    return res.status(500).json({ error: 'Supabase not configured on server' })
  }
  const links = Array.isArray(req.body?.links) ? req.body.links : []
  try {
    const cleaned = links.map((l, index) => ({
      id: l.id || l.label,
      label: l.label,
      path: l.path || l.to || '/',
      position: index,
      updated_at: new Date().toISOString(),
    }))

    if (!cleaned.length) {
      const { error } = await supabase
        .from('site_footer_links')
        .delete()
        .neq('id', '')
      if (error) {
        console.error('[site_footer_links] delete all error', error)
      }
      return res.json([])
    }

    const { data, error } = await supabase
      .from('site_footer_links')
      .upsert(cleaned, { onConflict: 'id' })
      .select('id,label,path,position')
      .order('position', { ascending: true })

    if (error) {
      console.error('[site_footer_links] upsert error', error)
      return res.status(500).json({ error: 'Failed to save footer links' })
    }

    res.json(
      (data || []).map((row) => ({
        id: row.id,
        label: row.label,
        path: row.path,
      })),
    )
  } catch (err) {
    console.error('[site_footer_links] unexpected save error', err)
    res.status(500).json({ error: 'Failed to save footer links' })
  }
})

// Homepage hero banners (image/video URLs, active flag)
app.get('/api/site/banners', async (req, res) => {
  if (!supabaseAvailable()) {
    return res.json([])
  }
  try {
    const { data, error } = await supabase
      .from('site_banners')
      .select('id,data_url,kind,content_type,is_active,created_at')
      .order('created_at', { ascending: false })

    if (error) {
      console.warn('[site_banners] select error', error.message)
      return res.json([])
    }

    const mapped = (data || []).map((row) => ({
      id: row.id,
      dataUrl: row.data_url,
      kind: row.kind || 'image',
      contentType: row.content_type || null,
      active: !!row.is_active,
      createdAt: row.created_at,
    }))

    res.json(mapped)
  } catch (err) {
    console.error('[site_banners] list unexpected error', err)
    res.json([])
  }
})

// Create a new banner entry after the file has been uploaded to S3.
// Body: { dataUrl, kind?, contentType? }
app.post('/api/site/banners', async (req, res) => {
  if (!supabaseAvailable()) {
    return res.status(500).json({ error: 'Supabase not configured on server' })
  }
  const { dataUrl, kind, contentType } = req.body || {}
  if (!dataUrl) {
    return res.status(400).json({ error: 'dataUrl is required' })
  }
  try {
    const nowIso = new Date().toISOString()
    const payload = {
      data_url: dataUrl,
      kind: kind || 'image',
      content_type: contentType || null,
      is_active: false,
      updated_at: nowIso,
    }
    const { data, error } = await supabase
      .from('site_banners')
      .insert(payload)
      .select('id,data_url,kind,content_type,is_active,created_at')
      .single()

    if (error) {
      console.error('[site_banners] insert error', error)
      return res.status(500).json({ error: 'Failed to save banner' })
    }

    res.json({
      id: data.id,
      dataUrl: data.data_url,
      kind: data.kind || 'image',
      contentType: data.content_type || null,
      active: !!data.is_active,
      createdAt: data.created_at,
    })
  } catch (err) {
    console.error('[site_banners] insert unexpected error', err)
    res.status(500).json({ error: 'Failed to save banner' })
  }
})

// Set one banner active and all others inactive.
app.put('/api/site/banners/:id/active', async (req, res) => {
  if (!supabaseAvailable()) {
    return res.status(500).json({ error: 'Supabase not configured on server' })
  }
  const { id } = req.params
  if (!id) {
    return res.status(400).json({ error: 'id required' })
  }
  try {
    const nowIso = new Date().toISOString()
    // Deactivate all
    const { error: resetErr } = await supabase
      .from('site_banners')
      .update({ is_active: false, updated_at: nowIso })
      .eq('is_active', true)
    if (resetErr) {
      console.warn('[site_banners] deactivate all error', resetErr.message)
    }

    const { error: activateErr } = await supabase
      .from('site_banners')
      .update({ is_active: true, updated_at: nowIso })
      .eq('id', id)
    if (activateErr) {
      console.error('[site_banners] activate error', activateErr)
      return res.status(500).json({ error: 'Failed to activate banner' })
    }

    // Return latest list
    const { data, error } = await supabase
      .from('site_banners')
      .select('id,data_url,kind,content_type,is_active,created_at')
      .order('created_at', { ascending: false })

    if (error) {
      console.warn('[site_banners] select after activate error', error.message)
      return res.json([])
    }

    const mapped = (data || []).map((row) => ({
      id: row.id,
      dataUrl: row.data_url,
      kind: row.kind || 'image',
      contentType: row.content_type || null,
      active: !!row.is_active,
      createdAt: row.created_at,
    }))

    res.json(mapped)
  } catch (err) {
    console.error('[site_banners] activate unexpected error', err)
    res.status(500).json({ error: 'Failed to activate banner' })
  }
})

// Delete a banner
app.delete('/api/site/banners/:id', async (req, res) => {
  if (!supabaseAvailable()) {
    return res.status(500).json({ error: 'Supabase not configured on server' })
  }
  const { id } = req.params
  if (!id) {
    return res.status(400).json({ error: 'id required' })
  }
  try {
    const { error } = await supabase.from('site_banners').delete().eq('id', id)
    if (error) {
      console.error('[site_banners] delete error', error)
      return res.status(500).json({ error: 'Failed to delete banner' })
    }

    const { data, error: selErr } = await supabase
      .from('site_banners')
      .select('id,data_url,kind,content_type,is_active,created_at')
      .order('created_at', { ascending: false })

    if (selErr) {
      console.warn('[site_banners] select after delete error', selErr.message)
      return res.json([])
    }

    const mapped = (data || []).map((row) => ({
      id: row.id,
      dataUrl: row.data_url,
      kind: row.kind || 'image',
      contentType: row.content_type || null,
      active: !!row.is_active,
      createdAt: row.created_at,
    }))

    res.json(mapped)
  } catch (err) {
    console.error('[site_banners] delete unexpected error', err)
    res.status(500).json({ error: 'Failed to delete banner' })
  }
})

// Homepage banner text / typography content
app.get('/api/site/banner-content', async (req, res) => {
  if (!supabaseAvailable()) {
    return res.json(DEFAULT_BANNER_CONTENT)
  }
  try {
    const { data, error } = await supabase
      .from('site_banner_content')
      .select('*')
      .eq('id', 'home-hero')
      .maybeSingle()

    if (error && error.code !== 'PGRST116') {
      console.warn('[site_banner_content] select error', error.message)
      return res.json(DEFAULT_BANNER_CONTENT)
    }

    if (!data) {
      return res.json(DEFAULT_BANNER_CONTENT)
    }

    res.json({
      headline: data.headline,
      headlineBold: !!data.headline_bold,
      headlineItalic: !!data.headline_italic,
      headlineSize: data.headline_size,
      headlineFont: data.headline_font,
      body: data.body,
      bodyBold: !!data.body_bold,
      bodyItalic: !!data.body_italic,
      bodySize: data.body_size,
      bodyFont: data.body_font,
    })
  } catch (err) {
    console.error('[site_banner_content] unexpected select error', err)
    res.json(DEFAULT_BANNER_CONTENT)
  }
})

app.put('/api/site/banner-content', async (req, res) => {
  if (!supabaseAvailable()) {
    return res.status(500).json({ error: 'Supabase not configured on server' })
  }
  const content = req.body?.content || {}
  const merged = {
    ...DEFAULT_BANNER_CONTENT,
    ...content,
  }
  try {
    const payload = {
      id: 'home-hero',
      headline: merged.headline,
      headline_bold: !!merged.headlineBold,
      headline_italic: !!merged.headlineItalic,
      headline_size: merged.headlineSize,
      headline_font: merged.headlineFont,
      body: merged.body,
      body_bold: !!merged.bodyBold,
      body_italic: !!merged.bodyItalic,
      body_size: merged.bodySize,
      body_font: merged.bodyFont,
      updated_at: new Date().toISOString(),
    }

    const { data, error } = await supabase
      .from('site_banner_content')
      .upsert(payload, { onConflict: 'id' })
      .select('*')
      .single()

    if (error) {
      console.error('[site_banner_content] upsert error', error)
      return res.status(500).json({ error: 'Failed to save banner content' })
    }

    res.json({
      headline: data.headline,
      headlineBold: !!data.headline_bold,
      headlineItalic: !!data.headline_italic,
      headlineSize: data.headline_size,
      headlineFont: data.headline_font,
      body: data.body,
      bodyBold: !!data.body_bold,
      bodyItalic: !!data.body_italic,
      bodySize: data.body_size,
      bodyFont: data.body_font,
    })
  } catch (err) {
    console.error('[site_banner_content] unexpected upsert error', err)
    res.status(500).json({ error: 'Failed to save banner content' })
  }
})

// -------- Admin support tickets (server-side Supabase, bypassing RLS) --------
app.get('/admin/support-tickets', async (req, res) => {
  if (!supabaseAvailable()) {
    return res
      .status(500)
      .json({ error: 'Supabase not configured on server' })
  }
  try {
    const { data, error } = await supabase
      .from('support_tickets')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) {
      console.error('[admin/support-tickets] list error', error)
      return res
        .status(500)
        .json({ error: 'Failed to list support tickets' })
    }

    res.json({ tickets: data || [] })
  } catch (err) {
    console.error('[admin/support-tickets] unexpected', err)
    res
      .status(500)
      .json({ error: 'Failed to list support tickets' })
  }
})

app.listen(PORT, () => console.log(`[s3-server] listening on ${PORT}`))
