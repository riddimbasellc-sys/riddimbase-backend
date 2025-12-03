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

const app = express()
app.use(cors())
app.use(express.json())
app.use(authRoutes)
app.use(settingsRoutes)
app.use('/beats', beatsRoutes)

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
const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const paypalWebhookId = process.env.PAYPAL_WEBHOOK_ID || null

let supabase = null
if (supabaseUrl && supabaseServiceKey) {
  supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false }
  })
} else {
  console.warn('[supabase] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing - boost APIs disabled')
}

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

app.listen(PORT, () => console.log(`[s3-server] listening on ${PORT}`))
