# NiyotiNew

A consultation and appointment booking system.

## Quick start (local development)

1. Install dependencies:

```bash
npm install
```

2. Configure database in `server/.env`.

- For LocalDB (Windows Integrated Auth):
```
DB_DRIVER=msnodesqlv8
DB_CONNECTION_STRING=Driver={SQL Server};Server=(localdb)\\MSSQLLocalDB;Database=AppointmentBookingDB;Trusted_Connection=Yes;
```

- For SQL Server SQL Auth:
```
DB_DRIVER=tedious
DB_SERVER=localhost
DB_DATABASE=AppointmentBookingDB
DB_USER=sa
DB_PASSWORD=YourStrongPassword
DB_PORT=1433
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
