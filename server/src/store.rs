use rusqlite::{Connection, params};
use std::path::Path;

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let db = Connection::open(path)?;
    db.busy_timeout(std::time::Duration::from_secs(5))?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
    initialize(&db)?;
    Ok(db)
}

fn initialize(db: &Connection) -> rusqlite::Result<()> {
    let tx = db.unchecked_transaction()?;
    tx.execute_batch("
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS devices(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, public_key TEXT, wg_key TEXT UNIQUE NOT NULL,
        address TEXT UNIQUE NOT NULL, created INTEGER NOT NULL, last_seen INTEGER,
        revoked INTEGER NOT NULL DEFAULT 0, telemetry TEXT, capabilities TEXT NOT NULL DEFAULT '[]',
        last_location TEXT, location_floor INTEGER NOT NULL DEFAULT 0, wg_psk TEXT);
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
        id INTEGER PRIMARY KEY, at INTEGER NOT NULL, action TEXT NOT NULL, device_id TEXT, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS location_history(
        device_id TEXT NOT NULL REFERENCES devices(id), observed_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL,
        accuracy REAL NOT NULL, PRIMARY KEY(device_id,observed_at));
      CREATE TABLE IF NOT EXISTS state_history(
        id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT NOT NULL REFERENCES devices(id),
        received_at INTEGER NOT NULL, battery INTEGER NOT NULL, charging INTEGER NOT NULL,
        device_owner INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS state_history_device_time ON state_history(device_id,received_at,id);")?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS device_policies(
        device_id TEXT PRIMARY KEY REFERENCES devices(id), revision INTEGER NOT NULL, policy TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dns_summary(
        device_id TEXT NOT NULL REFERENCES devices(id), bucket INTEGER NOT NULL, domain TEXT NOT NULL,
        queries INTEGER NOT NULL, activities INTEGER NOT NULL, last_window INTEGER NOT NULL,
        first_at INTEGER NOT NULL,last_at INTEGER NOT NULL, answers INTEGER NOT NULL,nxdomain INTEGER NOT NULL,
        errors INTEGER NOT NULL,a INTEGER NOT NULL,aaaa INTEGER NOT NULL,https INTEGER NOT NULL,other INTEGER NOT NULL,
        PRIMARY KEY(device_id,bucket,domain));")?;
    // Upgrade the initial schema without losing an offline phone's existing fix.
    let columns = tx
        .prepare("PRAGMA table_info(devices)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?;
    if !columns.iter().any(|c| c == "last_location") {
        tx.execute("ALTER TABLE devices ADD COLUMN last_location TEXT", [])?;
        tx.execute("UPDATE devices SET last_location=json_extract(telemetry,'$.location')
            WHERE revoked=0 AND json_valid(telemetry) AND json_type(telemetry,'$.location')='object'", [])?;
        tx.execute(
            "UPDATE devices SET telemetry=json_set(telemetry,'$.location',NULL)
            WHERE json_valid(telemetry)",
            [],
        )?;
    }
    if !columns.iter().any(|c| c == "location_floor") {
        tx.execute(
            "ALTER TABLE devices ADD COLUMN location_floor INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }
    if !columns.iter().any(|c| c == "wg_psk") {
        tx.execute("ALTER TABLE devices ADD COLUMN wg_psk TEXT", [])?;
    }
    if !columns.iter().any(|c| c == "management_report") {
        tx.execute("ALTER TABLE devices ADD COLUMN management_report TEXT", [])?;
    }
    // Run exactly once: restarting after erasure must never resurrect an old point.
    let history_migrated: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_user_version WHERE user_version>=2)",
        [],
        |r| r.get(0),
    )?;
    if !history_migrated {
        tx.execute(
            "INSERT OR IGNORE INTO location_history
            SELECT id,json_extract(last_location,'$.observed_at'),COALESCE(last_seen,created),
              json_extract(last_location,'$.latitude'),json_extract(last_location,'$.longitude'),
              json_extract(last_location,'$.accuracy') FROM devices
            WHERE revoked=0 AND json_valid(last_location) AND json_type(last_location)='object'",
            [],
        )?;
        tx.execute_batch("PRAGMA user_version=2;")?;
    }
    tx.commit()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initial_schema_upgrade_preserves_offline_location_and_does_not_restore_erased_data() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE devices(
            id TEXT PRIMARY KEY, name TEXT NOT NULL, public_key TEXT, wg_key TEXT UNIQUE NOT NULL,
            address TEXT UNIQUE NOT NULL, created INTEGER NOT NULL, last_seen INTEGER,
            revoked INTEGER NOT NULL DEFAULT 0, telemetry TEXT, capabilities TEXT NOT NULL DEFAULT '[]');").unwrap();
        let old = serde_json::json!({"battery":21,"charging":false,"device_owner":false,"capabilities":[],
            "location":{"latitude":37.78,"longitude":-122.42,"accuracy":12,"observed_at":1000}});
        db.execute("INSERT INTO devices(id,name,wg_key,address,created,last_seen,telemetry) VALUES('test','Test phone','public-test-key','10.77.0.2',1,1000,?)", [old.to_string()]).unwrap();
        initialize(&db).unwrap();
        let (state, location, floor): (String, String, i64) = db
            .query_row(
                "SELECT telemetry,last_location,location_floor FROM devices WHERE id='test'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&location).unwrap(),
            old["location"]
        );
        assert!(serde_json::from_str::<serde_json::Value>(&state).unwrap()["location"].is_null());
        assert_eq!(floor, 0);
        assert_eq!(
            db.query_row(
                "SELECT observed_at FROM location_history WHERE device_id='test'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1000
        );
        db.execute("DELETE FROM location_history WHERE device_id='test'", [])
            .unwrap();
        db.execute(
            "UPDATE devices SET last_location=NULL,location_floor=2000 WHERE id='test'",
            [],
        )
        .unwrap();
        initialize(&db).unwrap();
        let (location, floor): (Option<String>, i64) = db
            .query_row(
                "SELECT last_location,location_floor FROM devices WHERE id='test'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(location.is_none());
        assert_eq!(floor, 2000);
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM location_history", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
}
