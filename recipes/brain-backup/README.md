# Brain Backup and Export

Export the current hosted Open Brain backup contract to local JSON files. The script paginates through PostgREST, writes each table to a dated JSON file, and prints a summary.

## Prerequisites

- An Open Brain setup with a running Supabase project
- Node.js 18 or later
- A `.env.local` file in the recipe directory (or exported environment variables) containing:
  - `SUPABASE_URL` -- your Supabase project URL
  - `SUPABASE_SERVICE_ROLE_KEY` -- a service-role key for the project

## Steps

1. Copy or create a `.env.local` file in this script directory with your credentials:

   ```
   SUPABASE_URL=https://your-project.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
   ```

2. Run the backup script from this directory or by absolute path:

   ```bash
   node backup-brain.mjs --preflight --json
   node backup-brain.mjs
   node ~/Projects/Sea\ Ranch\ AI/OB1/recipes/brain-backup/backup-brain.mjs
   ```

3. The preflight command checks local env availability, URL shape, script-directory writeability, backup directory target, and table list. It does not make a hosted Supabase request and never prints the service-role key. The current export set is `thoughts`, `agent_memories`, and `agent_memory_audit_events`.

4. The script creates `OB1/recipes/brain-backup/backup/` and writes one JSON file per table, named `<table>-YYYY-MM-DD.json`. It also writes `manifest-YYYY-MM-DD.json` with table row counts, file sizes, `sha256` hashes, the source Supabase host, and an `ok` flag.

5. Review the printed summary and manifest to confirm all tables exported successfully. If any table export fails, the manifest records the error and the script exits non-zero so the backup cannot be mistaken for a complete migration artifact.

## Expected Result

After running the script you will have an `OB1/recipes/brain-backup/backup` directory containing dated JSON exports of the hosted backup tables (thoughts, agent_memories, and agent_memory_audit_events), plus `manifest-YYYY-MM-DD.json`. The console output and manifest show row counts, file sizes, `sha256` hashes, success/failure counts, and whether the backup is complete.

## Tips

- Schedule the script with cron or Task Scheduler for automatic daily backups.
- Commit the `backup/` directory to a private repo for versioned history.
- The script streams rows to disk, so it handles large tables without running out of memory.
