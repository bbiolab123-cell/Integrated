# Database backups

The `Nightly encrypted database backup` GitHub Actions workflow creates a PostgreSQL custom-format dump every night at 03:17 UTC. It encrypts the dump before uploading it as a private GitHub Actions artifact and retains each artifact for 14 days.

## Required repository secrets

- `DATABASE_URL`: read-capable PostgreSQL connection string for the production database.
- `BACKUP_ENCRYPTION_PASSPHRASE`: a long, randomly generated passphrase stored separately from the database credentials.

The workflow fails before running `pg_dump` if either secret is absent. It never uploads an unencrypted dump.

## Restore drill

Download one `.dump.gpg` artifact and its `.sha256` file, then run:

```bash
sha256sum --check biolab-<timestamp>.dump.gpg.sha256
gpg --output biolab.dump --decrypt biolab-<timestamp>.dump.gpg
pg_restore --clean --if-exists --no-owner --no-acl --dbname="$RESTORE_DATABASE_URL" biolab.dump
```

Use a disposable restore database for the drill. Set `RESTORE_DATABASE_URL` to that explicit database, verify row counts and a sample experiment, and then dispose of it through the database provider.
