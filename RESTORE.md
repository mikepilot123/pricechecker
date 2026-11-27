# Restoring a database backup

The **Database backup** GitHub Action (`.github/workflows/db-backup.yml`)
saves an encrypted copy of the whole database every night and keeps each one
for 30 days. Neon's free plan can only rewind 6 hours, so for anything older
these backups are the way back.

**Never restore straight over the live database.** Restore into a separate
Neon branch first, check it, and only then decide what to bring back.

## What you need

- The `BACKUP_PASSPHRASE` you saved when you set up backups. Without it a
  backup can't be opened.
- The PostgreSQL 17 tools (`pg_restore`, `psql`) on a computer, or Docker
  (the commands below show both).
- `openssl` (already on macOS and Linux; on Windows use WSL or Git Bash).

## 1. Download the backup

1. GitHub → this repository → **Actions** → **Database backup**.
2. Open the run from the day you want (scheduled runs happen at 3:23 AM
   Trinidad time).
3. Under **Artifacts**, download `pricechecker-db-<date>`. It's a `.zip`;
   unzip it. Inside are `pricechecker-<date>.dump.enc` and a `.sha256` file.

## 2. Check and decrypt it

In the unzipped folder:

```sh
sha256sum -c pricechecker-*.dump.enc.sha256        # macOS: shasum -a 256 -c …
export BACKUP_PASSPHRASE='…your passphrase…'
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -in pricechecker-*.dump.enc -out backup.dump -pass env:BACKUP_PASSPHRASE
pg_restore --list backup.dump | head                # should list tables
```

`bad decrypt` means the passphrase is wrong.

## 3. Restore into a new Neon branch (not production)

1. Neon console → your project → **Branches** → **Create branch**.
   Name it e.g. `restore-2026-11-27`, from `main`.
2. In that branch → **Databases** → **New database**, name it
   `restore_check`. It starts empty, so the restore can't clash with
   anything.
3. Copy that branch's **direct (unpooled)** connection string for the
   `restore_check` database (Connect → choose the branch and database,
   turn off "Connection pooling").
4. Restore:

   ```sh
   export RESTORE_URL='postgresql://…/restore_check?sslmode=require'
   pg_restore --no-owner --no-privileges --dbname "$RESTORE_URL" backup.dump
   ```

   With Docker instead of local tools:

   ```sh
   docker run --rm -v "$PWD":/b -e RESTORE_URL postgres:17 \
     sh -c 'pg_restore --no-owner --no-privileges --dbname "$RESTORE_URL" /b/backup.dump'
   ```

## 4. Check it before touching production

```sh
psql "$RESTORE_URL" -c "SELECT count(*) AS repairs, max(updated_at) AS last_change FROM tickets"
psql "$RESTORE_URL" -c "SELECT count(*) AS invoices FROM custom_invoices WHERE deleted_at IS NULL"
psql "$RESTORE_URL" -c "SELECT id, customer_name, device, status, updated_at FROM tickets ORDER BY updated_at DESC LIMIT 10"
```

The counts and the latest changes should match what you expect for that day.

## 5. Bring the data back

Pick the smallest fix that solves the problem:

- **A few records lost or broken:** copy just those rows from `restore_check`
  into production. For example, export the rows to CSV from the restored
  database and import them, or ask Claude to write the exact `INSERT … ON
  CONFLICT` statements for the rows you name. Run them on a Neon branch
  first.
- **The whole database is unusable:** point the app at the restored copy.
  Vercel → project **pricechecker** → Settings → Environment Variables →
  set `DATABASE_URL` (Production) to the restored branch's **pooled**
  connection string, and `DATABASE_URL_UNPOOLED` to its direct one, then
  redeploy. Anything saved after the backup was taken is not in it.

Keep the old branch until you're sure; delete the restore branch once you're
done so it doesn't use your Neon allowance.

## Testing the backups

Run the workflow by hand now and then (Actions → Database backup → **Run
workflow**) and go through steps 1–4 with the result. A backup you've never
restored isn't proven.
