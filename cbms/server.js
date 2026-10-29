'use strict';

const path = require('path');
const compression = require('compression');
const express = require('express');

const { seedIfEmpty } = require('./seed');
const routes = require('./routes');

const app = express();
const PORT = Number(process.env.PORT) || 8734;
app.set('port', PORT);

app.disable('x-powered-by');
app.use(compression());
app.use(express.json({ limit: '1mb' }));

// Front end (single self-contained page) + Chart.js served from node_modules
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d', etag: true }));
app.use('/vendor', express.static(path.join(__dirname, 'node_modules', 'chart.js', 'dist'), { maxAge: '7d' }));

app.use('/api', routes);

// Unknown API route -> JSON 404 (never an HTML error page)
app.use('/api', (req, res) => {
  res.status(404).json({ error: `No API route for ${req.method} ${req.originalUrl}` });
});

// Central error handler: validation/upload errors -> 400, everything else -> 500 (logged)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body is not valid JSON.' });
  }
  if (err.status === 400) {
    return res.status(400).json({ error: err.message });
  }
  console.error('[cbms error]', err);
  res.status(500).json({ error: 'Unexpected server error. The issue was logged on the server.' });
});

seedIfEmpty();
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Construction Bid Management System (demo) listening on http://0.0.0.0:${PORT}`);
});
