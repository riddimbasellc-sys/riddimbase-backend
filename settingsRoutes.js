import express from 'express'

const router = express.Router()

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
  },
  advancedCss: '',
}

// GET /api/settings
router.get('/api/settings', (req, res) => {
  res.json(settings)
})

// PUT /api/settings
router.put('/api/settings', (req, res) => {
  const body = req.body || {}
  settings = {
    ...settings,
    ...body,
    theme: { ...settings.theme, ...(body.theme || {}) },
    announcement: { ...settings.announcement, ...(body.announcement || {}) },
    navigation: { ...settings.navigation, ...(body.navigation || {}) },
    hero: { ...settings.hero, ...(body.hero || {}) },
  }
  res.json(settings)
})

export default router

