use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use validator::Validate;

/// What a reminder watches for.
///
/// Each kind maps to something already recorded, so "are you overdue" is
/// derived from your actual data rather than tracked separately — there is
/// nothing to keep in sync and nothing to catch up after downtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReminderKind {
    /// Days since the most recent weight entry.
    WeighIn,
    /// Days since the most recent day with any diary entry.
    FoodLog,
    /// Days since the most recent photo attached to a weigh-in.
    ProgressPhoto,
}

pub const ALL_KINDS: [ReminderKind; 3] = [
    ReminderKind::WeighIn,
    ReminderKind::FoodLog,
    ReminderKind::ProgressPhoto,
];

impl ReminderKind {
    pub fn key(&self) -> &'static str {
        match self {
            Self::WeighIn => "weigh_in",
            Self::FoodLog => "food_log",
            Self::ProgressPhoto => "progress_photo",
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            Self::WeighIn => "Weigh in",
            Self::FoodLog => "Log your food",
            Self::ProgressPhoto => "Take a progress photo",
        }
    }

    /// A sensible starting cadence for each.
    pub fn default_every_days(&self) -> i32 {
        match self {
            Self::WeighIn => 7,
            Self::FoodLog => 1,
            Self::ProgressPhoto => 28,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Reminder {
    pub kind: ReminderKind,
    pub label: &'static str,
    pub every_days: i32,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Validate, ToSchema)]
pub struct ReminderInput {
    pub kind: ReminderKind,
    #[validate(range(min = 1, max = 365, message = "must be between 1 and 365 days"))]
    pub every_days: i32,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize, Validate, ToSchema)]
pub struct ReplaceRemindersRequest {
    #[validate(nested)]
    #[validate(length(max = 3, message = "may contain at most one entry per kind"))]
    pub reminders: Vec<ReminderInput>,
}

/// Where a reminder stands right now.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct ReminderStatus {
    pub kind: ReminderKind,
    pub label: &'static str,
    pub every_days: i32,
    pub enabled: bool,
    /// The most recent day this activity happened, if ever.
    pub last_on: Option<NaiveDate>,
    /// Whole days since then. `None` when it has never happened.
    pub days_since: Option<i64>,
    /// True when `days_since` has reached the cadence, or nothing is recorded.
    pub due: bool,
    /// How many days past the cadence. 0 when not yet due.
    pub overdue_days: i64,
    /// A ready-made sentence, so every client words it the same way.
    pub message: String,
}

impl ReminderStatus {
    pub fn evaluate(
        kind: ReminderKind,
        every_days: i32,
        enabled: bool,
        last_on: Option<NaiveDate>,
        today: NaiveDate,
    ) -> Self {
        let days_since = last_on.map(|d| (today - d).num_days());

        // Never recorded counts as due: the whole point of the reminder is to
        // get the first one out of you.
        let due = match days_since {
            Some(days) => days >= every_days as i64,
            None => true,
        };

        let overdue_days = days_since
            .map(|days| (days - every_days as i64).max(0))
            .unwrap_or(0);

        let message = match (days_since, due) {
            (None, _) => format!("{} — nothing recorded yet.", kind.label()),
            (Some(0), _) => format!("{} — done today.", kind.label()),
            (Some(days), true) => format!(
                "It's been {} since your last {}.",
                humanize(days),
                match kind {
                    ReminderKind::WeighIn => "weigh-in",
                    ReminderKind::FoodLog => "food log",
                    ReminderKind::ProgressPhoto => "progress photo",
                },
            ),
            (Some(days), false) => format!("{} — last done {} ago.", kind.label(), humanize(days)),
        };

        Self {
            kind,
            label: kind.label(),
            every_days,
            enabled,
            last_on,
            days_since,
            due,
            overdue_days,
            message,
        }
    }
}

/// "three weeks" reads better than "21 days" in a nudge.
fn humanize(days: i64) -> String {
    match days {
        1 => "a day".into(),
        2..=13 => format!("{days} days"),
        14..=20 => "two weeks".into(),
        21..=27 => "three weeks".into(),
        28..=45 => "a month".into(),
        46..=364 => format!("{} months", (days as f64 / 30.44).round() as i64),
        _ => format!("{} years", (days as f64 / 365.25).round() as i64),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(s: &str) -> NaiveDate {
        s.parse().unwrap()
    }

    #[test]
    fn never_recorded_is_due() {
        let s = ReminderStatus::evaluate(ReminderKind::WeighIn, 7, true, None, day("2026-03-01"));
        assert!(s.due);
        assert_eq!(s.days_since, None);
        assert_eq!(s.overdue_days, 0);
        assert!(s.message.contains("nothing recorded yet"));
    }

    #[test]
    fn becomes_due_exactly_on_the_cadence() {
        let before = ReminderStatus::evaluate(
            ReminderKind::WeighIn,
            7,
            true,
            Some(day("2026-02-23")),
            day("2026-03-01"),
        );
        assert_eq!(before.days_since, Some(6));
        assert!(!before.due);

        let on = ReminderStatus::evaluate(
            ReminderKind::WeighIn,
            7,
            true,
            Some(day("2026-02-22")),
            day("2026-03-01"),
        );
        assert_eq!(on.days_since, Some(7));
        assert!(on.due);
        assert_eq!(on.overdue_days, 0);
    }

    /// The example from the request: three weeks since the last weigh-in.
    #[test]
    fn reads_as_a_sentence_a_person_would_say() {
        let s = ReminderStatus::evaluate(
            ReminderKind::WeighIn,
            7,
            true,
            Some(day("2026-02-08")),
            day("2026-03-01"),
        );
        assert_eq!(s.days_since, Some(21));
        assert_eq!(s.overdue_days, 14);
        assert_eq!(s.message, "It's been three weeks since your last weigh-in.");
    }

    #[test]
    fn done_today_is_not_due() {
        let s = ReminderStatus::evaluate(
            ReminderKind::FoodLog,
            1,
            true,
            Some(day("2026-03-01")),
            day("2026-03-01"),
        );
        assert!(!s.due);
        assert!(s.message.contains("done today"));
    }
}
