# Maggie's Dashboard v2 — Setup Guide
## ~25 minutes total

---

## Step 1 — Supabase · 5 mins

1. Go to **https://supabase.com** → Sign up (free)
2. **New Project** → name: `maggie-dashboard` → region: **Middle East (Bahrain)**
3. Once created → **SQL Editor** → paste entire `schema.sql` → **Run**
4. Go to **Settings → API** and copy:
   - **Project URL** → `SUPABASE_URL`
   - **service_role key** → `SUPABASE_SERVICE_KEY`

---

## Step 2 — Twilio WhatsApp · 10 mins

1. **https://twilio.com** → Sign up (free, $15 trial credit)
2. Copy from Console:
   - **Account SID** → `TWILIO_ACCOUNT_SID`
   - **Auth Token** → `TWILIO_AUTH_TOKEN`
3. **Messaging → Try it out → Send a WhatsApp message**
4. Follow the sandbox join instructions (you send a WhatsApp to activate it)
5. `TWILIO_WHATSAPP_FROM` = `whatsapp:+14155238886`
6. `YOUR_WHATSAPP_NUMBER` = your number, e.g. `whatsapp:+971501234567`

---

## Step 3 — Deploy to Railway · 5 mins

1. Push this folder to GitHub:
   ```bash
   git init && git add . && git commit -m "v2"
   git remote add origin https://github.com/YOUR_USERNAME/maggie-dashboard.git
   git push -u origin main
   ```
2. **https://railway.app** → New Project → Deploy from GitHub
3. Under **Variables**, add everything from `.env.example` with your real values
4. Railway gives you a public URL — set that as `APP_URL`

---

## Step 4 — Twilio Webhook · 2 mins

1. Twilio Console → **Messaging → WhatsApp Sandbox Settings**
2. "When a message comes in":
   ```
   https://YOUR-APP.railway.app/webhook/whatsapp
   ```
   Method: **HTTP POST** → Save

---

## Step 5 — Test · 3 mins

```bash
# Trigger morning briefing now (don't wait for 10am)
curl -X POST https://YOUR-APP.railway.app/api/trigger/morning

# Trigger afternoon check-in
curl -X POST https://YOUR-APP.railway.app/api/trigger/afternoon

# Trigger Friday reflection
curl -X POST https://YOUR-APP.railway.app/api/trigger/reflection
```

---

## Schedule Summary (UAE time)

| Time | What fires |
|------|------------|
| 10:00 AM daily | Morning briefing — today's full task list |
| 3:00 PM daily | Afternoon check-in — progress update + pending tasks |
| 4:00 PM Friday | Weekly reflection prompt — 5 questions + week stats |

---

## WhatsApp Commands

| Command | Action |
|---------|--------|
| `done 1` | Mark task 1 complete |
| `done all` | Clear all today's tasks |
| `add [task]` | Add a task for today |
| `list` | See all today's tasks + status |
| `reflect 1 [answer]` | Save reflection answer (1–5) |
| `goals` | See monthly + quarterly goals snapshot |
| `help` | Full command list |

---

## What's in the dashboard

| View | What you see |
|------|-------------|
| **Daily** | Tasks, habits (7-day dots), pipeline follow-ups due today |
| **Weekly** | 7-day grid with tasks per day, KPIs (done rate, habits, pipeline) |
| **Monthly** | Goals with progress bars, habit heatmap, revenue KPIs |
| **Quarterly** | Quarterly goals, quarter summary timeline, closed revenue |
| **Pipeline** | All leads, statuses, values, follow-up flags |
| **Reflection** | Friday reflection form with 5 questions, past reflections archive |

---

## Cost

| | |
|---|---|
| Railway | Free |
| Supabase | Free |
| Twilio (3 msgs/day) | ~AED 1.50/month |
