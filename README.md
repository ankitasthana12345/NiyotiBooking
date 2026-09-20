# NiyotiNew

A consultation and appointment booking system.

## Quick start (local development)

1. Install dependencies:

```bash
npm install
```

2. Configure MySQL in `.env` for local development, or attach a hosted
	database in GoDaddy. GoDaddy injects these variables automatically:

```
DB_HOST=localhost
DB_PORT=3306
DB_NAME=AppointmentBookingDB
DB_USER=your_user
DB_PASSWORD=your_password
DB_SSL=false
```

3. Start the app:

```bash
npm start
```

4. Health check:

```bash
curl http://localhost:3000/api/health
```

If the DB is unavailable, the server will still start but DB-dependent endpoints will fail until you configure the database.
