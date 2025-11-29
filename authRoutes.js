import express from 'express'
import { createClient } from '@supabase/supabase-js'

const router = express.Router()

// Supabase server client (use SERVICE ROLE key here – NOT the anon key)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
)

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

