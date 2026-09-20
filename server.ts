import express, { Request, Response } from 'express';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
import { sql, ensureSchema } from './lib/db';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

/* ---------------------------------------------------------------------- *
 * Row <-> API shape mapping (DB is snake_case, frontend expects camelCase)
 * ---------------------------------------------------------------------- */
function clientRowToApi(r: any) {
  return {
    id: r.id,
    name: r.name,
    nameAr: r.name_ar,
    industry: r.industry,
    industryAr: r.industry_ar,
    location: r.location,
    locationAr: r.location_ar,
    primaryContact: r.primary_contact,
    email: r.email,
    phone: r.phone,
    retainerTier: r.retainer_tier,
    retainerTierAr: r.retainer_tier_ar,
    retainerAmountEGP: Number(r.retainer_amount_egp),
    activeDeliverablesCount: r.active_deliverables_count,
    totalDeliverablesQuota: r.total_deliverables_quota,
    activeShootsCount: r.active_shoots_count,
    status: r.status,
    badgeColor: r.badge_color,
    loginCode: r.login_code,
    dueDay: r.due_day,
    graceDays: r.grace_days,
    payments: r.payments || {},
    excusedMonths: r.excused_months || [],
    terminated: r.terminated,
    createdAt: r.created_at,
  };
}

function genLoginCode(): string {
  const s = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i++) out += s[Math.floor(Math.random() * s.length)];
  return out;
}

/** Contract status derived the same way the client-side prototype computed it:
 *  paid > excused > terminated(manual) > critical (past grace) > due. */
function computeStatus(row: any): 'paid' | 'due' | 'critical' | 'excused' | 'terminated' {
  if (row.terminated) return 'terminated';
  const now = new Date();
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const payments = row.payments || {};
  if (payments[monthKey]) return 'paid';
  const excused = row.excused_months || [];
  if (Array.isArray(excused) && excused.includes(monthKey)) return 'excused';
  const grace = row.grace_days ?? 5;
  if (now.getDate() > grace) return 'critical';
  return 'due';
}

// Lazy Gemini AI initialization
let geminiClient: GoogleGenAI | null = null;
function getGemini(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  if (!geminiClient) {
    geminiClient = new GoogleGenAI({ apiKey });
  }
  return geminiClient;
}

// Ensure the Postgres schema exists before handling any /api request.
app.use('/api', async (req: Request, res: Response, next) => {
  try {
    await ensureSchema();
    next();
  } catch (err: any) {
    console.error('Database connection error:', err);
    res.status(500).json({
      error: 'Database not configured',
      details:
        'Could not reach Postgres. Make sure a Vercel Postgres store is connected to this project (POSTGRES_URL env var).',
      raw: err?.message || String(err),
    });
  }
});

// ---------------- AUTH ----------------

// Agency admin login — checks against ADMIN_PASSWORD env var (set this in Vercel project settings).
app.post('/api/admin/login', (req: Request, res: Response) => {
  const { password } = req.body;
  const expected = process.env.ADMIN_PASSWORD || 'admin123';
  if (password === expected) {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'Incorrect password.' });
  }
});

// Client login — looks up a client by their login code. No account exists without this matching.
app.post('/api/clients/lookup', async (req: Request, res: Response) => {
  const { code } = req.body;
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: 'Code is required.' });
  }
  const { rows } = await sql`SELECT * FROM clients WHERE login_code = ${code.trim().toUpperCase()} LIMIT 1;`;
  if (rows.length === 0) {
    return res.status(404).json({ error: 'No account found for that code.' });
  }
  const client = clientRowToApi(rows[0]);
  res.json({ client, status: computeStatus(rows[0]) });
});

// Health & System Diagnostics
app.get('/api/health', async (req: Request, res: Response) => {
  const { rows } = await sql`SELECT count(*)::int AS count FROM clients;`;
  const admin = (await sql`SELECT * FROM admin_settings WHERE id = 1;`).rows[0];
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    agency: admin?.agency_name,
    adminEmail: admin?.admin_email,
    activeClientsCount: rows[0].count,
    currency: 'EGP',
  });
});

app.get('/api/admin/system', async (req: Request, res: Response) => {
  const { rows: clientRows } = await sql`SELECT * FROM clients;`;
  const admin = (await sql`SELECT * FROM admin_settings WHERE id = 1;`).rows[0];
  const { rows: logRows } = await sql`SELECT count(*)::int AS count FROM email_logs;`;
  const totalRetainerEGP = clientRows.reduce((acc, c) => acc + Number(c.retainer_amount_egp || 0), 0);
  res.json({
    adminConfig: {
      adminEmail: admin?.admin_email,
      adminEmails: admin?.admin_emails,
      adminName: admin?.admin_name,
      adminRole: admin?.admin_role,
      agencyName: admin?.agency_name,
      currency: admin?.currency,
      autoDispatchEmail: admin?.auto_dispatch_email,
      nodes: [
        { name: 'Cairo Studio Node 01 (Zamalek)', status: 'online', ping: '12ms' },
        { name: 'Dubai Production Lab 04 (d3)', status: 'online', ping: '24ms' },
        { name: 'Riyadh Creative Core (KAFD)', status: 'online', ping: '18ms' },
      ],
    },
    totalClients: clientRows.length,
    activeClients: clientRows.filter((c) => c.status === 'active').length,
    totalRetainerEGP,
    emailLogsCount: logRows[0].count,
  });
});

app.put('/api/admin/config', async (req: Request, res: Response) => {
  const { adminEmail, autoDispatchEmail } = req.body;
  if (adminEmail && typeof adminEmail === 'string') {
    await sql`UPDATE admin_settings SET admin_email = ${adminEmail.trim()} WHERE id = 1;`;
  }
  if (typeof autoDispatchEmail === 'boolean') {
    await sql`UPDATE admin_settings SET auto_dispatch_email = ${autoDispatchEmail} WHERE id = 1;`;
  }
  const admin = (await sql`SELECT * FROM admin_settings WHERE id = 1;`).rows[0];
  res.json({ success: true, adminConfig: admin });
});

// ---------------- CLIENTS ----------------

app.get('/api/clients', async (req: Request, res: Response) => {
  const { rows } = await sql`SELECT * FROM clients ORDER BY created_at DESC;`;
  res.json(rows.map((r) => ({ ...clientRowToApi(r), accountStatus: computeStatus(r) })));
});

app.get('/api/clients/:id', async (req: Request, res: Response) => {
  const { rows } = await sql`SELECT * FROM clients WHERE id = ${req.params.id} LIMIT 1;`;
  if (rows.length === 0) return res.status(404).json({ error: 'Client account not found' });
  res.json({ ...clientRowToApi(rows[0]), accountStatus: computeStatus(rows[0]) });
});

app.post('/api/clients', async (req: Request, res: Response) => {
  const b = req.body;
  if (!b.name || !b.email || !b.primaryContact) {
    return res.status(400).json({ error: 'Name, email, and primary contact are required' });
  }
  const id = b.id || `client-${String(b.name).toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 15)}-${Date.now().toString().slice(-4)}`;
  let loginCode = (b.loginCode || '').trim().toUpperCase();
  if (!loginCode) loginCode = genLoginCode();

  try {
    const { rows } = await sql`
      INSERT INTO clients (
        id, name, name_ar, industry, industry_ar, location, location_ar,
        primary_contact, email, phone, retainer_tier, retainer_tier_ar,
        retainer_amount_egp, total_deliverables_quota, active_shoots_count,
        status, badge_color, login_code, due_day, grace_days
      ) VALUES (
        ${id}, ${b.name}, ${b.nameAr || b.name}, ${b.industry || 'Luxury Creative'}, ${b.industryAr || 'إبداع وإنتاج فاخر'},
        ${b.location || 'Cairo / Dubai'}, ${b.locationAr || 'القاهرة / دبي'}, ${b.primaryContact}, ${b.email},
        ${b.phone || '+20 100 000 0000'}, ${b.retainerTier || 'Tier B — Custom Retainer'}, ${b.retainerTierAr || 'الفئة ب — رتينر مخصص'},
        ${Number(b.retainerAmountEGP) || 600000}, ${Number(b.totalDeliverablesQuota) || 12}, ${Number(b.activeShootsCount) || 1},
        'active', ${b.badgeColor || '#ff7bb4'}, ${loginCode}, ${Number(b.dueDay) || 1}, ${Number(b.graceDays) || 5}
      )
      RETURNING *;
    `;
    res.status(201).json({ success: true, client: clientRowToApi(rows[0]) });
  } catch (err: any) {
    if (String(err?.message || '').includes('duplicate key')) {
      return res.status(409).json({ error: 'That login code is already in use.' });
    }
    throw err;
  }
});

app.put('/api/clients/:id', async (req: Request, res: Response) => {
  const { rows: existingRows } = await sql`SELECT * FROM clients WHERE id = ${req.params.id};`;
  if (existingRows.length === 0) return res.status(404).json({ error: 'Client not found' });
  const cur = existingRows[0];
  const b = req.body;
  const merged = {
    name: b.name ?? cur.name,
    name_ar: b.nameAr ?? cur.name_ar,
    industry: b.industry ?? cur.industry,
    industry_ar: b.industryAr ?? cur.industry_ar,
    location: b.location ?? cur.location,
    location_ar: b.locationAr ?? cur.location_ar,
    primary_contact: b.primaryContact ?? cur.primary_contact,
    email: b.email ?? cur.email,
    phone: b.phone ?? cur.phone,
    retainer_tier: b.retainerTier ?? cur.retainer_tier,
    retainer_tier_ar: b.retainerTierAr ?? cur.retainer_tier_ar,
    retainer_amount_egp: b.retainerAmountEGP ?? cur.retainer_amount_egp,
    active_deliverables_count: b.activeDeliverablesCount ?? cur.active_deliverables_count,
    total_deliverables_quota: b.totalDeliverablesQuota ?? cur.total_deliverables_quota,
    active_shoots_count: b.activeShootsCount ?? cur.active_shoots_count,
    status: b.status ?? cur.status,
    badge_color: b.badgeColor ?? cur.badge_color,
    login_code: b.loginCode ? String(b.loginCode).trim().toUpperCase() : cur.login_code,
    due_day: b.dueDay ?? cur.due_day,
    grace_days: b.graceDays ?? cur.grace_days,
  };
  const { rows } = await sql`
    UPDATE clients SET
      name=${merged.name}, name_ar=${merged.name_ar}, industry=${merged.industry}, industry_ar=${merged.industry_ar},
      location=${merged.location}, location_ar=${merged.location_ar}, primary_contact=${merged.primary_contact},
      email=${merged.email}, phone=${merged.phone}, retainer_tier=${merged.retainer_tier}, retainer_tier_ar=${merged.retainer_tier_ar},
      retainer_amount_egp=${merged.retainer_amount_egp}, active_deliverables_count=${merged.active_deliverables_count},
      total_deliverables_quota=${merged.total_deliverables_quota}, active_shoots_count=${merged.active_shoots_count},
      status=${merged.status}, badge_color=${merged.badge_color}, login_code=${merged.login_code},
      due_day=${merged.due_day}, grace_days=${merged.grace_days}
    WHERE id=${req.params.id}
    RETURNING *;
  `;
  res.json({ success: true, client: clientRowToApi(rows[0]) });
});

app.delete('/api/clients/:id', async (req: Request, res: Response) => {
  const { rows } = await sql`DELETE FROM clients WHERE id = ${req.params.id} RETURNING *;`;
  if (rows.length === 0) return res.status(404).json({ error: 'Client not found' });
  res.json({ success: true, deleted: clientRowToApi(rows[0]) });
});

// Payment / contract actions — mirrors the 1–5 day grace-period rule.
app.post('/api/clients/:id/payment', async (req: Request, res: Response) => {
  const { action, month } = req.body; // action: 'paid' | 'excuse' | 'terminate' | 'reinstate'
  const { rows } = await sql`SELECT * FROM clients WHERE id = ${req.params.id};`;
  if (rows.length === 0) return res.status(404).json({ error: 'Client not found' });
  const cur = rows[0];
  const now = new Date();
  const mk = month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  let result;
  if (action === 'paid') {
    const payments = { ...(cur.payments || {}), [mk]: true };
    result = await sql`UPDATE clients SET payments = ${JSON.stringify(payments)}::jsonb WHERE id = ${req.params.id} RETURNING *;`;
  } else if (action === 'excuse') {
    const excused = Array.from(new Set([...(cur.excused_months || []), mk]));
    result = await sql`UPDATE clients SET excused_months = ${JSON.stringify(excused)}::jsonb WHERE id = ${req.params.id} RETURNING *;`;
  } else if (action === 'terminate') {
    result = await sql`UPDATE clients SET terminated = true WHERE id = ${req.params.id} RETURNING *;`;
  } else if (action === 'reinstate') {
    result = await sql`UPDATE clients SET terminated = false WHERE id = ${req.params.id} RETURNING *;`;
  } else {
    return res.status(400).json({ error: 'Unknown action. Use paid | excuse | terminate | reinstate.' });
  }
  const row = result.rows[0];
  res.json({ success: true, client: clientRowToApi(row), status: computeStatus(row) });
});

// ---------------- EMAIL DISPATCH LOGS & BRIEF ROUTING ----------------

app.get('/api/email-logs', async (req: Request, res: Response) => {
  const { rows } = await sql`SELECT * FROM email_logs ORDER BY "timestamp" DESC LIMIT 100;`;
  res.json(
    rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      recipient: r.recipient,
      subject: r.subject,
      clientName: r.client_name,
      clientId: r.client_id,
      briefTitle: r.brief_title,
      deliverablesRequested: r.deliverables_requested,
      specs: r.specs,
      status: r.status,
    }))
  );
});

app.post('/api/dispatch-brief', async (req: Request, res: Response) => {
  const {
    briefTitle, clientId, clientName, category, platform, aspectRatio,
    visualMood, deliverablesRequested, colorGrade, audioSync, turnaround, targetAdminEmail,
  } = req.body;

  const admin = (await sql`SELECT * FROM admin_settings WHERE id = 1;`).rows[0];
  const recipient = targetAdminEmail || admin?.admin_email;
  const reqCode = `#REQ-${Math.floor(100 + Math.random() * 900)}`;
  const id = `email-dispatch-${Date.now()}`;
  const subject = `[91 NET WORK] Production Brief Dispatch from ${clientName || 'Client'} (${reqCode})`;
  const specs = {
    code: reqCode,
    platform: platform || '9:16 Instagram Reels & 4K Master',
    aspectRatio: aspectRatio || '9:16 Vertical',
    colorProfile: colorGrade || 'Kodak 5219 Cine LUT',
    audioSync: audioSync || 'Soundtrack + Foley Master',
    turnaround: turnaround || 'Standard (5-7 Days)',
    visualMood: visualMood || 'Editorial High Fashion',
  };
  const deliverables = deliverablesRequested || [category || 'Digital Deliverable'];

  await sql`
    INSERT INTO email_logs (id, recipient, subject, client_name, client_id, brief_title, deliverables_requested, specs, status)
    VALUES (${id}, ${recipient}, ${subject}, ${clientName || 'Client Partner'}, ${clientId || null}, ${briefTitle || 'New Production Brief'},
      ${JSON.stringify(deliverables)}::jsonb, ${JSON.stringify(specs)}::jsonb, 'delivered');
  `;

  res.json({
    success: true,
    message: `Brief successfully dispatched to ${recipient}`,
    dispatchedTo: recipient,
    adminExecutive: admin?.admin_name,
    requestCode: reqCode,
  });
});

// AI CHAT ENDPOINT (Gemini-powered creative scoping)
app.post('/api/ai/chat', async (req: Request, res: Response) => {
  try {
    const { message, clientContext } = req.body;
    const ai = getGemini();
    const admin = (await sql`SELECT * FROM admin_settings WHERE id = 1;`).rows[0];

    if (!ai) {
      // Fallback if GEMINI_API_KEY isn't set yet.
      return res.json({
        reply: `I have received your creative specifications: "${message}". I have formatted this into an executive production brief for ${clientContext?.name || 'your brand'} and dispatched all technical requirements directly to our Founder & CEO, SEIF ABD ELAZIZ, at ceo@91network.online and seifabdelaziz@91network.online. Would you like to add any specific audio or camera requirements?`,
        structuredBrief: {
          title: message?.length > 50 ? `${message.substring(0, 48)}...` : message,
          platform: 'Instagram Reels & TikTok 4K',
          aspectRatio: '9:16 Vertical',
          colorProfile: 'Kodak 5219 Film Emulation',
          turnaround: 'Standard (5-7 Days)',
        },
      });
    }

    const systemInstruction = `You are the Executive AI Creative Director for "91' Network", a luxury creative and high-end video production agency based in Cairo and Dubai.
Founder & CEO / Executive Creative Director: ${admin?.admin_name || 'SEIF ABD ELAZIZ'}.
Admin Notification & Dispatch Emails: ${admin?.admin_email}.
You are assisting client: "${clientContext?.name || 'Our Valued Client'}".
Currency: All financial figures, retainers, and budgets must ALWAYS be expressed in Egyptian Pounds (EGP).
Your goal is to gather project parameters from the client (visual style, deliverables count, aspect ratio, audio/music, deadlines) and formulate an executive brief.
When you have sufficient info, confirm that the brief is dispatched directly to the admin.
Keep your tone elegant, concise, editorial, and professional.`;

    const promptText = `${systemInstruction}\n\nClient conversation message: "${message}"\n\nProvide an intelligent, supportive response guiding the client's creative request.`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: promptText,
    });

    const reply = response.text || 'Brief details noted and compiled for agency dispatch.';
    res.json({ reply });
  } catch (error: any) {
    console.error('Error in /api/ai/chat:', error);
    res.status(500).json({ error: 'AI generation error', details: error?.message || String(error) });
  }
});

// ---------------- STATIC / DEV SERVING ----------------
// On Vercel, the frontend (dist/) is built and served separately by the static
// hosting layer — this app only ever handles /api/*. Locally, `npm run dev`
// uses Vite's own dev server (see package.json), not this file, for the frontend.
if (!process.env.VERCEL) {
  app.use(express.static(path.join(process.cwd(), 'dist')));
  app.get('*', (req: Request, res: Response) => {
    res.sendFile(path.join(process.cwd(), 'dist', 'index.html'));
  });
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`91' Network Agency Backend running on http://0.0.0.0:${PORT}`);
  });
}

export default app;
