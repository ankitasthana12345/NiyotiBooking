const dotenv = require('dotenv');
dotenv.config();

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

function parseBool(value, fallback = false) {
  if (value === undefined) return fallback;
  return String(value).toLowerCase() === 'true';
}

async function run() {
  let connection;
  try {
    const file = path.resolve(__dirname, '..', 'sql', 'seed_test_data.sql');
    const sqlText = fs.readFileSync(file, 'utf8');

    connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      database: process.env.DB_DATABASE || process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl: parseBool(process.env.DB_SSL, false) ? { rejectUnauthorized: false } : undefined,
      multipleStatements: true,
    });
    console.log('Connected to DB, running seed script...');

    const [results] = await connection.query(sqlText);
    const resultArray = Array.isArray(results) ? results : [results];
    const totalRows = resultArray.reduce((sum, r) => sum + (r && r.affectedRows ? r.affectedRows : 0), 0);
    console.log(`Seed script completed. Rows affected: ${totalRows}`);
  } catch (err) {
    console.error('Seed script failed:', err.message);
    process.exitCode = 1;
  } finally {
    if (connection) {
      try {
        await connection.end();
      } catch (e) {
        // ignore
      }
    }
  }
}

run();
