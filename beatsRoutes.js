import express from 'express'
import multer from 'multer'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'

dotenv.config()

const router = express.Router()

// Multer in-memory storage for single file uploads
const upload = multer({ storage: multer.memoryStorage() })

// AWS S3 client (uses same env vars as main server)
const REGION = process.env.AWS_REGION
const BUCKET = process.env.S3_BUCKET

const s3 = new S3Client({
  region: REGION,
  credentials:
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        }
      : undefined,
})

// Supabase service client for server-side inserts
const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

let supabase = null
if (supabaseUrl && supabaseServiceKey) {
  supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  })
} else {
  console.warn(
    '[beatsRoutes] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing – /beats/upload-beat will be disabled',
  )
}

// POST /beats/upload-beat
// Expects multipart/form-data with:
//  - file: audio file (required)
//  - user_id or producer_id: UUID of the uploader
//  - title, genre, bpm, description, price (optional metadata)
router.post('/upload-beat', upload.single('file'), async (req, res) => {
  try {
    if (!supabase) {
      return res
        .status(500)
        .json({ error: 'Supabase not configured on backend' })
    }
    if (!BUCKET || !REGION) {
      return res
        .status(500)
        .json({ error: 'S3 bucket or region not configured' })
    }

    const { user_id, producer_id, title, genre, bpm, description, price, producer } =
      req.body || {}
    const file = req.file

    if (!file) {
      return res.status(400).json({ error: 'No audio file uploaded.' })
    }

    // Upload audio bytes directly to S3
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')
    const key = `beats/${Date.now()}-${safeName}`

    const putCommand = new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
      // ACL intentionally omitted: bucket uses Object Ownership "Bucket owner enforced"
      // and does not allow ACLs. Public access should be handled via bucket policy.
    })

    await s3.send(putCommand)

    const audioUrl = `https://${BUCKET}.s3.${REGION}.amazonaws.com/${key}`

    // Insert beat row into Supabase "beats" table
    const { data, error } = await supabase
      .from('beats')
      .insert({
        user_id: user_id || producer_id || null,
        title: title || 'Untitled Beat',
        producer: producer || null,
        genre: genre || null,
        bpm: bpm ? Number(bpm) : null,
        description: description || null,
        price: price ? Number(price) : null,
        audio_url: audioUrl,
        cover_url: null,
      })
      .select('*')
      .single()

    if (error) {
      console.error('[beatsRoutes] Supabase insert error', error)
      return res.status(400).json({ error: error.message })
    }

    return res.json({
      message: 'Beat uploaded successfully',
      beat: data,
    })
  } catch (err) {
    console.error('[beatsRoutes] upload error', err)
    res.status(500).json({ error: 'Server error uploading beat' })
  }
})

export default router
