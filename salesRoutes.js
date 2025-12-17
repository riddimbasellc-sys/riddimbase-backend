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
  console.warn('[salesRoutes] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
}

// Record a sale split for a beat.
// Body: { sale_id, beat_id, amount, platform_fee_rate?, currency? }
router.post('/sales/record-split', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'Supabase not configured' })
    const { sale_id, beat_id, amount, platform_fee_rate = 0.10, currency = 'USD' } = req.body || {}
    const totalAmount = Number(amount || 0)
    if (!sale_id || !beat_id || !Number.isFinite(totalAmount)) {
      return res.status(400).json({ error: 'sale_id, beat_id and amount are required' })
    }
    const creatorRevenue = Math.max(0, totalAmount * (1 - Number(platform_fee_rate || 0)))
    const { data: collabs, error: collabErr } = await supabase
      .from('collaborators')
      .select('id, user_id, split_percentage')
      .eq('beat_id', beat_id)
    if (collabErr) return res.status(400).json({ error: collabErr.message })
    if (!collabs || collabs.length === 0) {
      return res.json({ ok: true, entries: [], message: 'No collaborators found' })
    }
    const inserts = []
    for (const c of collabs) {
      const payout = Number(((creatorRevenue * Number(c.split_percentage || 0)) / 100).toFixed(2))
      inserts.push({ sale_id, beat_id, collaborator_id: c.id, amount_earned: payout, currency })
    }
    // Insert split ledger rows
    const { data: ledger, error: ledgerErr } = await supabase
      .from('beat_sales_split')
      .insert(inserts)
      .select('*')
    if (ledgerErr) return res.status(400).json({ error: ledgerErr.message })
    // Update wallets for collaborators with user_id
    for (const c of collabs) {
      if (!c.user_id) continue
      const payout = Number(((creatorRevenue * Number(c.split_percentage || 0)) / 100).toFixed(2))
      // Upsert wallet balance
      const { data: wallet } = await supabase
        .from('user_wallet')
        .select('user_id,balance')
        .eq('user_id', c.user_id)
        .maybeSingle()
      const newBalance = Number((Number(wallet?.balance || 0) + payout).toFixed(2))
      await supabase
        .from('user_wallet')
        .upsert({ user_id: c.user_id, balance: newBalance, updated_at: new Date().toISOString() })
    }
    return res.json({ ok: true, entries: ledger || [], creatorRevenue })
  } catch (e) {
    console.error('[salesRoutes] record-split error', e)
    return res.status(500).json({ error: 'Server error' })
  }
})

export default router
