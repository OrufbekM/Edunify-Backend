process.loadEnvFile();

const express = require('express');
const sequelize = require('./db');

const app = express();

app.use(express.json());

app.get('/api/v1/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await sequelize.authenticate();
    console.log('PostgreSQL ulandi');

    app.listen(PORT, () => {
      console.log(`EdunifyBackend running on http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("Bazaga ulanib bo'lmadi:", err.message);
    process.exit(1);
  }
}

start();