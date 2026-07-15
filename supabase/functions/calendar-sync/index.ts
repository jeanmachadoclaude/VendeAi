// calendar-sync - sincroniza Google Agenda ↔ calendar_events do CRM.
// Import: eventos do Google (7 dias atrás → 60 dias à frente) viram calendar_events,
//         com dedupe pelo google_event_id.
// Export: eventos futuros do CRM ainda sem google_event_id são criados no Google.
// Usa a mesma conexão Google do Gmail (integrations type='gmail', escopo calendar).
// Frontend: sb.functions.invoke('calendar-sync') → { imported, exported }

import { admin, cors, json, requireUser, reportError } from '../_shared/base.ts'
import { getGmailConfig, gmailAccessToken } from '../_shared/gmail.ts'

const CAL_API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'

interface GEvent {
  id: string
  status?: string
  summary?: string
  description?: string
  location?: string
  hangoutLink?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
}

const gWhen = (w?: { dateTime?: string; date?: string }) => w?.dateTime || (w?.date ? `${w.date}T00:00:00` : null)

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const { user, orgId } = await requireUser(req)
    const { config, integrationId } = await getGmailConfig(orgId)
    const token = await gmailAccessToken(config, integrationId)
    const gHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    const db = admin()

    const timeMin = new Date(Date.now() - 7 * 86400000).toISOString()
    const timeMax = new Date(Date.now() + 60 * 86400000).toISOString()

    // ── 1. IMPORT: Google → CRM ──────────────────────────────
    const listUrl = `${CAL_API}?singleEvents=true&orderBy=startTime&maxResults=250` +
      `&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}`
    const listRes = await fetch(listUrl, { headers: gHeaders })
    if (!listRes.ok) {
      console.error('Google Calendar list error:', await listRes.text())
      return json({ error: 'O Google Agenda recusou a leitura. Reconecte a conta Google nas Configurações.' }, 502)
    }
    const gEvents = ((await listRes.json()).items || []) as GEvent[]

    const { data: existing } = await db.from('calendar_events')
      .select('id, google_event_id').eq('org_id', orgId).not('google_event_id', 'is', null)
    const byGoogleId = new Map((existing || []).map(e => [e.google_event_id as string, e.id as string]))

    let imported = 0
    for (const ev of gEvents) {
      if (!ev.id || ev.status === 'cancelled') continue
      const startAt = gWhen(ev.start)
      if (!startAt) continue
      const row = {
        title: ev.summary || '(sem título)',
        description: ev.description || null,
        location: ev.location || null,
        meet_link: ev.hangoutLink || null,
        start_at: startAt,
        end_at: gWhen(ev.end),
        all_day: !!ev.start?.date,
      }
      const existingId = byGoogleId.get(ev.id)
      if (existingId) {
        await db.from('calendar_events').update(row).eq('id', existingId)
      } else {
        await db.from('calendar_events').insert({
          ...row, org_id: orgId, owner_id: user.id, type: 'meeting',
          google_event_id: ev.id, status: 'scheduled',
        })
        imported++
      }
    }

    // ── 2. EXPORT: CRM → Google ──────────────────────────────
    const { data: toExport } = await db.from('calendar_events')
      .select('id, title, description, location, start_at, end_at, all_day')
      .eq('org_id', orgId).is('google_event_id', null)
      .eq('status', 'scheduled').gte('start_at', new Date().toISOString()).limit(100)

    let exported = 0
    for (const ev of toExport || []) {
      const endAt = ev.end_at || new Date(new Date(ev.start_at).getTime() + 3600000).toISOString()
      const body = ev.all_day
        ? {
            summary: ev.title, description: ev.description || undefined, location: ev.location || undefined,
            start: { date: ev.start_at.slice(0, 10) }, end: { date: endAt.slice(0, 10) },
          }
        : {
            summary: ev.title, description: ev.description || undefined, location: ev.location || undefined,
            start: { dateTime: new Date(ev.start_at).toISOString() },
            end: { dateTime: new Date(endAt).toISOString() },
          }
      const createRes = await fetch(CAL_API, { method: 'POST', headers: gHeaders, body: JSON.stringify(body) })
      if (!createRes.ok) { console.error('Google Calendar insert error:', await createRes.text()); continue }
      const created = await createRes.json() as { id: string }
      await db.from('calendar_events').update({ google_event_id: created.id }).eq('id', ev.id)
      exported++
    }

    await db.from('integrations').update({ last_sync: new Date().toISOString() }).eq('id', integrationId)

    return json({ ok: true, imported, exported, total_google: gEvents.length })
  } catch (e) {
    if (e instanceof Response) return e
    console.error(e)
    await reportError(e, 'calendar-sync')
    return json({ error: String(e?.message || e) }, 500)
  }
})
