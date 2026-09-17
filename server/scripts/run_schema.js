const dotenv = require('dotenv');
dotenv.config();

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

function parseBool(value, fallback = false) {
  if (value === undefined) return fallback;
  return String(value).toLowerCase() === 'true';
}

function baseConfig() {
  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: parseBool(process.env.DB_SSL, false) ? { rejectUnauthorized: false } : false,
  };
}

async function ensureDatabaseExists(databaseName) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(databaseName)) {
    throw new Error(`Refusing to use unsafe database name: ${databaseName}`);
  }

  // CREATE DATABASE can't run inside a transaction, so this connects to the
  // `postgres` maintenance database first, separately from the target DB.
  const client = new Client({ ...baseConfig(), database: 'postgres' });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName]);
    if (rows.length === 0) {
      console.log(`Database "${databaseName}" does not exist, creating it...`);
      await client.query(`CREATE DATABASE "${databaseName}"`);
    } else {
      console.log(`Database "${databaseName}" already exists.`);
    }
  } finally {
    await client.end();
  }
}

async function run() {
  const databaseName = process.env.DB_DATABASE;
  if (!databaseName) {
    console.error('DB_DATABASE is not set.');
    process.exitCode = 1;
    return;
  }

  try {
    await ensureDatabaseExists(databaseName);

    const file = path.resolve(__dirname, '..', 'sql', 'database.sql');
    const sqlText = fs.readFileSync(file, 'utf8');

    const client = new Client({ ...baseConfig(), database: databaseName });
    await client.connect();
    console.log(`Connected to "${databaseName}", applying schema...`);
    try {
      await client.query(sqlText);
      console.log('Schema applied successfully.');
    } finally {
      await client.end();
    }
  } catch (err) {
    console.error('Schema script failed:', err.message);
    process.exitCode = 1;
  }
}

run();
