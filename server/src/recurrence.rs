use crate::security::{ApiResult, bad};
use chrono::{DateTime, Duration, LocalResult, NaiveTime, TimeZone};
use chrono_tz::Tz;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;

#[derive(Deserialize, Default)]
pub struct Recurrence {
    pub every: Option<i64>,
    pub daily: Option<String>,
    pub timezone: Option<String>,
    pub tolerance: Option<i64>,
}
impl Recurrence {
    pub fn validate(&self, from: i64, to: i64) -> ApiResult<()> {
        if self.every.is_some_and(|v| !(60..=86400).contains(&v))
            || (self.every.is_some() && self.daily.is_some())
            || (self.daily.is_none() && (self.timezone.is_some() || self.tolerance.is_some()))
        {
            return Err(bad(
                "Choose an interval from 60 to 86400 seconds, or a daily time",
            ));
        }
        if let Some(every) = self.every
            && (to - from > 366 * 86400 || (to - from) / every + 1 > 10000)
        {
            return Err(bad(
                "Interval lookup allows at most 366 days and 10000 time buckets; choose a smaller range or wider interval",
            ));
        }
        if let Some(daily) = &self.daily
            && (to > 253402300799
                || to - from > 366 * 86400
                || daily.len() != 5
                || NaiveTime::parse_from_str(daily, "%H:%M").is_err()
                || self
                    .timezone
                    .as_ref()
                    .and_then(|v| v.parse::<Tz>().ok())
                    .is_none()
                || !(0..=7200).contains(&self.tolerance.unwrap_or(900))
                || DateTime::from_timestamp(from, 0).is_none()
                || DateTime::from_timestamp(to, 0).is_none())
        {
            return Err(bad(
                "Daily lookup needs HH:MM, an IANA timezone, a tolerance up to 7200 seconds and at most 366 days",
            ));
        }
        Ok(())
    }
    // Select before pagination, so a bucket or daily slot cannot reappear on another page.
    #[allow(clippy::too_many_arguments)]
    pub fn keys(
        &self,
        db: &Connection,
        id: &str,
        kind: &str,
        from: i64,
        to: i64,
        before: i64,
        limit: usize,
    ) -> ApiResult<Option<Vec<i64>>> {
        let (table, clock, key) = if kind == "locations" {
            ("location_history", "observed_at", "observed_at")
        } else if kind == "network" {
            ("network_history", "observed_at", "observed_at")
        } else {
            ("state_history", "received_at", "id")
        };
        if let Some(every) = self.every {
            let sql = format!(
                "SELECT selected FROM (SELECT MAX({key}) AS selected FROM {table} WHERE device_id=?1 AND {clock}>=?2 AND {clock}<=?3 GROUP BY ({clock}-?2)/?4) WHERE selected<?5 ORDER BY selected DESC LIMIT ?6"
            );
            let mut q = db.prepare(&sql)?;
            return Ok(Some(
                q.query_map(
                    params![id, from, to, every, before, limit as i64 + 1],
                    |r| r.get(0),
                )?
                .collect::<Result<Vec<i64>, _>>()?,
            ));
        }
        let Some(daily) = &self.daily else {
            return Ok(None);
        };
        let zone: Tz = self.timezone.as_ref().unwrap().parse().unwrap();
        let time = NaiveTime::parse_from_str(daily, "%H:%M").unwrap();
        let tolerance = self.tolerance.unwrap_or(900);
        let mut day = DateTime::from_timestamp(from, 0)
            .unwrap()
            .with_timezone(&zone)
            .date_naive();
        let end = DateTime::from_timestamp(to, 0)
            .unwrap()
            .with_timezone(&zone)
            .date_naive();
        let mut selected = Vec::new();
        let sql = format!(
            "SELECT {key} FROM {table} WHERE device_id=?1 AND {clock}>=?2 AND {clock}<=?3 ORDER BY ABS({clock}-?4), {key} DESC LIMIT 1"
        );
        let mut q = db.prepare(&sql)?;
        while day <= end {
            // A nonexistent spring-forward time is skipped. A repeated fall-back time uses its first occurrence.
            let target = match zone.from_local_datetime(&day.and_time(time)) {
                LocalResult::Single(t) | LocalResult::Ambiguous(t, _) => Some(t.timestamp()),
                LocalResult::None => None,
            };
            if let Some(target) = target.filter(|t| *t >= from && *t <= to)
                && let Some(value) = q
                    .query_row(
                        params![
                            id,
                            from.max(target - tolerance),
                            to.min(target + tolerance),
                            target
                        ],
                        |r| r.get::<_, i64>(0),
                    )
                    .optional()?
                && value < before
            {
                selected.push(value);
            }
            day += Duration::days(1);
        }
        selected.sort_unstable_by(|a, b| b.cmp(a));
        selected.dedup();
        selected.truncate(limit + 1);
        Ok(Some(selected))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interval_work_is_bounded_before_opening_a_scan() {
        let minute = Recurrence {
            every: Some(60),
            ..Default::default()
        };
        assert!(minute.validate(0, 599999).is_ok());
        assert!(minute.validate(0, 600000).is_err());
        let day = Recurrence {
            every: Some(86400),
            ..Default::default()
        };
        assert!(day.validate(0, 366 * 86400).is_ok());
        assert!(day.validate(0, 366 * 86400 + 1).is_err());
    }
    #[test]
    fn recurrence_preserves_buckets_across_pages_and_handles_dst() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE location_history(device_id TEXT,observed_at INTEGER); INSERT INTO location_history VALUES('p',100),('p',120),('p',390),('p',410),('p',710);").unwrap();
        let interval = Recurrence {
            every: Some(300),
            ..Default::default()
        };
        assert_eq!(
            interval
                .keys(&db, "p", "locations", 0, 1000, i64::MAX, 1)
                .unwrap()
                .unwrap(),
            vec![710, 410]
        );
        assert_eq!(
            interval
                .keys(&db, "p", "locations", 0, 1000, 410, 10)
                .unwrap()
                .unwrap(),
            vec![120]
        );
        let r = Recurrence {
            daily: Some("02:30".into()),
            timezone: Some("America/New_York".into()),
            ..Default::default()
        };
        r.validate(1741410000, 1741669200).unwrap();
        // 2025-03-09 02:30 does not exist. No other day's nearest record is substituted.
        db.execute(
            "INSERT INTO location_history VALUES('p',?)",
            [1741505400i64],
        )
        .unwrap();
        assert!(
            r.keys(&db, "p", "locations", 1741410000, 1741669200, i64::MAX, 100)
                .unwrap()
                .unwrap()
                .is_empty()
        );
        assert!(
            Recurrence {
                every: Some(0),
                ..Default::default()
            }
            .validate(0, 10)
            .is_err()
        );
    }
}
