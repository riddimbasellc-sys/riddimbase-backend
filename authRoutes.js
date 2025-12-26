import express from 'express'
import nodemailer from 'nodemailer'
import { createClient } from '@supabase/supabase-js'

const router = express.Router()

const SMTP_HOST = process.env.SMTP_HOST
const SMTP_PORT = process.env.SMTP_PORT
const SMTP_USER = process.env.SMTP_USER
const SMTP_PASS = process.env.SMTP_PASS
const WEB_BASE_URL = process.env.WEB_BASE_URL || 'https://www.riddimbase.app'

let mailTransporter = null
if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
  mailTransporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT) || 587,
    secure: false,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  })
}

// Supabase server client (use SERVICE ROLE key here – NOT the anon key)
const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

let supabase = null
if (supabaseUrl && supabaseServiceKey) {
  supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  })
} else {
  console.warn('[authRoutes] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY; auth routes disabled')
}

function buildWelcomeEmail({ toEmail, displayName }) {
  const safeName = displayName || toEmail || 'there'
  const appUrl = WEB_BASE_URL

  const subject = 'Welcome to RiddimBase 🔥'
  const text = `Hey ${safeName}, welcome to RiddimBase – the Caribbean's home for beats, producers and Recording Lab. Jump in, upload beats, book sessions and explore the marketplace: ${appUrl}`

  const html = `
<table width="100%" cellpadding="0" cellspacing="0" style="margin:0;background:#0b0b0b;color:#ffffff;">
  <tr>
    <td align="center" style="padding:40px 20px;">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#121212;border-radius:12px;padding:30px;">
        <tr>
          <td align="center">
            <h1 style="color:#ff7a00;margin:0 0 8px 0;font-size:24px;">Welcome to RiddimBase 🔥</h1>
            <p style="font-size:16px;color:#cccccc;margin:0;">
              The Caribbean's home for beats, producers &amp; culture.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 0;">
            <p style="font-size:15px;line-height:1.6;margin:0 0 10px 0;">
              Hey ${safeName}, you’re officially part of a growing movement built for
              producers, artists, and creatives who want more control,
              better splits, and real opportunities.
            </p>
            <ul style="color:#bbbbbb;padding-left:20px;margin:10px 0 0 0;font-size:14px;">
              <li>Upload &amp; sell beats</li>
              <li>Automated royalty splits</li>
              <li>Recording Lab with studio credits</li>
              <li>Built for the culture 🌍</li>
            </ul>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding-top:20px;">
            <a href="${appUrl}" style="background:#ff7a00;color:#000;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:14px;display:inline-block;">
              Go to RiddimBase
            </a>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding-top:30px;color:#777;font-size:12px;">
            © RiddimBase — Built for the culture
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
  `

  return { subject, text, html }
}

const sanitizeUser = (user) => {
  if (!user) return null
  return {
    id: user.id,
    email: user.email,
    created_at: user.created_at,
    user_metadata: user.user_metadata || {},
  }
}

// POST /api/auth/signup
router.post('/api/auth/signup', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: 'Supabase not configured on backend' })
    }
    const { email, password, fullName } = req.body || {}
    if (!email || !password) {
      return res
        .status(400)
        .json({ error: 'Email and password are required.' })
    }

    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        fullName: fullName || '',
      },
    })

    if (error) {
      console.error('[auth] signup error:', error)
      return res.status(400).json({ error: error.message })
    }

    try {
      if (mailTransporter && data.user?.email) {
        const emailConfig = buildWelcomeEmail({
          toEmail: data.user.email,
          displayName: fullName,
        })

        await mailTransporter.sendMail({
          from: `RiddimBase <${SMTP_USER}>`,
          to: data.user.email,
          subject: emailConfig.subject,
          text: emailConfig.text,
          html: emailConfig.html,
        })
      }
    } catch (mailErr) {
      console.error('[auth] welcome email send error:', mailErr)
    }

    return res.status(201).json({
      message: 'User created successfully.',
      user: sanitizeUser(data.user),
    })
  } catch (err) {
    console.error('[auth] signup route error:', err)
    res.status(500).json({ error: 'Internal server error.' })
  }
})

// POST /api/auth/login
router.post('/api/auth/login', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: 'Supabase not configured on backend' })
    }
    const { email, password } = req.body || {}
    if (!email || !password) {
      return res
        .status(400)
        .json({ error: 'Email and password are required.' })
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (error) {
      console.error('[auth] login error:', error)
      return res.status(401).json({ error: error.message })
    }

    return res.json({
      user: sanitizeUser(data.user),
      access_token: data.session?.access_token,
      refresh_token: data.session?.refresh_token,
      expires_in: data.session?.expires_in,
    })
  } catch (err) {
    console.error('[auth] login route error:', err)
    res.status(500).json({ error: 'Internal server error.' })
  }
})

// GET /api/auth/me
router.get('/api/auth/me', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: 'Supabase not configured on backend' })
    }
    const authHeader = req.headers.authorization || ''
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : null

    if (!token) {
      return res.status(401).json({ error: 'Missing access token.' })
    }

    const { data, error } = await supabase.auth.getUser(token)
    if (error || !data?.user) {
      console.error('[auth] getUser error:', error)
      return res.status(401).json({ error: 'Invalid or expired token.' })
    }

    res.json({ user: sanitizeUser(data.user) })
  } catch (err) {
    console.error('[auth] me route error:', err)
    res.status(500).json({ error: 'Internal server error.' })
  }
})

export default router

