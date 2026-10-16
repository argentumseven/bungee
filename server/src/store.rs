use rusqlite::{Connection, params};
use std::path::Path;

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let db = Connection::open(path)?;
    db.busy_timeout(std::time::Duration::from_secs(5))?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS devices(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, public_key TEXT, wg_key TEXT UNIQUE NOT NULL,
        address TEXT UNIQUE NOT NULL, created INTEGER NOT NULL, last_seen INTEGER,
        revoked INTEGER NOT NULL DEFAULT 0, telemetry TEXT, capabilities TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE IF NOT EXISTS enrollments(
        hash TEXT PRIMARY KEY, device_id TEXT REFERENCES devices(id), expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS nonces(
        device_id TEXT NOT NULL, nonce TEXT NOT NULL, created INTEGER NOT NULL,
        PRIMARY KEY(device_id,nonce));
      CREATE TABLE IF NOT EXISTS commands(
        id TEXT PRIMARY KEY, device_id TEXT REFERENCES devices(id), kind TEXT NOT NULL,
        payload TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', result TEXT);
      CREATE TABLE IF NOT EXISTS audit(
        id INTEGER PRIMARY KEY, at INTEGER NOT NULL, action TEXT NOT NULL, device_id TEXT, detail TEXT NOT NULL);")?;
    Ok(db)
}

pub fn audit(
    db: &Connection,
    action: &str,
    device: Option<&str>,
    detail: &str,
) -> rusqlite::Result<()> {
    db.execute(
        "INSERT INTO audit(at,action,device_id,detail) VALUES(?,?,?,?)",
        params![crate::security::now(), action, device, detail],
    )?;
    // Retain a bounded audit trail; never include coordinates or credentials in the audit.
    db.execute(
        "DELETE FROM audit WHERE id < (SELECT COALESCE(MAX(id),0)-10000 FROM audit)",
        [],
    )?;
    Ok(())
}
