//! Administrator credentials are salted Argon2id verifiers, never recoverable passwords.
use crate::{security, store};
use argon2::PasswordHash;
use rusqlite::{Connection, OptionalExtension};
use std::{fs, io::Read, path::Path};
use zeroize::Zeroizing;

pub fn validate_password(password: &str) -> Result<(), &'static str> {
    if password.chars().count() < 16
        || password.len() > 1024
        || password.chars().any(char::is_control)
    {
        return Err(
            "Use at least 16 characters, at most 1024 UTF-8 bytes, and no control characters",
        );
    }
    Ok(())
}

pub fn read_password() -> Result<Zeroizing<String>, Box<dyn std::error::Error>> {
    let mut password = Zeroizing::new(String::new());
    std::io::stdin().take(1025).read_to_string(&mut password)?;
    validate_password(&password)?;
    Ok(password)
}

pub fn current(db: &Connection) -> rusqlite::Result<Option<String>> {
    db.query_row("SELECT hash FROM admin_credential WHERE id=1", [], |row| {
        row.get(0)
    })
    .optional()
}

pub fn replace(db: &Connection, hash: &str) -> rusqlite::Result<()> {
    let tx = db.unchecked_transaction()?;
    tx.execute("INSERT INTO admin_credential(id,hash) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET hash=excluded.hash", [hash])?;
    tx.execute("DELETE FROM sessions", [])?;
    store::audit(&tx, "admin.password_changed", None, "")?;
    tx.commit()
}

pub fn change(db: &Connection, expected: &str, replacement: &str) -> rusqlite::Result<bool> {
    let tx = db.unchecked_transaction()?;
    if tx.execute(
        "UPDATE admin_credential SET hash=? WHERE id=1 AND hash=?",
        [replacement, expected],
    )? != 1
    {
        return Ok(false);
    }
    tx.execute("DELETE FROM sessions", [])?;
    store::audit(&tx, "admin.password_changed", None, "")?;
    tx.commit()?;
    Ok(true)
}

pub fn initialize(db: &Connection, dir: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let bootstrap = dir.join("admin-password.hash");
    let legacy = dir.join("admin-password");
    for path in [&bootstrap, &legacy] {
        if path.is_symlink() {
            return Err("Credential files must not be symlinks".into());
        }
    }
    if current(db)?.is_none() {
        let hash = if bootstrap.exists() {
            let hash = fs::read_to_string(&bootstrap)?;
            let parsed =
                PasswordHash::new(hash.trim()).map_err(|_| "Invalid bootstrap password hash")?;
            if parsed.algorithm.as_str() != "argon2id"
                || parsed.salt.is_none()
                || parsed.hash.is_none()
            {
                return Err("An Argon2id password verifier is required".into());
            }
            hash.trim().to_owned()
        } else if legacy.exists() {
            // One-time migration preserves the existing login, including its old
            // trim semantics. Commit the verifier before removing plaintext.
            let password = Zeroizing::new(fs::read_to_string(&legacy)?);
            validate_password(password.trim())?;
            security::password_hash(password.trim()).map_err(|_| "Password hashing failed")?
        } else {
            return Err("Administrator password is not configured. Run the installer or the host password command".into());
        };
        replace(db, &hash)?;
    }
    // Also finishes cleanup if a process died after committing the migration.
    for path in [&bootstrap, &legacy] {
        if path.exists() {
            fs::remove_file(path)?;
        }
    }
    fs::File::open(dir)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_limits_do_not_silently_trim() {
        assert!(validate_password("a short password").is_ok());
        assert!(validate_password("short").is_err());
        assert!(validate_password(&"a".repeat(1025)).is_err());
        assert!(validate_password("a password with\nnewline").is_err());
        let hash = security::password_hash("  spaced password  ").unwrap();
        assert!(security::password_matches("  spaced password  ", &hash));
        assert!(!security::password_matches("spaced password", &hash));
    }

    #[test]
    fn failed_rotation_rolls_back_verifier_and_session_revocation() {
        let db = store::open(Path::new(":memory:")).unwrap();
        replace(&db, "old-test-verifier").unwrap();
        db.execute("INSERT INTO sessions VALUES('test-session',9999999999)", [])
            .unwrap();
        db.execute_batch("CREATE TRIGGER fail_rotation BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT,'test fault'); END;").unwrap();
        assert!(change(&db, "old-test-verifier", "new-test-verifier").is_err());
        assert_eq!(current(&db).unwrap().as_deref(), Some("old-test-verifier"));
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM sessions", [], |row| row
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert!(!change(&db, "stale-test-verifier", "new-test-verifier").unwrap());
    }
}
