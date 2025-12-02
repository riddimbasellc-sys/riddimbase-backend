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

app.listen(PORT, () => console.log(`[s3-server] listening on ${PORT}`))
