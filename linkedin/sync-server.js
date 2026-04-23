import express from 'express';
import cors from 'cors';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const app = express();
app.use(cors());
app.use(express.json());

const SCHEDULE = join(dirname(fileURLToPath(import.meta.url)), 'schedule.json');

app.post('/sync', (req, res) => {
  const { id, approved, status } = req.body;
  try {
    const schedule = JSON.parse(readFileSync(SCHEDULE, 'utf8'));
    const entry = schedule.find(e => e.id === id);
    if (!entry) return res.json({ ok: false, error: 'not found' });
    if (approved !== undefined) entry.approved = approved;
    if (status !== undefined) entry.status = status;
    writeFileSync(SCHEDULE, JSON.stringify(schedule, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/health', (_, res) => res.json({ ok: true }));

app.listen(3002, () => console.log('[sync-server] running on :3002'));
