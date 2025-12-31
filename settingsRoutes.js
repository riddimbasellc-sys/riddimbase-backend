import express from 'express'
import { createClient } from '@supabase/supabase-js'

const router = express.Router()

const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

let supabase = null
if (supabaseUrl && supabaseServiceKey) {
  supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  })
} else {
  console.warn(
    '[settingsRoutes] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY; design settings will not be persisted',
  )
}

const SETTINGS_ROW_ID = 'global'

// In-memory settings; seeded with defaults matching the frontend design system.
let settings = {
  theme: {
    primaryColor: '#ef4444',
    secondaryColor: '#0f172a',
    accentColor: '#f97316',
    backgroundColor: '#020617',
    surfaceColor: '#020617',
    fontFamily:
      'Inter, system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
  },
  announcement: {
    enabled: true,
    text: 'Welcome to RiddimBase – the home of Caribbean beats.',
    backgroundColor: '#111827',
    textColor: '#e5e7eb',
  },
  navigation: {
    links: [
      { id: 'home', label: 'Home', href: '/', visible: true, external: false },
      { id: 'beats', label: 'Beats', href: '/beats', visible: true, external: false },
      {
        id: 'producers',
        label: 'Producers',
        href: '/producers',
        visible: true,
        external: false,
      },
      { id: 'jobs', label: 'Jobs', href: '/jobs', visible: true, external: false },
    ],
  },
  hero: {
    banners: [
      {
        id: 'main',
        title: 'Your first hit starts here.',
        subtitle: 'Browse curated Caribbean beats, soundkits and services.',
        backgroundUrl: '',
        ctaText: 'Explore beats',
        ctaHref: '/beats',
        active: true,
      },
    ],
    // Used when no hero media background is configured.
    backgroundColor: '#050505',
  },
  advancedCss: '',
}
async function loadSettingsFromDb() {
  if (!supabase) return null
  try {
    const { data, error } = await supabase
      .from('site_settings')
      .select('settings')
      .eq('id', SETTINGS_ROW_ID)
      .maybeSingle()
    if (error) {
      console.error('[settingsRoutes] loadSettingsFromDb error', error)
      return null
    }
    return data?.settings || null
  } catch (err) {
    console.error('[settingsRoutes] loadSettingsFromDb unexpected error', err)
    return null
  }
}

async function saveSettingsToDb(nextSettings) {
  if (!supabase) return
  try {
    const { error } = await supabase
      .from('site_settings')
      .upsert(
        {
          id: SETTINGS_ROW_ID,
          settings: nextSettings,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'id' },
      )
    if (error) {
      console.error('[settingsRoutes] saveSettingsToDb error', error)
    }
  } catch (err) {
    console.error('[settingsRoutes] saveSettingsToDb unexpected error', err)
  }
}

// GET /api/settings
router.get('/api/settings', async (req, res) => {
  try {
    const dbSettings = await loadSettingsFromDb()
    if (dbSettings) {
      settings = {
        ...settings,
        ...dbSettings,
        theme: { ...settings.theme, ...(dbSettings.theme || {}) },
        announcement: {
          ...settings.announcement,
          ...(dbSettings.announcement || {}),
        },
        navigation: {
          ...settings.navigation,
          ...(dbSettings.navigation || {}),
        },
        hero: { ...settings.hero, ...(dbSettings.hero || {}) },
      }
    }
    res.json(settings)
  } catch (err) {
    console.error('[settingsRoutes] GET /api/settings error', err)
    res.json(settings)
  }
})

// PUT /api/settings
router.put('/api/settings', async (req, res) => {
  const body = req.body || {}
  settings = {
    ...settings,
    ...body,
    theme: { ...settings.theme, ...(body.theme || {}) },
    announcement: { ...settings.announcement, ...(body.announcement || {}) },
    navigation: { ...settings.navigation, ...(body.navigation || {}) },
    hero: { ...settings.hero, ...(body.hero || {}) },
  }

  try {
    await saveSettingsToDb(settings)
  } catch (err) {
    // Persistence failures are non-fatal; log and continue.
    console.error('[settingsRoutes] PUT /api/settings persistence error', err)
  }

  res.json(settings)
})

export default router

