require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const cron     = require('node-cron');
const path     = require('path');
const { createClient } = require('@supabase/supabase-js');
const twilio   = require('twilio');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '../public')));

// ── Clients ──────────────────────────────────────────────
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const tw       = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const FROM     = process.env.TWILIO_WHATSAPP_FROM;
const TO       = process.env.YOUR_WHATSAPP_NUMBER;

// ── Date helpers ─────────────────────────────────────────
function todayUAE() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
}

function getWeekKey(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  const jan4 = new Date(d.getFullYear(), 0, 4);
  const startOfWeek = new Date(jan4);
  startOfWeek.setDate(jan4.getDate() - jan4.getDay() + 1);
  const diff = d - startOfWeek;
  const week = Math.floor(diff / (7 * 864e5)) + 1;
  return `${d.getFullYear()}-W${String(week).padStart(2,'0')}`;
}

function getWeekStart() {
  const d = new Date();
  const day = d.getDay(); // 0=Sun
  const diff = d.getDate() - (day === 0 ? 6 : day - 1);
  return new Date(d.setDate(diff)).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
}

function getMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
}

function getQuarterKey() {
  const d = new Date();
  const q = Math.ceil((d.getMonth()+1)/3);
  return `${d.getFullYear()}-Q${q}`;
}

// ── WhatsApp sender ──────────────────────────────────────
async function send(body) {
  return tw.messages.create({ from: FROM, to: TO, body });
}

// ── Get today's tasks ────────────────────────────────────
async function getTodaysTasks() {
  const { data } = await supabase.from('tasks').select('*').eq('date', todayUAE()).order('created_at');
  return data || [];
}

// ══════════════════════════════════════════════════════════
// SCHEDULED MESSAGES
// ══════════════════════════════════════════════════════════

// ── Morning briefing (10am UAE) ──
async function sendMorningBriefing() {
  try {
    const tasks   = await getTodaysTasks();
    const pending = tasks.filter(t => !t.done);

    let body = `☀️ *Good morning, Maggie!*\n\n`;

    if (pending.length === 0) {
      body += `You have no tasks yet today.\nReply \`add [task]\` to add one, or open your dashboard.\n\n🔗 ${process.env.APP_URL}`;
    } else {
      body += `📋 *Today's ${pending.length} priorities:*\n\n`;
      pending.forEach((t, i) => {
        const icon = t.tag === 'pr' ? '🟣' : t.tag === 'urgent' ? '🔴' : '🟡';
        body += `${icon} *${i+1}.* ${t.text}\n`;
      });
      body += `\n_Reply_ \`done 1\` _to mark tasks complete_`;
      body += `\n_Reply_ \`list\` _to see full status_`;
      body += `\n\n🔗 ${process.env.APP_URL}`;
    }

    await send(body);
    console.log(`[Morning] Sent ${new Date().toISOString()}`);
  } catch(e) { console.error('[Morning]', e.message); }
}

// ── Afternoon check-in (3pm UAE) ──
async function sendAfternoonCheckin() {
  try {
    const tasks   = await getTodaysTasks();
    const pending = tasks.filter(t => !t.done);
    const done    = tasks.filter(t => t.done);
    const total   = tasks.length;
    const pct     = total ? Math.round((done.length / total) * 100) : 0;

    let body = `🌤 *Afternoon check-in, Maggie*\n\n`;
    body += `Progress: *${done.length}/${total} tasks done* (${pct}%)\n\n`;

    if (pending.length === 0) {
      body += `✨ You've cleared everything for today — great work!\n`;
    } else {
      body += `Still to go:\n`;
      pending.forEach((t, i) => {
        body += `⬜ *${i+1}.* ${t.text}\n`;
      });
      body += `\nReply \`done [number]\` or \`done all\` to update.`;
    }

    body += `\n\n🔗 ${process.env.APP_URL}`;
    await send(body);
    console.log(`[Afternoon] Sent ${new Date().toISOString()}`);
  } catch(e) { console.error('[Afternoon]', e.message); }
}

// ── Friday weekly reflection (4pm UAE) ──
async function sendWeeklyReflection() {
  try {
    // Pull week's task stats
    const weekStart = getWeekStart();
    const { data: weekTasks } = await supabase
      .from('tasks').select('*')
      .gte('date', weekStart).lte('date', todayUAE());

    const total = (weekTasks||[]).length;
    const done  = (weekTasks||[]).filter(t => t.done).length;

    // Pull pipeline snapshot
    const { data: leads } = await supabase.from('leads').select('*');
    const pipelineVal = (leads||[]).reduce((s,l) => s + (l.status !== 'cold' ? l.value : 0), 0);

    let body = `📓 *Weekly Reflection — it's Friday, Maggie*\n\n`;
    body += `Week at a glance: *${done}/${total} tasks completed*\n`;
    body += `Pipeline: *AED ${pipelineVal.toLocaleString()}*\n\n`;
    body += `─────────────────────\n`;
    body += `Answer these when you're ready. Reply with the question number + your answer:\n\n`;
    body += `*1.* What did I win this week?\n`;
    body += `*2.* What slipped and why?\n`;
    body += `*3.* What's my #1 focus next week?\n`;
    body += `*4.* How did I show up for myself?\n`;
    body += `*5.* Pipeline: what moved, what stalled?\n\n`;
    body += `_e.g. reply_ \`reflect 1 Signed the Bloom Studio deal\`\n\n`;
    body += `🔗 ${process.env.APP_URL}/reflection`;
    await send(body);
    console.log(`[Reflection] Sent ${new Date().toISOString()}`);
  } catch(e) { console.error('[Reflection]', e.message); }
}

// ── Cron jobs ────────────────────────────────────────────
cron.schedule(process.env.CRON_MORNING              || '0 6 * * *',  sendMorningBriefing,   { timezone: 'UTC' });
cron.schedule(process.env.CRON_AFTERNOON            || '0 11 * * *', sendAfternoonCheckin,  { timezone: 'UTC' });
cron.schedule(process.env.CRON_WEEKLY_REFLECTION    || '0 12 * * 5', sendWeeklyReflection,  { timezone: 'UTC' });
console.log('[Cron] Scheduled: morning 10am, afternoon 3pm, reflection Fri 4pm (UAE)');

// ══════════════════════════════════════════════════════════
// WHATSAPP WEBHOOK
// ══════════════════════════════════════════════════════════
app.post('/webhook/whatsapp', async (req, res) => {
  const raw  = (req.body.Body || '').trim();
  const msg  = raw.toLowerCase();
  const from = req.body.From;

  if (from !== TO) return res.sendStatus(403);

  const twiml = new twilio.twiml.MessagingResponse();

  try {
    // ── done [n] ──────────────────────────
    const doneMatch = msg.match(/^done\s+(\d+)$/);
    if (doneMatch) {
      const tasks   = await getTodaysTasks();
      const pending = tasks.filter(t => !t.done);
      const idx     = parseInt(doneMatch[1]) - 1;
      if (idx < 0 || idx >= pending.length) {
        twiml.message(`⚠️ Task ${doneMatch[1]} not found. You have ${pending.length} pending.`);
      } else {
        const t = pending[idx];
        await supabase.from('tasks').update({ done: true }).eq('id', t.id);
        const left = pending.length - 1;
        twiml.message(`✅ Done: "${t.text}"\n\n${left > 0 ? `${left} task(s) still to go.` : '🎉 Everything cleared for today!'}`);
      }
    }

    // ── done all ──────────────────────────
    else if (msg === 'done all') {
      const tasks   = await getTodaysTasks();
      const pending = tasks.filter(t => !t.done);
      if (!pending.length) { twiml.message('✅ Everything was already done!'); }
      else {
        await supabase.from('tasks').update({ done: true }).in('id', pending.map(t => t.id));
        twiml.message(`🎉 All ${pending.length} tasks marked done. Dashboard updated!`);
      }
    }

    // ── add [text] ────────────────────────
    else if (msg.startsWith('add ')) {
      const text = raw.slice(4).trim();
      if (!text) { twiml.message(`⚠️ Try: \`add Call Sana re: retainer\``); }
      else {
        await supabase.from('tasks').insert({ text, tag: 'personal', date: todayUAE() });
        twiml.message(`➕ Added: "${text}"\n\nReply \`list\` to see all tasks.`);
      }
    }

    // ── list ──────────────────────────────
    else if (msg === 'list') {
      const tasks = await getTodaysTasks();
      if (!tasks.length) { twiml.message('No tasks today. Reply `add [task]` to add one.'); }
      else {
        let reply = `📋 *Today's tasks:*\n\n`;
        tasks.forEach((t, i) => { reply += `${t.done ? '✅' : '⬜'} ${i+1}. ${t.text}\n`; });
        twiml.message(reply);
      }
    }

    // ── reflect [n] [answer] ──────────────
    else if (msg.startsWith('reflect ')) {
      const parts = raw.slice(8).trim();
      const qNum  = parseInt(parts[0]);
      const answer = parts.slice(2).trim();
      const qMap   = { 1: 'wins', 2: 'slipped', 3: 'next_focus', 4: 'showed_up', 5: 'pipeline_notes' };
      const field  = qMap[qNum];

      if (!field || !answer) {
        twiml.message(`⚠️ Format: \`reflect 1 My answer here\``);
      } else {
        const weekKey   = getWeekKey();
        const weekStart = getWeekStart();
        const { data: existing } = await supabase.from('reflections')
          .select('id').eq('week_key', weekKey).single();

        if (existing) {
          await supabase.from('reflections').update({ [field]: answer }).eq('week_key', weekKey);
        } else {
          await supabase.from('reflections').insert({ week_key: weekKey, week_start: weekStart, [field]: answer });
        }

        const qLabels = { wins: '🏆 Wins', slipped: '📉 Slipped', next_focus: '🎯 Next focus', showed_up: '💛 Showed up', pipeline_notes: '📊 Pipeline' };
        twiml.message(`✍️ Saved — *${qLabels[field]}*: "${answer}"\n\nReply \`reflect [1-5] [answer]\` for other questions.\n\nSee full reflection: ${process.env.APP_URL}/reflection`);
      }
    }

    // ── goals ─────────────────────────────
    else if (msg === 'goals') {
      const mKey = getMonthKey();
      const qKey = getQuarterKey();
      const { data: goals } = await supabase.from('goals').select('*')
        .or(`period_key.eq.${mKey},period_key.eq.${qKey}`);

      if (!goals?.length) { twiml.message('No goals set yet. Add them at ' + process.env.APP_URL); }
      else {
        let reply = `🎯 *Your Goals*\n\n`;
        const monthly = goals.filter(g => g.period_type === 'monthly');
        const quarterly = goals.filter(g => g.period_type === 'quarterly');

        if (monthly.length) {
          reply += `*This month:*\n`;
          monthly.forEach(g => {
            const pct = g.target ? Math.round((g.progress/g.target)*100) : null;
            reply += `${g.done ? '✅' : '▫️'} ${g.title}${pct !== null ? ` (${pct}%)` : ''}\n`;
          });
          reply += '\n';
        }
        if (quarterly.length) {
          reply += `*This quarter:*\n`;
          quarterly.forEach(g => {
            const pct = g.target ? Math.round((g.progress/g.target)*100) : null;
            reply += `${g.done ? '✅' : '▫️'} ${g.title}${pct !== null ? ` (${pct}%)` : ''}\n`;
          });
        }
        twiml.message(reply);
      }
    }

    // ── help ──────────────────────────────
    else {
      twiml.message(
        `👋 *Maggie's Dashboard*\n\n` +
        `*Task commands:*\n` +
        `• \`done 1\` — mark task 1 done\n` +
        `• \`done all\` — clear all tasks\n` +
        `• \`add [task]\` — add a task\n` +
        `• \`list\` — see today's tasks\n\n` +
        `*Reflection:*\n` +
        `• \`reflect 1 [answer]\` — save reflection\n\n` +
        `*Goals:*\n` +
        `• \`goals\` — see monthly + quarterly goals\n\n` +
        `🔗 ${process.env.APP_URL}`
      );
    }
  } catch(e) {
    console.error('[Webhook]', e.message);
    twiml.message('⚠️ Something went wrong. Check your dashboard.');
  }

  res.type('text/xml').send(twiml.toString());
});

// ══════════════════════════════════════════════════════════
// API ROUTES
// ══════════════════════════════════════════════════════════

// ── Tasks ────────────────────────────────────────────────
app.get('/api/tasks', async (req, res) => {
  const date = req.query.date || todayUAE();
  const { data, error } = await supabase.from('tasks').select('*').eq('date', date).order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/tasks', async (req, res) => {
  const { text, tag, date } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  const { data, error } = await supabase.from('tasks').insert({ text, tag: tag||'personal', date: date||todayUAE() }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/tasks/:id', async (req, res) => {
  const { data, error } = await supabase.from('tasks').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/tasks/:id', async (req, res) => {
  const { error } = await supabase.from('tasks').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// Tasks by date range (for weekly view)
app.get('/api/tasks/range', async (req, res) => {
  const { from, to } = req.query;
  const { data, error } = await supabase.from('tasks').select('*').gte('date', from).lte('date', to).order('date').order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── Habits ───────────────────────────────────────────────
app.get('/api/habits', async (req, res) => {
  const { data: habits, error } = await supabase.from('habits').select('*').order('id');
  if (error) return res.status(500).json({ error: error.message });
  const since = new Date(); since.setDate(since.getDate() - 30);
  const sinceStr = since.toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
  const { data: completions } = await supabase.from('habit_completions').select('*').gte('date', sinceStr);
  res.json(habits.map(h => ({ ...h, completions: (completions||[]).filter(c => c.habit_id === h.id).map(c => c.date) })));
});

app.post('/api/habits/:id/toggle', async (req, res) => {
  const date = req.body.date || todayUAE();
  const habitId = parseInt(req.params.id);
  const { data: existing } = await supabase.from('habit_completions').select('id').eq('habit_id', habitId).eq('date', date).single();
  if (existing) {
    await supabase.from('habit_completions').delete().eq('id', existing.id);
    res.json({ done: false });
  } else {
    await supabase.from('habit_completions').insert({ habit_id: habitId, date });
    res.json({ done: true });
  }
});

// ── Leads ────────────────────────────────────────────────
app.get('/api/leads', async (req, res) => {
  const { data, error } = await supabase.from('leads').select('*').order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/leads', async (req, res) => {
  const { name, company, status, value, followup } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const { data, error } = await supabase.from('leads').insert({ name, company, status, value, followup }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/leads/:id', async (req, res) => {
  const { data, error } = await supabase.from('leads').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/leads/:id', async (req, res) => {
  const { error } = await supabase.from('leads').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Goals ────────────────────────────────────────────────
app.get('/api/goals', async (req, res) => {
  const { period_type, period_key } = req.query;
  let q = supabase.from('goals').select('*');
  if (period_type) q = q.eq('period_type', period_type);
  if (period_key)  q = q.eq('period_key', period_key);
  const { data, error } = await q.order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/goals', async (req, res) => {
  const { data, error } = await supabase.from('goals').insert(req.body).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/goals/:id', async (req, res) => {
  const { data, error } = await supabase.from('goals').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/goals/:id', async (req, res) => {
  const { error } = await supabase.from('goals').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Reflections ──────────────────────────────────────────
app.get('/api/reflections', async (req, res) => {
  const { data, error } = await supabase.from('reflections').select('*').order('week_start', { ascending: false }).limit(12);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/reflections/:weekKey', async (req, res) => {
  const { data } = await supabase.from('reflections').select('*').eq('week_key', req.params.weekKey).single();
  res.json(data || {});
});

app.post('/api/reflections', async (req, res) => {
  const { week_key, week_start, ...fields } = req.body;
  const { data: existing } = await supabase.from('reflections').select('id').eq('week_key', week_key).single();
  let result;
  if (existing) {
    const { data } = await supabase.from('reflections').update(fields).eq('week_key', week_key).select().single();
    result = data;
  } else {
    const { data } = await supabase.from('reflections').insert({ week_key, week_start, ...fields }).select().single();
    result = data;
  }
  res.json(result);
});

// ── Manual triggers ──────────────────────────────────────
app.post('/api/trigger/morning',    async (req, res) => { await sendMorningBriefing();  res.json({ ok: true }); });
app.post('/api/trigger/afternoon',  async (req, res) => { await sendAfternoonCheckin(); res.json({ ok: true }); });
app.post('/api/trigger/reflection', async (req, res) => { await sendWeeklyReflection(); res.json({ ok: true }); });

// ── Health ───────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Server] Running on :${PORT}`));
