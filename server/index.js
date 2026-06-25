require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');
const { google } = require('googleapis');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '../public')));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// ══════════════════════════════════════════
//  AUTH MIDDLEWARE
// ══════════════════════════════════════════
// Only the email in OWNER_EMAIL can use the app.
// Webhooks (Twilio) and OAuth callbacks (Google) bypass auth.

const OWNER_EMAIL = (process.env.OWNER_EMAIL || '').toLowerCase().trim();

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) return res.status(401).json({ error: 'auth required' });

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return res.status(401).json({ error: 'invalid session' });

    // Whitelist: only the owner's email can use the app
    if (OWNER_EMAIL && user.email?.toLowerCase() !== OWNER_EMAIL) {
      console.warn(`[Auth] Blocked non-owner login attempt: ${user.email}`);
      return res.status(403).json({ error: 'not authorized' });
    }

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'auth failed' });
  }
}

// Public endpoints (no auth needed):
//   GET /         - serves the login/dashboard HTML
//   POST /webhook/whatsapp - Twilio webhook
//   GET /auth/google, /auth/google/callback - OAuth dance
//   GET /health
//   /icons/*, /manifest.json, /sw.js - static assets
//   GET /api/config - returns Supabase URL + anon key for frontend


// ══════════════════════════════════════════
//  GOOGLE OAUTH SETUP
// ══════════════════════════════════════════

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${process.env.APP_URL}/auth/google/callback`
);

const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events.readonly'
];

// Get the current valid token, refreshing if needed
async function getAuthedClient() {
  const { data: tokens } = await supabase.from('google_auth')
    .select('*').order('id', { ascending: false }).limit(1).single();

  if (!tokens) throw new Error('No Google auth — visit /auth/google to connect');

  oauth2Client.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: new Date(tokens.expires_at).getTime()
  });

  // If expired, refresh
  if (new Date(tokens.expires_at).getTime() <= Date.now() + 60000) {
    const { credentials } = await oauth2Client.refreshAccessToken();
    await supabase.from('google_auth').update({
      access_token: credentials.access_token,
      expires_at: new Date(credentials.expiry_date).toISOString()
    }).eq('id', tokens.id);
    oauth2Client.setCredentials(credentials);
  }

  return oauth2Client;
}

// Routes for OAuth dance
app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',  // critical: gets us a refresh_token
    prompt: 'consent',        // forces refresh_token even on re-auth
    scope: SCOPES
  });
  res.redirect(url);
});

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);

    // Wipe old tokens, save new ones
    await supabase.from('google_auth').delete().neq('id', 0);
    await supabase.from('google_auth').insert({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: new Date(tokens.expiry_date).toISOString(),
      scope: tokens.scope
    });

    res.send(`
      <html><body style="font-family:system-ui;background:#fff5f7;padding:60px;text-align:center;color:#2d1b2e">
      <h1 style="font-family:Georgia,serif;color:#e91e63">✨ Connected!</h1>
      <p>Google Calendar is now linked to your dashboard.</p>
      <p style="color:#a08599;font-size:14px;margin-top:20px">You can close this tab.</p>
      <a href="${process.env.APP_URL}" style="display:inline-block;margin-top:20px;padding:12px 24px;background:#e91e63;color:#fff;text-decoration:none;border-radius:8px">Go to dashboard ♡</a>
      </body></html>
    `);
  } catch (err) {
    console.error('[OAuth] Failed:', err);
    res.status(500).send('Auth failed: ' + err.message);
  }
});

app.get('/auth/google/status', async (req, res) => {
  const { data } = await supabase.from('google_auth').select('id').limit(1).single();
  res.json({ connected: !!data });
});

// ══════════════════════════════════════════
//  PUBLIC ENDPOINT: /api/config
//  Returns the Supabase URL + anon key for frontend auth.
//  These are PUBLIC by design — anon key is meant to be exposed.
// ══════════════════════════════════════════
app.get('/api/config', (req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  });
});

// Apply auth to all /api routes EXCEPT /api/config
app.use('/api', (req, res, next) => {
  if (req.path === '/config') return next();
  return requireAuth(req, res, next);
});

// ══════════════════════════════════════════
//  CALENDAR FETCHING
// ══════════════════════════════════════════

// Returns events from ALL the user's calendars within the time window
async function getCalendarEvents(timeMin, timeMax) {
  const auth = await getAuthedClient();
  const calendar = google.calendar({ version: 'v3', auth });

  // Get list of all calendars
  const calendarsRes = await calendar.calendarList.list();
  const calendars = calendarsRes.data.items.filter(c => !c.hidden && c.selected !== false);

  // Fetch events from each
  const allEvents = [];
  for (const cal of calendars) {
    try {
      const eventsRes = await calendar.events.list({
        calendarId: cal.id,
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 50
      });
      const events = (eventsRes.data.items || []).map(e => ({
        id: e.id,
        title: e.summary || '(no title)',
        start: e.start.dateTime || e.start.date,
        end: e.end?.dateTime || e.end?.date,
        allDay: !e.start.dateTime,
        location: e.location || null,
        meeting_link: e.hangoutLink || (e.conferenceData?.entryPoints?.[0]?.uri) || null,
        attendees: (e.attendees || []).map(a => a.email),
        calendar_name: cal.summary,
        calendar_color: cal.backgroundColor || '#e91e63',
        status: e.status
      })).filter(e => e.status !== 'cancelled');
      allEvents.push(...events);
    } catch (err) {
      console.warn(`[Cal] Failed to fetch ${cal.summary}:`, err.message);
    }
  }

  // Sort all events chronologically
  allEvents.sort((a, b) => new Date(a.start) - new Date(b.start));
  return allEvents;
}

// ══════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════

function todayUAE() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' }); }
function getISOWeek(date = new Date()) {
  const d = new Date(date); d.setHours(0,0,0,0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
}
function getQuarter(month) { return Math.ceil(month / 3); }

async function sendWA(body) {
  return twilioClient.messages.create({
    from: process.env.TWILIO_WHATSAPP_FROM,
    to: process.env.YOUR_WHATSAPP_NUMBER,
    body,
  });
}

async function getTodaysTasks() {
  const { data } = await supabase.from('tasks').select('*').eq('date', todayUAE()).order('created_at');
  return data || [];
}

// Format a meeting time in UAE timezone
function formatEventTime(eventStart, allDay) {
  if (allDay) return 'All day';
  const d = new Date(eventStart);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Dubai', hour12: false });
}

// ══════════════════════════════════════════
//  SCHEDULED MESSAGES
// ══════════════════════════════════════════

async function sendMorningCheckin() {
  try {
    const tasks = await getTodaysTasks();
    const pending = tasks.filter(t => !t.done);
    const today = todayUAE();

    const { data: leads } = await supabase.from('leads').select('*').eq('next_action_date', today).not('stage', 'in', '("closed_won","closed_lost")');
    const { data: clients } = await supabase.from('clients').select('*').eq('status', 'active').lte('next_followup', today);

    // Today's calendar events
    let todayEvents = [];
    try {
      const start = new Date(); start.setHours(0,0,0,0);
      const end = new Date(start); end.setHours(23,59,59,999);
      todayEvents = await getCalendarEvents(start, end);
    } catch (e) { console.log('[Cal] Skipping (not connected)'); }

    const day = new Date().toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'Asia/Dubai' });
    let body = `☀️ *Good morning, beautiful!*\n_${day}_\n\n`;

    if (todayEvents.length > 0) {
      body += `📅 *Today's calendar:*\n`;
      todayEvents.forEach(e => {
        body += `• ${formatEventTime(e.start, e.allDay)} — ${e.title}\n`;
      });
      body += `\n`;
    }

    if (pending.length === 0) body += `✅ No tasks yet today.\n`;
    else {
      body += `📋 *Today's priorities:*\n`;
      pending.forEach((t, i) => {
        const emoji = t.tag === 'pr' ? '🟣' : t.tag === 'urgent' ? '🔴' : '🟡';
        const rolledIndicator = (t.rollover_count || 0) >= 3 ? ' ⚠️' : (t.rollover_count > 0 ? ` _(rolled ${t.rollover_count}×)_` : '');
        body += `${emoji} *${i + 1}.* ${t.text}${rolledIndicator}\n`;
      });
      const stuckCount = pending.filter(t => (t.rollover_count || 0) >= 3).length;
      if (stuckCount > 0) {
        body += `\n⚠️ _${stuckCount} task${stuckCount===1?'':'s'} rolled 3+ days — decide today or delete_\n`;
      }
    }

    if (leads?.length > 0) {
      body += `\n🔄 *Pipeline actions:*\n`;
      leads.forEach(l => body += `• ${l.name}${l.company ? ` (${l.company})` : ''} — ${l.next_action || 'follow up'}\n`);
    }
    if (clients?.length > 0) {
      body += `\n💛 *Client check-ins due:*\n`;
      clients.forEach(c => body += `• ${c.name}${c.company ? ` (${c.company})` : ''}\n`);
    }

    body += `\n_Commands:_ \`done [#]\` · \`list\` · \`pipeline\` · \`clients\` · \`agenda\``;
    body += `\n🔗 ${process.env.APP_URL}`;

    await sendWA(body);
    await supabase.from('checkin_log').insert({ type: 'morning', tasks_snapshot: tasks });
    console.log('[Cron] Morning sent');
  } catch (err) { console.error('[Cron] Morning failed:', err.message); }
}

async function sendAfternoonCheckin() {
  try {
    const tasks = await getTodaysTasks();
    if (tasks.length === 0) return;
    const done = tasks.filter(t => t.done);
    const pending = tasks.filter(t => !t.done);
    const pct = Math.round((done.length / tasks.length) * 100);
    const bar = '█'.repeat(Math.round(pct/10)) + '░'.repeat(10 - Math.round(pct/10));
    let body = `🌤 *Afternoon check-in*\n\n${bar} ${pct}% done\n\n`;
    if (pending.length === 0) body += `🎉 You cleared everything!\n`;
    else {
      body += `*Still to do:*\n`;
      pending.forEach((t, i) => {
        const emoji = t.tag === 'urgent' ? '🔴' : t.tag === 'pr' ? '🟣' : '🟡';
        body += `${emoji} ${i + 1}. ${t.text}\n`;
      });
      body += `\n_Reply_ \`done [#]\` _to update_`;
    }
    await sendWA(body);
    console.log('[Cron] Afternoon sent');
  } catch (err) { console.error('[Cron] Afternoon failed:', err.message); }
}

// ── NEW: Evening calendar preview (7pm UAE = 15:00 UTC) ──
async function sendEveningCalendarPreview() {
  try {
    // Get tomorrow's events
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0,0,0,0);
    const endOfTomorrow = new Date(tomorrow);
    endOfTomorrow.setHours(23,59,59,999);

    const events = await getCalendarEvents(tomorrow, endOfTomorrow);

    const dayName = tomorrow.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'Asia/Dubai' });
    const dateStr = tomorrow.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'Asia/Dubai' });

    let body = `🌙 *Tomorrow's preview*\n_${dayName}, ${dateStr}_\n\n`;

    if (events.length === 0) {
      body += `Your calendar is clear ✨\n\nA gift of an open day — what would you do with it?`;
    } else {
      body += `📅 *${events.length} meeting${events.length===1?'':'s'} tomorrow:*\n\n`;
      events.forEach(e => {
        body += `*${formatEventTime(e.start, e.allDay)}* — ${e.title}\n`;
        if (e.location) body += `   📍 ${e.location}\n`;
        if (e.meeting_link) body += `   💻 Online\n`;
        if (e.attendees.length > 0) body += `   👥 ${e.attendees.length} attendee${e.attendees.length===1?'':'s'}\n`;
        body += `\n`;
      });
      // Add a gentle prep nudge
      const hasEarly = events.some(e => {
        const h = new Date(e.start).toLocaleString('en-GB', { hour:'2-digit', timeZone:'Asia/Dubai', hour12:false });
        return parseInt(h) < 10 && !e.allDay;
      });
      if (hasEarly) body += `_Early start tomorrow — get a good night ♡_`;
    }

    body += `\n\n🔗 ${process.env.APP_URL}?view=daily`;
    await sendWA(body);
    console.log('[Cron] Evening preview sent');
  } catch (err) {
    console.error('[Cron] Evening preview failed:', err.message);
    // If not connected, send a soft nudge
    if (err.message.includes('No Google auth')) {
      await sendWA(`🌙 *Evening reminder*\n\nYour Google Calendar isn't connected yet. Visit ${process.env.APP_URL}/auth/google to set it up — then I can preview your meetings each evening ♡`);
    }
  }
}

async function sendWeeklyReflection() {
  try {
    const now = new Date();
    const week = getISOWeek(now), year = now.getFullYear();
    const { data: existing } = await supabase.from('reflections').select('id, completed_at').eq('year', year).eq('week', week).single();
    if (existing?.completed_at) return;

    const body =
      `🪞 *Friday Reflection — Week ${week}*\n\n` +
      `Take 5 mins. Reply to each:\n\n` +
      `*Q1* 🏆 What did you win this week?\n` +
      `*Q2* 🌙 What slipped and why?\n` +
      `*Q3* 🎯 What's your #1 focus next week?\n` +
      `*Q4* 💕 How did you show up for yourself?\n` +
      `*Q5* ✨ Pipeline: what moved, what stalled?\n\n` +
      `_Reply_ \`reflect Q1 [your answer]\`\n` +
      `🔗 ${process.env.APP_URL}?view=reflection`;
    await sendWA(body);
    await supabase.from('reflections').upsert({ year, week, answers: {} }, { onConflict: 'year,week' });
    console.log('[Cron] Reflection sent');
  } catch (err) { console.error('[Cron] Reflection failed:', err.message); }
}

// ══════════════════════════════════════════
//  TASK ROLLOVER (incomplete tasks → tomorrow)
// ══════════════════════════════════════════
async function rolloverIncompleteTasks() {
  try {
    const today = todayUAE();
    // Find all incomplete tasks dated BEFORE today
    const { data: stragglers, error } = await supabase
      .from('tasks')
      .select('*')
      .lt('date', today)
      .eq('done', false);

    if (error) { console.error('[Rollover] fetch error:', error); return; }
    if (!stragglers || stragglers.length === 0) {
      console.log('[Rollover] No incomplete tasks to roll over');
      return;
    }

    // Bump each: new date = today, rollover_count + 1, original_date preserved
    const updates = stragglers.map(t => ({
      id: t.id,
      date: today,
      rollover_count: (t.rollover_count || 0) + 1,
      original_date: t.original_date || t.date,  // first rollover sets original_date
    }));

    for (const u of updates) {
      await supabase.from('tasks').update({
        date: u.date,
        rollover_count: u.rollover_count,
        original_date: u.original_date,
      }).eq('id', u.id);
    }

    console.log(`[Rollover] Moved ${stragglers.length} task${stragglers.length===1?'':'s'} to ${today}`);
  } catch (err) {
    console.error('[Rollover] failed:', err.message);
  }
}

cron.schedule(process.env.CRON_MORNING     || '0 6 * * *',  sendMorningCheckin, { timezone: 'UTC' });
cron.schedule(process.env.CRON_AFTERNOON   || '0 11 * * *', sendAfternoonCheckin, { timezone: 'UTC' });
cron.schedule(process.env.CRON_EVENING     || '0 15 * * *', sendEveningCalendarPreview, { timezone: 'UTC' });
cron.schedule(process.env.CRON_WEEKLY_REFLECTION || '0 12 * * 5', sendWeeklyReflection, { timezone: 'UTC' });
// 5 mins past UAE midnight = 20:05 UTC (UAE is UTC+4)
cron.schedule(process.env.CRON_ROLLOVER || '5 20 * * *', rolloverIncompleteTasks, { timezone: 'UTC' });
console.log('[Cron] Schedules: morning 10am, afternoon 3pm, evening 7pm, Friday reflection 4pm, rollover at midnight (UAE)');

// ══════════════════════════════════════════
//  WHATSAPP WEBHOOK (with new "agenda" command)
// ══════════════════════════════════════════

app.post('/webhook/whatsapp', async (req, res) => {
  const raw = (req.body.Body || '').trim();
  const msg = raw.toLowerCase();
  const from = req.body.From;
  if (from !== process.env.YOUR_WHATSAPP_NUMBER) return res.sendStatus(403);

  const twiml = new twilio.twiml.MessagingResponse();

  try {
    const tasks = await getTodaysTasks();
    const pending = tasks.filter(t => !t.done);

    const doneMatch = msg.match(/^done\s+(\d+)$/);
    if (doneMatch) {
      const idx = parseInt(doneMatch[1]) - 1;
      if (idx < 0 || idx >= pending.length) twiml.message(`⚠️ Task ${doneMatch[1]} not found.`);
      else {
        const task = pending[idx];
        await supabase.from('tasks').update({ done: true }).eq('id', task.id);
        const remaining = pending.length - 1;
        twiml.message(`✅ *Done:* "${task.text}"\n\n${remaining > 0 ? `${remaining} left.` : `🎉 Everything done!`}`);
      }
    }
    else if (msg === 'done all') {
      if (pending.length === 0) twiml.message(`✅ Already all done!`);
      else {
        await supabase.from('tasks').update({ done: true }).in('id', pending.map(t => t.id));
        twiml.message(`🎉 All ${pending.length} tasks complete!`);
      }
    }
    else if (msg.startsWith('add ')) {
      const text = raw.slice(4).trim();
      if (!text) twiml.message(`⚠️ Try: \`add Call Sana\``);
      else {
        await supabase.from('tasks').insert({ text, tag: 'personal', date: todayUAE() });
        twiml.message(`➕ Added: "${text}"`);
      }
    }
    else if (msg === 'list') {
      const fresh = await getTodaysTasks();
      if (!fresh.length) twiml.message(`No tasks today.`);
      else {
        let reply = `📋 *Today's tasks:*\n\n`;
        fresh.forEach((t, i) => { reply += `${t.done ? '✅' : '⬜'} ${i + 1}. ${t.text}\n`; });
        twiml.message(reply);
      }
    }
    // ── NEW: agenda — today's calendar ──
    else if (msg === 'agenda' || msg === 'calendar' || msg === 'today') {
      try {
        const start = new Date(); start.setHours(0,0,0,0);
        const end = new Date(start); end.setHours(23,59,59,999);
        const events = await getCalendarEvents(start, end);
        if (events.length === 0) twiml.message(`📅 No meetings today. Calendar's clear ✨`);
        else {
          let reply = `📅 *Today's calendar:*\n\n`;
          events.forEach(e => {
            reply += `*${formatEventTime(e.start, e.allDay)}* — ${e.title}\n`;
            if (e.location) reply += `   📍 ${e.location}\n`;
          });
          twiml.message(reply);
        }
      } catch (err) {
        twiml.message(`⚠️ Calendar not connected. Visit ${process.env.APP_URL}/auth/google to set it up.`);
      }
    }
    // ── NEW: tomorrow ──
    else if (msg === 'tomorrow') {
      try {
        const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate()+1); tomorrow.setHours(0,0,0,0);
        const end = new Date(tomorrow); end.setHours(23,59,59,999);
        const events = await getCalendarEvents(tomorrow, end);
        if (events.length === 0) twiml.message(`📅 Tomorrow is clear ✨`);
        else {
          let reply = `🌙 *Tomorrow:*\n\n`;
          events.forEach(e => {
            reply += `*${formatEventTime(e.start, e.allDay)}* — ${e.title}\n`;
            if (e.location) reply += `   📍 ${e.location}\n`;
          });
          twiml.message(reply);
        }
      } catch (err) {
        twiml.message(`⚠️ Calendar not connected.`);
      }
    }
    else if (msg === 'pipeline') {
      const { data: leads } = await supabase.from('leads').select('*').not('stage', 'in', '("closed_won","closed_lost")').order('value', { ascending: false });
      if (!leads?.length) twiml.message(`📊 No active leads.`);
      else {
        const stageEmoji = { lead:'🌸', contacted:'💌', discovery:'🔍', proposal:'📋', negotiation:'🤝' };
        const stageLabel = { lead:'Lead', contacted:'Contacted', discovery:'Discovery', proposal:'Proposal', negotiation:'Negotiation' };
        let reply = `📊 *Active Pipeline*\n\n`;
        const total = leads.reduce((s,l) => s + l.value, 0);
        leads.forEach(l => {
          reply += `${stageEmoji[l.stage]||'⚪'} *${l.name}* ${l.company?`(${l.company})`:''}\n   ${stageLabel[l.stage]||l.stage} · AED ${l.value.toLocaleString()}\n`;
          if (l.next_action) reply += `   → ${l.next_action}${l.next_action_date?` by ${l.next_action_date}`:''}\n`;
          reply += `\n`;
        });
        reply += `*Total: AED ${total.toLocaleString()}*`;
        twiml.message(reply);
      }
    }
    else if (msg === 'clients') {
      const today = todayUAE();
      const { data: clients } = await supabase.from('clients').select('*').eq('status', 'active').order('next_followup');
      if (!clients?.length) twiml.message(`👥 No active clients.`);
      else {
        let reply = `👥 *Active Clients*\n\n`;
        const totalMRR = clients.reduce((s,c) => s + (c.retainer_value || 0), 0);
        clients.forEach(c => {
          const overdue = c.next_followup && c.next_followup < today;
          reply += `${overdue ? '🌹' : '💕'} *${c.name}*${c.company?` (${c.company})`:''}\n`;
          if (c.retainer_value) reply += `   AED ${c.retainer_value.toLocaleString()}/mo\n`;
          if (c.next_followup) reply += `   Next: ${c.next_followup}${overdue?' ⚠️':''}\n`;
          reply += `\n`;
        });
        reply += `*MRR: AED ${totalMRR.toLocaleString()}*`;
        twiml.message(reply);
      }
    }
    else if (msg.startsWith('reflect ')) {
      const m = raw.match(/^reflect\s+Q(\d)\s+(.+)$/i);
      if (!m) twiml.message(`Format: \`reflect Q1 [answer]\``);
      else {
        const qNum = parseInt(m[1]); const answer = m[2].trim();
        const qMap = { 1:'wins', 2:'slipped', 3:'focus_next', 4:'showed_up', 5:'pipeline' };
        const key = qMap[qNum];
        if (!key) twiml.message(`⚠️ Use Q1-Q5`);
        else {
          const now = new Date(); const week = getISOWeek(now); const year = now.getFullYear();
          const { data: existing } = await supabase.from('reflections').select('*').eq('year', year).eq('week', week).single();
          const answers = { ...(existing?.answers || {}), [key]: answer };
          const allDone = Object.keys(answers).length >= 5;
          await supabase.from('reflections').upsert({ year, week, answers, ...(allDone ? { completed_at: new Date().toISOString() } : {}) }, { onConflict: 'year,week' });
          const remaining = [1,2,3,4,5].filter(n => !answers[qMap[n]]);
          twiml.message(allDone ? `✅ Saved! 🪞 Reflection complete for Week ${week}.` : `✅ Saved! Still to answer: ${remaining.map(n => `Q${n}`).join(', ')}`);
        }
      }
    }
    else if (msg === 'goals') {
      const now = new Date(); const month = now.getMonth() + 1, year = now.getFullYear(), quarter = getQuarter(month);
      const { data: m } = await supabase.from('monthly_goals').select('*').eq('year', year).eq('month', month);
      const { data: q } = await supabase.from('quarterly_goals').select('*').eq('year', year).eq('quarter', quarter);
      let reply = `🎯 *Your Goals*\n\n*This Month:*\n`;
      (m || []).forEach(g => { const pct = g.target_value ? Math.round((g.current_value/g.target_value)*100) : null; reply += `${g.done?'✅':'◻️'} ${g.title}${pct!==null?` (${pct}%)`:''}\n`; });
      reply += `\n*This Quarter (Q${quarter}):*\n`;
      (q || []).forEach(g => { const pct = g.target_value ? Math.round((g.current_value/g.target_value)*100) : null; reply += `${g.done?'✅':'◻️'} ${g.title}${pct!==null?` (${pct}%)`:''}\n`; });
      twiml.message(reply);
    }
    else {
      twiml.message(
        `👋 *Maggie's Dashboard*\n\n` +
        `*Tasks:* \`done [#]\` · \`done all\` · \`add [task]\` · \`list\`\n\n` +
        `*Calendar:* \`agenda\` · \`tomorrow\`\n\n` +
        `*Business:* \`pipeline\` · \`clients\` · \`goals\`\n\n` +
        `*Reflection:* \`reflect Q1 [answer]\`\n\n` +
        `🔗 ${process.env.APP_URL}`
      );
    }
  } catch (err) {
    console.error('[Webhook]:', err.message);
    twiml.message(`⚠️ Error. Check dashboard.`);
  }
  res.type('text/xml').send(twiml.toString());
});

// ══════════════════════════════════════════
//  CALENDAR API ROUTES
// ══════════════════════════════════════════

app.get('/api/calendar/today', async (req, res) => {
  try {
    const start = new Date(); start.setHours(0,0,0,0);
    const end = new Date(start); end.setHours(23,59,59,999);
    const events = await getCalendarEvents(start, end);
    res.json({ connected: true, events });
  } catch (err) {
    if (err.message.includes('No Google auth')) return res.json({ connected: false, events: [] });
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/calendar/week', async (req, res) => {
  try {
    const now = new Date();
    const dayOfWeek = (now.getDay() + 6) % 7;
    const monday = new Date(now); monday.setDate(now.getDate() - dayOfWeek); monday.setHours(0,0,0,0);
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6); sunday.setHours(23,59,59,999);
    const events = await getCalendarEvents(monday, sunday);
    res.json({ connected: true, events });
  } catch (err) {
    if (err.message.includes('No Google auth')) return res.json({ connected: false, events: [] });
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/calendar/upcoming', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const start = new Date();
    const end = new Date(start); end.setDate(end.getDate() + days);
    const events = await getCalendarEvents(start, end);
    res.json({ connected: true, events });
  } catch (err) {
    if (err.message.includes('No Google auth')) return res.json({ connected: false, events: [] });
    res.status(500).json({ error: err.message });
  }
});

// ── All existing API routes ──
app.get('/api/tasks', async (req, res) => {
  const date = req.query.date || todayUAE();
  const { data } = await supabase.from('tasks').select('*').eq('date', date).order('created_at');
  res.json(data || []);
});
app.get('/api/tasks/week', async (req, res) => {
  const now = new Date();
  const dayOfWeek = (now.getDay() + 6) % 7;
  const monday = new Date(now); monday.setDate(now.getDate() - dayOfWeek);
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  const from = monday.toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
  const to = sunday.toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
  const { data } = await supabase.from('tasks').select('*').gte('date', from).lte('date', to).order('date').order('created_at');
  res.json(data || []);
});
app.get('/api/tasks/month', async (req, res) => {
  const now = new Date();
  const year = req.query.year || now.getFullYear();
  const month = req.query.month || (now.getMonth() + 1);
  const from = `${year}-${String(month).padStart(2,'0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const to = `${year}-${String(month).padStart(2,'0')}-${lastDay}`;
  const { data } = await supabase.from('tasks').select('*').gte('date', from).lte('date', to).order('date');
  res.json(data || []);
});
app.post('/api/tasks', async (req, res) => {
  const { text, tag, date } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  const { data, error } = await supabase.from('tasks').insert({ text, tag: tag || 'personal', date: date || todayUAE() }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
app.patch('/api/tasks/:id', async (req, res) => {
  const { data } = await supabase.from('tasks').update(req.body).eq('id', req.params.id).select().single();
  res.json(data);
});
app.delete('/api/tasks/:id', async (req, res) => {
  await supabase.from('tasks').delete().eq('id', req.params.id); res.json({ ok: true });
});

app.get('/api/habits', async (req, res) => {
  const { data: habits } = await supabase.from('habits').select('*').order('id');
  // Load 90 days for streaks + heatmap
  const since = new Date(); since.setDate(since.getDate() - 90);
  const sinceStr = since.toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
  const { data: completions } = await supabase.from('habit_completions').select('*').gte('date', sinceStr);
  const today = todayUAE();
  res.json(habits.map(h => {
    const dates = (completions || []).filter(c => c.habit_id === h.id).map(c => c.date).sort();
    // Calculate current streak (consecutive days ending today or yesterday)
    let currentStreak = 0;
    const datesSet = new Set(dates);
    let checkDate = new Date();
    // If today not done, start from yesterday to allow grace
    if (!datesSet.has(today)) checkDate.setDate(checkDate.getDate() - 1);
    while (true) {
      const ds = checkDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
      if (datesSet.has(ds)) {
        currentStreak++;
        checkDate.setDate(checkDate.getDate() - 1);
      } else break;
    }
    // Longest streak in this 90-day window
    let longestStreak = 0, runStreak = 0, prevDate = null;
    dates.forEach(d => {
      if (prevDate) {
        const prev = new Date(prevDate); prev.setDate(prev.getDate() + 1);
        const expected = prev.toLocaleDateString('en-CA');
        if (d === expected) runStreak++; else runStreak = 1;
      } else runStreak = 1;
      if (runStreak > longestStreak) longestStreak = runStreak;
      prevDate = d;
    });
    // Last 7 days completion
    const last7 = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const ds = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
      last7.push({ date: ds, done: datesSet.has(ds) });
    }
    // This week / month counts
    const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - (weekStart.getDay() + 6) % 7);
    const weekStartStr = weekStart.toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
    const monthStartStr = today.slice(0, 7) + '-01';
    const thisWeek = dates.filter(d => d >= weekStartStr).length;
    const thisMonth = dates.filter(d => d >= monthStartStr).length;
    return {
      ...h,
      completions: dates,
      done_today: datesSet.has(today),
      current_streak: currentStreak,
      longest_streak: longestStreak,
      last_7_days: last7,
      this_week_count: thisWeek,
      this_month_count: thisMonth,
    };
  }));
});

// Toggle completion for a specific date (default today)
app.post('/api/habits/:id/toggle', async (req, res) => {
  const date = req.body?.date || todayUAE();
  const habitId = parseInt(req.params.id);
  const { data: existing } = await supabase.from('habit_completions').select('id').eq('habit_id', habitId).eq('date', date).single();
  if (existing) { await supabase.from('habit_completions').delete().eq('id', existing.id); res.json({ done: false, date }); }
  else { await supabase.from('habit_completions').insert({ habit_id: habitId, date }); res.json({ done: true, date }); }
});

// ══════════════════════════════════════════
//  PERFORMANCE COMPUTATION
// ══════════════════════════════════════════

// Compute stats for a given date range [from, to] (inclusive YYYY-MM-DD strings)
async function computePerformance(fromDate, toDate) {
  // Tasks
  const { data: tasks } = await supabase.from('tasks')
    .select('*').gte('date', fromDate).lte('date', toDate);
  const tasksTotal = (tasks || []).length;
  const tasksDone = (tasks || []).filter(t => t.done).length;
  const tasksByTag = {};
  (tasks || []).forEach(t => {
    const tag = t.tag || 'personal';
    tasksByTag[tag] = (tasksByTag[tag] || 0) + (t.done ? 1 : 0);
  });

  // Habits
  const { data: habits } = await supabase.from('habits').select('*');
  const { data: habitCompletions } = await supabase.from('habit_completions')
    .select('*').gte('date', fromDate).lte('date', toDate);
  const habitsCount = (habits || []).length;
  const habitTotal = (habitCompletions || []).length;
  const perfectDays = (() => {
    if (habitsCount === 0) return 0;
    const byDate = {};
    (habitCompletions || []).forEach(c => {
      byDate[c.date] = (byDate[c.date] || 0) + 1;
    });
    return Object.values(byDate).filter(c => c >= habitsCount).length;
  })();
  // Top habit
  const habitCounts = {};
  (habitCompletions || []).forEach(c => {
    habitCounts[c.habit_id] = (habitCounts[c.habit_id] || 0) + 1;
  });
  const topHabitId = Object.keys(habitCounts).sort((a,b) => habitCounts[b] - habitCounts[a])[0];
  const topHabit = (habits || []).find(h => h.id == topHabitId);

  // Pipeline / leads
  const { data: leads } = await supabase.from('leads').select('*');
  const leadsCreated = (leads || []).filter(l => l.created_at >= fromDate + 'T00:00:00' && l.created_at <= toDate + 'T23:59:59').length;
  const wonInPeriod = (leads || []).filter(l => l.stage === 'closed_won' && (l.updated_at || '') >= fromDate + 'T00:00:00' && (l.updated_at || '') <= toDate + 'T23:59:59');
  const lostInPeriod = (leads || []).filter(l => l.stage === 'closed_lost' && (l.updated_at || '') >= fromDate + 'T00:00:00' && (l.updated_at || '') <= toDate + 'T23:59:59');
  const wonValue = wonInPeriod.reduce((s, l) => s + (l.value || 0), 0);
  const activePipelineValue = (leads || []).filter(l => !['closed_won','closed_lost'].includes(l.stage)).reduce((s, l) => s + (l.value || 0), 0);

  // Clients
  const { data: clients } = await supabase.from('clients').select('*');
  const activeClients = (clients || []).filter(c => c.status === 'active').length;
  const totalMRR = (clients || []).filter(c => c.status === 'active').reduce((s, c) => s + (c.retainer_value || 0), 0);
  const { data: interactions } = await supabase.from('client_interactions')
    .select('*').gte('date', fromDate).lte('date', toDate);
  const clientContactsLogged = (interactions || []).length;

  // Meetings
  const { data: meetings } = await supabase.from('meetings').select('*')
    .gte('meeting_date', fromDate).lte('meeting_date', toDate);
  const meetingsTotal = (meetings || []).length;
  const meetingsCompleted = (meetings || []).filter(m => m.status === 'completed').length;
  const meetingsScheduled = (meetings || []).filter(m => m.status === 'scheduled').length;
  const meetingsCancelled = (meetings || []).filter(m => m.status === 'cancelled' || m.status === 'no_show').length;

  // Content
  const { data: contentIdeas } = await supabase.from('content_ideas').select('*');
  const contentCreatedThisPeriod = (contentIdeas || []).filter(c => c.created_at >= fromDate + 'T00:00:00' && c.created_at <= toDate + 'T23:59:59');
  const contentPublishedThisPeriod = (contentIdeas || []).filter(c => c.published_date >= fromDate && c.published_date <= toDate);
  const contentByBrand = { personal: 0, pr_circle: 0 };
  contentPublishedThisPeriod.forEach(c => { contentByBrand[c.brand] = (contentByBrand[c.brand] || 0) + 1; });

  // Reading
  const { data: books } = await supabase.from('books').select('*');
  const booksCompletedInPeriod = (books || []).filter(b => b.completed_at >= fromDate && b.completed_at <= toDate);
  const { data: reflections } = await supabase.from('book_reflections')
    .select('*').gte('created_at', fromDate + 'T00:00:00').lte('created_at', toDate + 'T23:59:59');
  const reflectionsLogged = (reflections || []).length;

  // Goals progress (currently-active monthly goals)
  const { data: monthlyGoals } = await supabase.from('monthly_goals').select('*');
  const goalsCompleted = (monthlyGoals || []).filter(g => g.done).length;
  const goalsTotal = (monthlyGoals || []).length;

  return {
    period: { from: fromDate, to: toDate },
    tasks: { total: tasksTotal, done: tasksDone, completion_rate: tasksTotal ? Math.round((tasksDone/tasksTotal)*100) : 0, by_tag: tasksByTag },
    habits: { total_completions: habitTotal, perfect_days: perfectDays, habits_count: habitsCount, top_habit: topHabit ? { name: topHabit.name, emoji: topHabit.emoji, count: habitCounts[topHabitId] } : null },
    pipeline: { leads_added: leadsCreated, won_count: wonInPeriod.length, lost_count: lostInPeriod.length, won_value: wonValue, active_value: activePipelineValue, won_deals: wonInPeriod.map(l => ({ name: l.name, value: l.value })) },
    clients: { active: activeClients, mrr: totalMRR, contacts_logged: clientContactsLogged },
    meetings: { total: meetingsTotal, completed: meetingsCompleted, scheduled: meetingsScheduled, cancelled_or_noshow: meetingsCancelled },
    content: { created: contentCreatedThisPeriod.length, published: contentPublishedThisPeriod.length, by_brand: contentByBrand },
    reading: { books_finished: booksCompletedInPeriod.length, books: booksCompletedInPeriod.map(b => ({ title: b.title, author: b.author })), reflections_logged: reflectionsLogged },
    goals: { completed: goalsCompleted, total: goalsTotal }
  };
}

// Build encouraging highlights from stats
function generateHighlights(stats, prev = null) {
  const wins = [];
  const focus = [];

  // Tasks
  if (stats.tasks.completion_rate >= 80) wins.push(`💪 ${stats.tasks.completion_rate}% of tasks done — exceptional follow-through`);
  else if (stats.tasks.completion_rate >= 60) wins.push(`✨ ${stats.tasks.done}/${stats.tasks.total} tasks done`);
  if (prev && stats.tasks.done > prev.tasks.done) {
    const diff = stats.tasks.done - prev.tasks.done;
    wins.push(`📈 ${diff} more tasks done than last period`);
  }

  // Habits
  if (stats.habits.perfect_days >= 3) wins.push(`🔥 ${stats.habits.perfect_days} perfect habit day${stats.habits.perfect_days===1?'':'s'} — consistency queen`);
  else if (stats.habits.perfect_days >= 1) wins.push(`✨ ${stats.habits.perfect_days} perfect day on habits`);
  if (stats.habits.top_habit) {
    wins.push(`${stats.habits.top_habit.emoji || '✨'} Most consistent: ${stats.habits.top_habit.name} (${stats.habits.top_habit.count}×)`);
  }

  // Pipeline
  if (stats.pipeline.won_count > 0) {
    wins.push(`🎉 ${stats.pipeline.won_count} deal${stats.pipeline.won_count===1?'':'s'} closed — AED ${stats.pipeline.won_value.toLocaleString()}`);
  }
  if (stats.pipeline.leads_added > 0) {
    wins.push(`🌸 ${stats.pipeline.leads_added} new lead${stats.pipeline.leads_added===1?'':'s'} added`);
  }

  // Meetings
  if (stats.meetings.completed >= 5) wins.push(`🤝 ${stats.meetings.completed} meetings completed — building real relationships`);
  else if (stats.meetings.completed > 0) wins.push(`☕ ${stats.meetings.completed} meeting${stats.meetings.completed===1?'':'s'} done`);

  // Content
  if (stats.content.published > 0) wins.push(`📝 ${stats.content.published} piece${stats.content.published===1?'':'s'} of content published`);
  if (stats.content.created > 0 && stats.content.published === 0) focus.push(`💡 ${stats.content.created} ideas captured — pick one to ship next`);

  // Reading
  if (stats.reading.books_finished > 0) {
    const titles = stats.reading.books.map(b => b.title).join(', ');
    wins.push(`📚 Finished: ${titles}`);
  }
  if (stats.reading.reflections_logged >= 5) wins.push(`📝 ${stats.reading.reflections_logged} reading reflections — your future self will thank you`);

  // Clients
  if (stats.clients.contacts_logged > 0) wins.push(`💕 Checked in with clients ${stats.clients.contacts_logged} time${stats.clients.contacts_logged===1?'':'s'}`);

  // Gentle focus areas
  if (stats.tasks.completion_rate < 40 && stats.tasks.total > 3) focus.push(`Tasks moving slowly — maybe simplify the list next period?`);
  if (stats.habits.perfect_days === 0 && stats.habits.habits_count > 0) focus.push(`No perfect habit days — consider trimming to fewer, more achievable habits`);
  if (stats.meetings.cancelled_or_noshow > stats.meetings.completed && stats.meetings.total > 2) focus.push(`More meetings missed than done — review the scheduling`);

  return { wins, focus };
}

// Helper: date helpers
function getWeekRange(d = new Date()) {
  const monday = new Date(d);
  const dow = (monday.getDay() + 6) % 7;
  monday.setDate(monday.getDate() - dow);
  monday.setHours(0,0,0,0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return {
    from: monday.toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' }),
    to: sunday.toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' }),
    label: `Week ${getISOWeek(monday)}, ${monday.getFullYear()}`
  };
}
function getMonthRange(d = new Date()) {
  const year = d.getFullYear();
  const month = d.getMonth();
  const first = new Date(year, month, 1);
  const last = new Date(year, month + 1, 0);
  const monthName = first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  return {
    from: first.toLocaleDateString('en-CA'),
    to: last.toLocaleDateString('en-CA'),
    label: monthName
  };
}
function getPrevWeekRange(d = new Date()) {
  const prev = new Date(d);
  prev.setDate(prev.getDate() - 7);
  return getWeekRange(prev);
}
function getPrevMonthRange(d = new Date()) {
  const prev = new Date(d.getFullYear(), d.getMonth() - 1, 15);
  return getMonthRange(prev);
}

// ══════════════════════════════════════════
//  PERFORMANCE API
// ══════════════════════════════════════════

// Live current week + month with comparisons to previous periods
app.get('/api/performance/live', async (req, res) => {
  try {
    const thisWeek = getWeekRange();
    const lastWeek = getPrevWeekRange();
    const thisMonth = getMonthRange();
    const lastMonth = getPrevMonthRange();

    const [tw, lw, tm, lm] = await Promise.all([
      computePerformance(thisWeek.from, thisWeek.to),
      computePerformance(lastWeek.from, lastWeek.to),
      computePerformance(thisMonth.from, thisMonth.to),
      computePerformance(lastMonth.from, lastMonth.to),
    ]);

    res.json({
      week: { label: thisWeek.label, range: thisWeek, stats: tw, previous: lw, highlights: generateHighlights(tw, lw) },
      month: { label: thisMonth.label, range: thisMonth, stats: tm, previous: lm, highlights: generateHighlights(tm, lm) }
    });
  } catch (err) {
    console.error('[Performance/live] error:', err);
    res.status(500).json({ error: err.message });
  }
});

// List saved snapshots
app.get('/api/performance/snapshots', async (req, res) => {
  const type = req.query.type;  // 'week' | 'month' | undefined
  let q = supabase.from('performance_snapshots').select('*').order('period_start', { ascending: false }).limit(50);
  if (type) q = q.eq('period_type', type);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// Generate a snapshot for a given week/month (manual or cron-triggered)
async function generateSnapshot(periodType, baseDate = new Date()) {
  const range = periodType === 'week' ? getWeekRange(baseDate) : getMonthRange(baseDate);
  const stats = await computePerformance(range.from, range.to);
  const prevRange = periodType === 'week' ? getPrevWeekRange(baseDate) : getPrevMonthRange(baseDate);
  const prevStats = await computePerformance(prevRange.from, prevRange.to);
  const highlights = generateHighlights(stats, prevStats);

  // Linked Friday reflection (if any) for week
  let reflection = null;
  if (periodType === 'week') {
    const week = getISOWeek(new Date(range.from + 'T00:00:00'));
    const year = new Date(range.from + 'T00:00:00').getFullYear();
    const { data: ref } = await supabase.from('reflections').select('*').eq('year', year).eq('week', week).single();
    if (ref?.answers) reflection = JSON.stringify(ref.answers);
  }

  const { data, error } = await supabase.from('performance_snapshots').upsert({
    period_type: periodType,
    period_start: range.from,
    period_end: range.to,
    period_label: range.label,
    stats,
    highlights,
    reflection
  }, { onConflict: 'period_type,period_start' }).select().single();

  if (error) console.error('[Snapshot] error:', error);
  return data;
}

app.post('/api/performance/snapshot', async (req, res) => {
  const type = req.body?.type || 'week';
  try {
    const snap = await generateSnapshot(type);
    res.json({ ok: true, snapshot: snap });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/performance/snapshots/:id', async (req, res) => {
  await supabase.from('performance_snapshots').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

// ── WHATSAPP WEEKLY SUMMARY ──
async function sendWeeklySummary() {
  try {
    const snap = await generateSnapshot('week');
    if (!snap) return;
    const s = snap.stats;
    const h = snap.highlights;

    let body = `✨ *Your Week in Review*\n_${snap.period_label}_\n\n`;

    // Header line
    if (s.tasks.completion_rate >= 70) body += `🌟 *What a week, beautiful!*\n\n`;
    else if (s.pipeline.won_count > 0) body += `🎉 *Wins this week!*\n\n`;
    else body += `💕 *Here's your week:*\n\n`;

    body += `📊 *The numbers*\n`;
    body += `• Tasks: ${s.tasks.done}/${s.tasks.total} (${s.tasks.completion_rate}%)\n`;
    body += `• Habit completions: ${s.habits.total_completions}${s.habits.perfect_days > 0 ? ` · ${s.habits.perfect_days} perfect day${s.habits.perfect_days===1?'':'s'}` : ''}\n`;
    if (s.meetings.total > 0) body += `• Meetings: ${s.meetings.completed}/${s.meetings.total} completed\n`;
    if (s.pipeline.leads_added > 0 || s.pipeline.won_count > 0) {
      body += `• Pipeline: ${s.pipeline.leads_added} new · ${s.pipeline.won_count} won (AED ${s.pipeline.won_value.toLocaleString()})\n`;
    }
    if (s.content.published > 0) body += `• Content published: ${s.content.published}\n`;
    if (s.reading.books_finished > 0) body += `• Books finished: ${s.reading.books_finished}\n`;

    if (h.wins.length > 0) {
      body += `\n💖 *Wins to celebrate*\n`;
      h.wins.slice(0, 5).forEach(w => body += `${w}\n`);
    }

    if (h.focus.length > 0) {
      body += `\n🌸 *Gentle focus for next week*\n`;
      h.focus.slice(0, 2).forEach(f => body += `• ${f}\n`);
    }

    body += `\n🔗 ${process.env.APP_URL}?view=performance`;

    await sendWA(body);
    console.log('[Cron] Weekly summary sent + snapshot saved');
  } catch (err) {
    console.error('[Cron] Weekly summary failed:', err.message);
  }
}

async function sendMonthlySummary() {
  try {
    // Generate snapshot for previous month (since this runs on the 1st)
    const lastMonth = new Date();
    lastMonth.setDate(0); // go to last day of previous month
    const snap = await generateSnapshot('month', lastMonth);
    if (!snap) return;
    const s = snap.stats;
    const h = snap.highlights;

    let body = `🌙 *Your Month in Review*\n_${snap.period_label}_\n\n`;
    body += `💕 *Here's the month that was:*\n\n`;

    body += `📊 *The big picture*\n`;
    body += `• Tasks completed: ${s.tasks.done} (${s.tasks.completion_rate}%)\n`;
    body += `• Habit completions: ${s.habits.total_completions} · ${s.habits.perfect_days} perfect days\n`;
    body += `• Meetings: ${s.meetings.completed} completed\n`;
    if (s.pipeline.won_count > 0 || s.pipeline.leads_added > 0) {
      body += `• Pipeline: ${s.pipeline.leads_added} added · ${s.pipeline.won_count} won (AED ${s.pipeline.won_value.toLocaleString()})\n`;
    }
    body += `• Active MRR: AED ${s.clients.mrr.toLocaleString()}\n`;
    if (s.content.published > 0) body += `• Content shipped: ${s.content.published}\n`;
    if (s.reading.books_finished > 0) body += `• Books finished: ${s.reading.books_finished}\n`;

    if (h.wins.length > 0) {
      body += `\n✨ *Highlights*\n`;
      h.wins.slice(0, 6).forEach(w => body += `${w}\n`);
    }

    body += `\n🔗 ${process.env.APP_URL}?view=performance`;
    await sendWA(body);
    console.log('[Cron] Monthly summary sent + snapshot saved');
  } catch (err) {
    console.error('[Cron] Monthly summary failed:', err.message);
  }
}

// Friday 8pm UAE = 16:00 UTC (we already have Friday 12 UTC for reflection)
cron.schedule(process.env.CRON_WEEKLY_SUMMARY || '0 16 * * 5', sendWeeklySummary, { timezone: 'UTC' });
// 1st of month at 10am UAE = 06:00 UTC
cron.schedule(process.env.CRON_MONTHLY_SUMMARY || '0 6 1 * *', sendMonthlySummary, { timezone: 'UTC' });
console.log('[Cron] Performance summaries scheduled (Fri 8pm + 1st of month 10am UAE)');

// Add new habit
app.post('/api/habits', async (req, res) => {
  const { name, emoji, color, target_per_week } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const { data, error } = await supabase.from('habits').insert({
    name, emoji: emoji || '✨', color: color || '#e91e63',
    target_per_week: target_per_week || 7
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Update habit
app.patch('/api/habits/:id', async (req, res) => {
  const { data, error } = await supabase.from('habits').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Delete habit
app.delete('/api/habits/:id', async (req, res) => {
  await supabase.from('habit_completions').delete().eq('habit_id', req.params.id);
  await supabase.from('habits').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

app.get('/api/leads', async (req, res) => {
  const { data } = await supabase.from('leads').select('*').order('created_at', { ascending: false });
  res.json(data || []);
});
app.post('/api/leads', async (req, res) => {
  const b = req.body;
  if (!b.name) return res.status(400).json({ error: 'name required' });
  const { data, error } = await supabase.from('leads').insert({
    name: b.name, company: b.company, value: b.value || 0,
    stage: b.stage || 'lead', source: b.source || 'other',
    notes: b.notes, next_action: b.next_action, next_action_date: b.next_action_date,
    phone: b.phone, email: b.email, linkedin: b.linkedin,
    followup: b.followup || 'week', status: 'lead'
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
app.patch('/api/leads/:id', async (req, res) => {
  const { data } = await supabase.from('leads').update(req.body).eq('id', req.params.id).select().single();
  res.json(data);
});
app.delete('/api/leads/:id', async (req, res) => { await supabase.from('leads').delete().eq('id', req.params.id); res.json({ ok: true }); });

app.get('/api/clients', async (req, res) => {
  const { data } = await supabase.from('clients').select('*').order('next_followup', { nullsFirst: false });
  res.json(data || []);
});
app.post('/api/clients', async (req, res) => {
  const b = req.body;
  if (!b.name) return res.status(400).json({ error: 'name required' });
  const { data, error } = await supabase.from('clients').insert({
    name: b.name, company: b.company, project: b.project,
    email: b.email, phone: b.phone, linkedin: b.linkedin,
    retainer_value: b.retainer_value || 0, start_date: b.start_date,
    status: b.status || 'active', last_contact: b.last_contact,
    next_followup: b.next_followup, followup_frequency_days: b.followup_frequency_days || 14,
    notes: b.notes
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
app.patch('/api/clients/:id', async (req, res) => {
  const { data } = await supabase.from('clients').update(req.body).eq('id', req.params.id).select().single();
  res.json(data);
});
app.delete('/api/clients/:id', async (req, res) => { await supabase.from('clients').delete().eq('id', req.params.id); res.json({ ok: true }); });
app.post('/api/clients/:id/contact', async (req, res) => {
  const { type, summary } = req.body;
  const clientId = parseInt(req.params.id);
  const today = todayUAE();
  const { data: client } = await supabase.from('clients').select('*').eq('id', clientId).single();
  if (!client) return res.status(404).json({ error: 'not found' });
  await supabase.from('client_interactions').insert({ client_id: clientId, type: type || 'note', summary: summary || 'Contact logged', date: today });
  const nextDate = new Date(); nextDate.setDate(nextDate.getDate() + (client.followup_frequency_days || 14));
  const nextStr = nextDate.toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
  const { data: updated } = await supabase.from('clients').update({ last_contact: today, next_followup: nextStr }).eq('id', clientId).select().single();
  res.json(updated);
});
app.get('/api/clients/:id/interactions', async (req, res) => {
  const { data } = await supabase.from('client_interactions').select('*').eq('client_id', req.params.id).order('date', { ascending: false });
  res.json(data || []);
});

app.get('/api/goals/monthly', async (req, res) => {
  const now = new Date();
  const year = parseInt(req.query.year) || now.getFullYear();
  const month = parseInt(req.query.month) || (now.getMonth() + 1);
  const { data } = await supabase.from('monthly_goals').select('*').eq('year', year).eq('month', month).order('created_at');
  res.json(data || []);
});
app.post('/api/goals/monthly', async (req, res) => {
  const now = new Date();
  const { title, target_value, unit, category, year, month } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  const { data } = await supabase.from('monthly_goals').insert({ title, target_value, unit, category: category || 'general', year: year || now.getFullYear(), month: month || (now.getMonth() + 1) }).select().single();
  res.json(data);
});
app.patch('/api/goals/monthly/:id', async (req, res) => {
  const { data } = await supabase.from('monthly_goals').update(req.body).eq('id', req.params.id).select().single();
  res.json(data);
});
app.delete('/api/goals/monthly/:id', async (req, res) => { await supabase.from('monthly_goals').delete().eq('id', req.params.id); res.json({ ok: true }); });

app.get('/api/goals/quarterly', async (req, res) => {
  const now = new Date();
  const year = parseInt(req.query.year) || now.getFullYear();
  const quarter = parseInt(req.query.quarter) || getQuarter(now.getMonth() + 1);
  const { data } = await supabase.from('quarterly_goals').select('*').eq('year', year).eq('quarter', quarter).order('created_at');
  res.json(data || []);
});
app.post('/api/goals/quarterly', async (req, res) => {
  const now = new Date();
  const { title, target_value, unit, category, year, quarter } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  const { data } = await supabase.from('quarterly_goals').insert({ title, target_value, unit, category: category || 'general', year: year || now.getFullYear(), quarter: quarter || getQuarter(now.getMonth() + 1) }).select().single();
  res.json(data);
});
app.patch('/api/goals/quarterly/:id', async (req, res) => {
  const { data } = await supabase.from('quarterly_goals').update(req.body).eq('id', req.params.id).select().single();
  res.json(data);
});
app.delete('/api/goals/quarterly/:id', async (req, res) => { await supabase.from('quarterly_goals').delete().eq('id', req.params.id); res.json({ ok: true }); });

app.get('/api/reflections', async (req, res) => {
  const now = new Date();
  const year = parseInt(req.query.year) || now.getFullYear();
  const week = parseInt(req.query.week) || getISOWeek(now);
  const { data, error } = await supabase.from('reflections').select('*').eq('year', year).eq('week', week).single();
  if (error && error.code !== 'PGRST116') return res.status(500).json({ error: error.message });
  res.json(data || { year, week, answers: {} });
});
app.get('/api/reflections/recent', async (req, res) => {
  const { data } = await supabase.from('reflections').select('*').order('year', { ascending: false }).order('week', { ascending: false }).limit(12);
  res.json(data || []);
});
app.post('/api/reflections', async (req, res) => {
  const now = new Date();
  const { year, week, answers } = req.body;
  const y = year || now.getFullYear(), w = week || getISOWeek(now);
  const allDone = answers && Object.keys(answers).length >= 5;
  const { data } = await supabase.from('reflections').upsert({ year: y, week: w, answers, ...(allDone ? { completed_at: new Date().toISOString() } : {}) }, { onConflict: 'year,week' }).select().single();
  res.json(data);
});

// ══════════════════════════════════════════
//  CONTENT IDEAS API
// ══════════════════════════════════════════

app.get('/api/content', async (req, res) => {
  const { brand, status } = req.query;
  let query = supabase.from('content_ideas').select('*');
  if (brand) query = query.eq('brand', brand);
  if (status) query = query.eq('status', status);
  const { data, error } = await query.order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/content', async (req, res) => {
  const b = req.body;
  if (!b.title) return res.status(400).json({ error: 'title required' });
  const { data, error } = await supabase.from('content_ideas').insert({
    title: b.title,
    brand: b.brand || 'personal',
    platform: b.platform || 'linkedin',
    content_type: b.content_type || 'text',
    status: b.status || 'idea',
    hook: b.hook,
    notes: b.notes,
    scheduled_date: b.scheduled_date,
    published_date: b.published_date,
    link: b.link
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/content/:id', async (req, res) => {
  const { data, error } = await supabase.from('content_ideas').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/content/:id', async (req, res) => {
  await supabase.from('content_ideas').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

// ══════════════════════════════════════════
//  BOOKS API
// ══════════════════════════════════════════

app.get('/api/books', async (req, res) => {
  const status = req.query.status;
  let query = supabase.from('books').select('*');
  if (status) query = query.eq('status', status);
  const { data, error } = await query.order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// Search Google Books (free, no auth needed)
app.get('/api/books/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'query required' });
  try {
    const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=8&printType=books`;
    const fetchRes = await fetch(url);
    const data = await fetchRes.json();
    const results = (data.items || []).map(item => ({
      google_books_id: item.id,
      title: item.volumeInfo.title,
      author: (item.volumeInfo.authors || []).join(', '),
      cover_url: (item.volumeInfo.imageLinks?.thumbnail || '').replace('http://', 'https://'),
      total_pages: item.volumeInfo.pageCount || null,
      description: item.volumeInfo.description?.slice(0, 200) || ''
    }));
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/books', async (req, res) => {
  const b = req.body;
  if (!b.title) return res.status(400).json({ error: 'title required' });
  const { data, error } = await supabase.from('books').insert({
    title: b.title, author: b.author, cover_url: b.cover_url,
    total_pages: b.total_pages, current_page: b.current_page || 0,
    current_chapter: b.current_chapter, status: b.status || 'reading',
    rating: b.rating, google_books_id: b.google_books_id
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/books/:id', async (req, res) => {
  const body = { ...req.body };
  // If marking complete, set completed_at
  if (body.status === 'completed' && !body.completed_at) {
    body.completed_at = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
  }
  const { data, error } = await supabase.from('books').update(body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/books/:id', async (req, res) => {
  await supabase.from('books').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

// ── Book reflections ──
app.get('/api/books/:id/reflections', async (req, res) => {
  const { data, error } = await supabase.from('book_reflections')
    .select('*').eq('book_id', req.params.id).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/books/:id/reflections', async (req, res) => {
  const { chapter, page_at_time, prompt, answer } = req.body;
  if (!prompt || !answer) return res.status(400).json({ error: 'prompt and answer required' });
  const { data, error } = await supabase.from('book_reflections').insert({
    book_id: parseInt(req.params.id),
    chapter, page_at_time, prompt, answer
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ══════════════════════════════════════════
//  MEETINGS API
// ══════════════════════════════════════════

app.get('/api/meetings', async (req, res) => {
  const { status, lead_id, client_id } = req.query;
  let query = supabase.from('meetings').select('*');
  if (status) query = query.eq('status', status);
  if (lead_id) query = query.eq('lead_id', lead_id);
  if (client_id) query = query.eq('client_id', client_id);
  const { data, error } = await query.order('meeting_date', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/meetings', async (req, res) => {
  const b = req.body;
  if (!b.contact_name || !b.meeting_date) return res.status(400).json({ error: 'contact_name and meeting_date required' });
  const { data, error } = await supabase.from('meetings').insert({
    lead_id: b.lead_id || null,
    client_id: b.client_id || null,
    contact_name: b.contact_name,
    company: b.company,
    meeting_date: b.meeting_date,
    meeting_time: b.meeting_time,
    purpose: b.purpose,
    location: b.location,
    status: b.status || 'scheduled',
    discussion_notes: b.discussion_notes,
    followup_action: b.followup_action,
    followup_date: b.followup_date
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/meetings/:id', async (req, res) => {
  const body = { ...req.body };
  // Auto-update linked lead's next_action when meeting is completed with followup
  const { data, error } = await supabase.from('meetings').update(body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  // If meeting completed with a followup, push that to the linked lead
  if (body.status === 'completed' && body.followup_action && data.lead_id) {
    await supabase.from('leads').update({
      next_action: body.followup_action,
      next_action_date: body.followup_date
    }).eq('id', data.lead_id);
  }
  res.json(data);
});

app.delete('/api/meetings/:id', async (req, res) => {
  await supabase.from('meetings').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

// ══════════════════════════════════════════
//  BENCH (FREELANCERS) API
// ══════════════════════════════════════════

app.get('/api/bench', async (req, res) => {
  const status = req.query.status;
  let q = supabase.from('bench').select('*');
  if (status) q = q.eq('status', status);
  const { data, error } = await q.order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.post('/api/bench', async (req, res) => {
  const b = req.body;
  if (!b.name) return res.status(400).json({ error: 'name required' });
  const { data, error } = await supabase.from('bench').insert({
    name: b.name,
    job_title: b.job_title || null,
    linkedin: b.linkedin || null,
    email: b.email || null,
    phone: b.phone || null,
    rate: b.rate || null,
    currency: b.currency || 'AED',
    skills: b.skills || null,
    notes: b.notes || null,
    status: b.status || 'available',
    rating: b.rating || null,
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/bench/:id', async (req, res) => {
  const { data, error } = await supabase.from('bench').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/bench/:id', async (req, res) => {
  await supabase.from('bench').delete().eq('id', req.params.id);
  res.json({ ok: true });
});

app.post('/api/trigger/morning',     async (req, res) => { await sendMorningCheckin(); res.json({ ok: true }); });
app.post('/api/trigger/rollover',    async (req, res) => { await rolloverIncompleteTasks(); res.json({ ok: true }); });

// Roll over a single task to tomorrow (manual)
app.post('/api/tasks/:id/rollover', async (req, res) => {
  const { data: task } = await supabase.from('tasks').select('*').eq('id', req.params.id).single();
  if (!task) return res.status(404).json({ error: 'task not found' });

  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });

  const { data, error } = await supabase.from('tasks').update({
    date: tomorrowStr,
    rollover_count: (task.rollover_count || 0) + 1,
    original_date: task.original_date || task.date,
  }).eq('id', req.params.id).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
app.post('/api/trigger/afternoon',   async (req, res) => { await sendAfternoonCheckin(); res.json({ ok: true }); });
app.post('/api/trigger/evening',     async (req, res) => { await sendEveningCalendarPreview(); res.json({ ok: true }); });
app.post('/api/trigger/reflection',  async (req, res) => { await sendWeeklyReflection(); res.json({ ok: true }); });

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Server] Running on port ${PORT}`));
