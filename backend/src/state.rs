use std::sync::Arc;

use sqlx::PgPool;

use crate::config::Config;
use crate::services::{off::OpenFoodFactsClient, usda::UsdaClient};

/// Shared, cheap-to-clone application state handed to every handler.
#[derive(Clone)]
pub struct AppState(Arc<Inner>);

pub struct Inner {
    pub db: PgPool,
    pub config: Config,
    pub usda: UsdaClient,
    pub off: OpenFoodFactsClient,
}

impl AppState {
    pub fn new(db: PgPool, config: Config, http: reqwest::Client) -> Self {
        let usda = UsdaClient::new(
            http.clone(),
            config.usda_base_url.clone(),
            config.usda_api_key.clone(),
        );
        let off = OpenFoodFactsClient::new(http, config.off_base_url.clone());
        Self(Arc::new(Inner {
            db,
            config,
            usda,
            off,
        }))
    }
}

impl std::ops::Deref for AppState {
    type Target = Inner;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
