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
  console.warn('[payoutRoutes] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
}

const adminKey = process.env.ADMIN_API_KEY || null
const assertAdmin = (req, res) => {
  if (!adminKey) return true
  const got = req.header('x-admin-key')
  if (got && got === adminKey) return true
  res.status(401).json({ error: 'Unauthorized' })
  return false
}

router.get('/api/admin/payouts', async (req, res) => {
  try {
    if (!assertAdmin(req, res)) return
    if (!supabase) return res.status(500).json({ error: 'Supabase not configured' })

    const { data, error } = await supabase
      .from('payouts')
      .select('*')
      .order('created_at', { ascending: false })

    if (error) return res.status(500).json({ error: error.message })
    res.json({ ok: true, items: data || [] })
  } catch (e) {
    console.error('[payoutRoutes] list error', e)
    res.status(500).json({ error: 'Failed to load payouts' })
  }
})

router.post('/api/admin/payouts/:id/approve', async (req, res) => {
  try {
    if (!assertAdmin(req, res)) return
    if (!supabase) return res.status(500).json({ error: 'Supabase not configured' })
    const id = req.params?.id
    if (!id) return res.status(400).json({ error: 'id required' })

    const { data, error } = await supabase
      .from('payouts')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', id)
      .select('*')
      .maybeSingle()
    if (error) return res.status(500).json({ error: error.message })
    if (!data) return res.status(404).json({ error: 'Not found' })

    res.json({ ok: true, payout: data })
  } catch (e) {
    console.error('[payoutRoutes] approve error', e)
    res.status(500).json({ error: 'Failed to approve payout' })
  }
})

router.post('/api/admin/payouts/:id/deny', async (req, res) => {
  try {
    if (!assertAdmin(req, res)) return
    if (!supabase) return res.status(500).json({ error: 'Supabase not configured' })
    const id = req.params?.id
    if (!id) return res.status(400).json({ error: 'id required' })

    const { data, error } = await supabase
      .from('payouts')
      .update({ status: 'cancelled' })
      .eq('id', id)
      .select('*')
      .maybeSingle()
    if (error) return res.status(500).json({ error: error.message })
    if (!data) return res.status(404).json({ error: 'Not found' })

    res.json({ ok: true, payout: data })
  } catch (e) {
    console.error('[payoutRoutes] deny error', e)
    res.status(500).json({ error: 'Failed to deny payout' })
  }
})

export default router
