const fs = require('fs');
const path = require('path');
const { getPool, closePool } = require('../config/db');

async function run() {
  try {
    const file = path.resolve(__dirname, '..', 'sql', 'seed_test_data.sql');
    const sqlText = fs.readFileSync(file, 'utf8');

    const pool = await getPool();
    console.log('Connected to DB, running seed script...');

    // Split batches by GO statements (on their own line)
    const batches = sqlText.split(/\r?\nGO\r?\n/gi).map(s => s.trim()).filter(Boolean);

    for (const [i, batch] of batches.entries()) {
      console.log(`Running batch ${i + 1}/${batches.length}...`);
      const result = await pool.request().query(batch);
      console.log(`Batch ${i + 1} affected rows: ${result.rowsAffected}`);
    }

    console.log('Seed script completed.');
  } catch (err) {
    console.error('Seed script failed:', err.message);
    process.exitCode = 1;
  } finally {
    try { await closePool(); } catch (e) {}
  }
}

run();
