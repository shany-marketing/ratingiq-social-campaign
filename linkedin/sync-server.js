import express from 'express';
import cors from 'cors';
import { readFileSync, writeFileSync, unlinkSync, existsSync, copyFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

const DIR      = dirname(fileURLToPath(import.meta.url));
const SCHEDULE = join(DIR, 'schedule.json');
const VISUALS  = join(DIR, 'visuals');

app.post('/sync', (req, res) => {
  const { id, approved, status, date, copy, _upsert } = req.body;
  try {
    const schedule = JSON.parse(readFileSync(SCHEDULE, 'utf8'));
    let entry = schedule.find(e => e.id === id);
    if (!entry) {
      if (_upsert) {
        entry = { ..._upsert };
        schedule.push(entry);
      } else {
        return res.json({ ok: false, error: 'not found' });
      }
    }
    if (approved !== undefined) entry.approved = approved;
    if (status !== undefined) entry.status = status;
    if (copy !== undefined) entry.copy = copy;
    if (date !== undefined && date !== entry.date) {
      entry.date = date;
      // Reset failed posts when rescheduled
      if (entry.status === 'failed') {
        entry.status = 'scheduled';
        delete entry.error;
        delete entry.retryAfter;
      }
      // Cascade date to reshare children
      schedule.forEach(p => { if (p.reshareOf === id) p.date = date; });
    }
    schedule.sort((a, b) => a.date.localeCompare(b.date));
    writeFileSync(SCHEDULE, JSON.stringify(schedule, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/video/:id', express.raw({type: '*/*', limit: '500mb'}), (req, res) => {
  const id = req.params.id;
  if (!id) return res.status(400).json({ ok: false, error: 'missing id' });
  try {
    writeFileSync(join(VISUALS, `${id}.mp4`), req.body);
    const schedule = JSON.parse(readFileSync(SCHEDULE, 'utf8'));
    const entry = schedule.find(e => e.id === id);
    if (entry) { entry.type = 'video'; writeFileSync(SCHEDULE, JSON.stringify(schedule, null, 2)); }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/video/:id', (req, res) => {
  const p = join(VISUALS, `${req.params.id}.mp4`);
  if (existsSync(p)) unlinkSync(p);
  res.json({ ok: true });
});

app.post('/image', (req, res) => {
  const { id, dataUrl } = req.body;
  if (!id || !dataUrl) return res.status(400).json({ ok: false, error: 'missing id or dataUrl' });
  try {
    const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    writeFileSync(join(VISUALS, `${id}.jpg`), Buffer.from(base64, 'base64'));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/image/:id', (req, res) => {
  const path = join(VISUALS, `${req.params.id}.jpg`);
  if (existsSync(path)) unlinkSync(path);
  res.json({ ok: true });
});

app.post('/load-file', (req, res) => {
  const { id, path } = req.body;
  if (!id || !path) return res.status(400).json({ ok: false, error: 'missing id or path' });
  if (!existsSync(path)) return res.status(404).json({ ok: false, error: 'file not found: ' + path });
  try {
    const isVideo = /\.(mp4|mov|m4v|webm|avi|mkv|qt)$/i.test(path);
    if (isVideo) {
      copyFileSync(path, join(VISUALS, `${id}.mp4`));
      const schedule = JSON.parse(readFileSync(SCHEDULE, 'utf8'));
      const entry = schedule.find(e => e.id === id);
      if (entry) { entry.type = 'video'; writeFileSync(SCHEDULE, JSON.stringify(schedule, null, 2)); }
      res.json({ ok: true, type: 'video' });
    } else {
      const data = readFileSync(path);
      const ext = path.split('.').pop().toLowerCase();
      const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
      const dataUrl = `data:${mime};base64,${data.toString('base64')}`;
      writeFileSync(join(VISUALS, `${id}.jpg`), data);
      res.json({ ok: true, type: 'image', dataUrl });
    }
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/visuals', (_, res) => {
  try {
    const files = readdirSync(VISUALS).filter(f => /\.(jpg|mp4)$/.test(f));
    res.json({ ok: true, files: files.map(f => ({ id: f.replace(/\.(jpg|mp4)$/, ''), type: f.endsWith('.mp4') ? 'video' : 'image' })) });
  } catch(e) { res.json({ ok: true, files: [] }); }
});

app.get('/visual/:id', (req, res) => {
  const jpg = join(VISUALS, `${req.params.id}.jpg`);
  const mp4 = join(VISUALS, `${req.params.id}.mp4`);
  if (existsSync(jpg)) { res.setHeader('Content-Type','image/jpeg'); res.send(readFileSync(jpg)); }
  else if (existsSync(mp4)) { res.sendFile(mp4); }
  else res.status(404).json({ ok: false });
});

app.get('/health', (_, res) => res.json({ ok: true }));

// Serve the board locally so syncs work (avoids HTTPS→HTTP mixed-content block from GitHub Pages)
app.get('/', (_, res) => res.sendFile(join(DIR, '..', 'index.html')));

app.listen(3002, () => {
  console.log('[sync-server] running on :3002');
  console.log('[sync-server] board available at http://localhost:3002');
});
