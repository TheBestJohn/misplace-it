use std::env;

/// Everything the process needs from the environment, resolved once at boot so
/// a missing variable fails fast instead of at the first request that needs it.
#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    pub bind_addr: String,
    pub jwt_secret: String,
    pub jwt_ttl_hours: i64,
    pub cors_origins: Vec<String>,
    /// USDA FoodData Central key. Absent => USDA search is disabled, not fatal.
    pub usda_api_key: Option<String>,
    pub usda_base_url: String,
    pub off_base_url: String,
    pub allow_registration: bool,
}

#[derive(Debug, thiserror::Error)]
#[error("missing required environment variable: {0}")]
pub struct MissingEnv(&'static str);

impl Config {
    pub fn from_env() -> Result<Self, MissingEnv> {
        Ok(Self {
            database_url: req("DATABASE_URL")?,
            bind_addr: opt("BIND_ADDR").unwrap_or_else(|| "0.0.0.0:8080".into()),
            jwt_secret: req("JWT_SECRET")?,
            jwt_ttl_hours: opt("JWT_TTL_HOURS")
                .and_then(|v| v.parse().ok())
                .unwrap_or(24 * 7),
            cors_origins: opt("CORS_ORIGINS")
                .map(|v| {
                    v.split(',')
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(String::from)
                        .collect()
                })
                .unwrap_or_default(),
            usda_api_key: opt("USDA_API_KEY").filter(|k| !k.is_empty()),
            usda_base_url: opt("USDA_BASE_URL")
                .unwrap_or_else(|| "https://api.nal.usda.gov/fdc/v1".into()),
            off_base_url: opt("OFF_BASE_URL")
                .unwrap_or_else(|| "https://world.openfoodfacts.org".into()),
            allow_registration: opt("ALLOW_REGISTRATION")
                .map(|v| v != "false" && v != "0")
                .unwrap_or(true),
        })
    }
}

fn req(key: &'static str) -> Result<String, MissingEnv> {
    env::var(key).ok().filter(|v| !v.is_empty()).ok_or(MissingEnv(key))
}

fn opt(key: &str) -> Option<String> {
    env::var(key).ok().filter(|v| !v.is_empty())
}
