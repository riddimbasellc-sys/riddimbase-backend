import express from 'express'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config()

const router = express.Router()

const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

let supabase = null
if (supabaseUrl && supabaseServiceKey) {
  supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  })
} else {
  console.warn('[collabRoutes] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
}

// Upsert collaborators for a beat.
// Body: { beat_id, collaborators: [{ user_id?, email?, role?, split_percentage }] }
router.post('/collab/set', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'Supabase not configured' })
    const { beat_id, collaborators } = req.body || {}
    if (!beat_id || !Array.isArray(collaborators)) {
      return res.status(400).json({ error: 'beat_id and collaborators are required' })
    }
    const total = collaborators.reduce((sum, c) => sum + Number(c.split_percentage || c.split || 0), 0)
    if (Math.round(total) !== 100) {
      return res.status(400).json({ error: 'Split percentages must total 100%' })
    }
    const clean = collaborators.map((c) => ({
      beat_id,
      user_id: c.user_id || null,
      email: c.email || null,
      role: c.role || null,
      split_percentage: Number(c.split_percentage || c.split || 0),
    }))
    // Delete existing then insert new set
    await supabase.from('collaborators').delete().eq('beat_id', beat_id)
    const { data, error } = await supabase.from('collaborators').insert(clean).select('*')
    if (error) return res.status(400).json({ error: error.message })
    return res.json({ ok: true, collaborators: data || [] })
  } catch (e) {
    console.error('[collabRoutes] set error', e)
    return res.status(500).json({ error: 'Server error' })
  }
})

export default router
