const dotenv = require('dotenv');
dotenv.config();

const fs = require('fs');
const path = require('path');
const { getPool, closePool } = require('../config/db');

async function run() {
  try {
    const file = path.resolve(__dirname, '..', 'sql', 'seed_test_data.sql');
    const sqlText = fs.readFileSync(file, 'utf8');

    const pool = await getPool();
    console.log('Connected to DB, running seed script...');

    const result = await pool.query(sqlText);
    const results = Array.isArray(result) ? result : [result];
    const totalRows = results.reduce((sum, r) => sum + (r.rowCount || 0), 0);
    console.log(`Seed script completed. Rows affected: ${totalRows}`);
  } catch (err) {
    console.error('Seed script failed:', err.message);
    process.exitCode = 1;
  } finally {
    try { await closePool(); } catch (e) {}
  }
}

run();
