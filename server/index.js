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
        body += `${emoji} *${i + 1}.* ${t.text}\n`;
      });
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

cron.schedule(process.env.CRON_MORNING     || '0 6 * * *',  sendMorningCheckin, { timezone: 'UTC' });
cron.schedule(process.env.CRON_AFTERNOON   || '0 11 * * *', sendAfternoonCheckin, { timezone: 'UTC' });
cron.schedule(process.env.CRON_EVENING     || '0 15 * * *', sendEveningCalendarPreview, { timezone: 'UTC' });
cron.schedule(process.env.CRON_WEEKLY_REFLECTION || '0 12 * * 5', sendWeeklyReflection, { timezone: 'UTC' });
console.log('[Cron] Schedules: morning 10am, afternoon 3pm, evening 7pm, Friday reflection 4pm (UAE)');

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
  const since = new Date(); since.setDate(since.getDate() - 30);
  const sinceStr = since.toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
  const { data: completions } = await supabase.from('habit_completions').select('*').gte('date', sinceStr);
  res.json(habits.map(h => ({ ...h, completions: (completions || []).filter(c => c.habit_id === h.id).map(c => c.date) })));
});
app.post('/api/habits/:id/toggle', async (req, res) => {
  const date = todayUAE();
  const habitId = parseInt(req.params.id);
  const { data: existing } = await supabase.from('habit_completions').select('id').eq('habit_id', habitId).eq('date', date).single();
  if (existing) { await supabase.from('habit_completions').delete().eq('id', existing.id); res.json({ done: false }); }
  else { await supabase.from('habit_completions').insert({ habit_id: habitId, date }); res.json({ done: true }); }
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

app.post('/api/trigger/morning',     async (req, res) => { await sendMorningCheckin(); res.json({ ok: true }); });
app.post('/api/trigger/afternoon',   async (req, res) => { await sendAfternoonCheckin(); res.json({ ok: true }); });
app.post('/api/trigger/evening',     async (req, res) => { await sendEveningCalendarPreview(); res.json({ ok: true }); });
app.post('/api/trigger/reflection',  async (req, res) => { await sendWeeklyReflection(); res.json({ ok: true }); });

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Server] Running on port ${PORT}`));
