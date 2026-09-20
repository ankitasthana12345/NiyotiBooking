const dotenv = require('dotenv');
dotenv.config();

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

function parseBool(value, fallback = false) {
  if (value === undefined) return fallback;
  return String(value).toLowerCase() === 'true';
}

function baseConfig() {
  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: parseBool(process.env.DB_SSL, false) ? { rejectUnauthorized: false } : undefined,
    multipleStatements: true,
  };
}

async function ensureDatabaseExists(databaseName) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(databaseName)) {
    throw new Error(`Refusing to use unsafe database name: ${databaseName}`);
  }

  const connection = await mysql.createConnection(baseConfig());
  try {
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${databaseName}\``);
    console.log(`Database "${databaseName}" is ready.`);
  } finally {
    await connection.end();
  }
}

async function run() {
  const databaseName = process.env.DB_DATABASE || process.env.DB_NAME;
  if (!databaseName) {
    console.error('DB_DATABASE (or DB_NAME) is not set.');
    process.exitCode = 1;
    return;
  }

  try {
    await ensureDatabaseExists(databaseName);

    const file = path.resolve(__dirname, '..', 'sql', 'database.sql');
    const sqlText = fs.readFileSync(file, 'utf8');

    const connection = await mysql.createConnection({ ...baseConfig(), database: databaseName });
    console.log(`Connected to "${databaseName}", applying schema...`);
    try {
      await connection.query(sqlText);
      console.log('Schema applied successfully.');
    } finally {
      await connection.end();
    }
  } catch (err) {
    console.error('Schema script failed:', err.message);
    process.exitCode = 1;
  }
}

run();
