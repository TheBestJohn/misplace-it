//! Photo storage.
//!
//! Uploads are decoded, downscaled and re-encoded rather than stored as
//! received. That costs a little CPU per upload and buys three things:
//!
//!   * **Privacy.** Phone photos carry EXIF, which routinely includes GPS
//!     coordinates and a device serial. Re-encoding drops all of it. For
//!     progress photos — often taken at home — this is the important one.
//!   * **A bound on size.** A 12 MP upload becomes a few hundred kilobytes,
//!     so the volume grows predictably.
//!   * **A guarantee it is an image.** Anything that does not decode is
//!     rejected, so a renamed file cannot be stored and later served back.

use std::path::{Path, PathBuf};

use image::imageops::FilterType;
use image::ImageReader;
use uuid::Uuid;

use crate::error::ApiError;

/// Longest edge after downscaling. Large enough to see detail in a progress
/// photo, small enough that a few hundred of them are megabytes, not gigabytes.
const MAX_EDGE: u32 = 1600;

/// JPEG quality. 82 is the usual knee: visually hard to tell from the original,
/// roughly a third of the bytes of quality 95.
const JPEG_QUALITY: u8 = 82;

pub struct StoredPhoto {
    pub relative_path: String,
    pub content_type: &'static str,
    pub byte_size: i64,
    pub width: i32,
    pub height: i32,
}

#[derive(Clone)]
pub struct PhotoStore {
    root: PathBuf,
    max_upload_bytes: usize,
}

impl PhotoStore {
    pub fn new(root: impl Into<PathBuf>, max_upload_bytes: usize) -> Self {
        Self {
            root: root.into(),
            max_upload_bytes,
        }
    }

    /// Create the storage root if it does not exist, and fail loudly at boot if
    /// it is not writable — better than discovering it on someone's first
    /// upload.
    pub async fn ensure_ready(&self) -> anyhow::Result<()> {
        tokio::fs::create_dir_all(&self.root).await?;
        let probe = self.root.join(".write-probe");
        tokio::fs::write(&probe, b"ok").await.map_err(|e| {
            anyhow::anyhow!(
                "photo directory {} is not writable: {e}",
                self.root.display()
            )
        })?;
        tokio::fs::remove_file(&probe).await.ok();
        Ok(())
    }

    /// Decode, downscale, re-encode and write. Returns what to record in the
    /// database.
    pub async fn store(&self, user_id: Uuid, bytes: Vec<u8>) -> Result<StoredPhoto, ApiError> {
        if bytes.is_empty() {
            return Err(ApiError::bad_request("the uploaded file is empty"));
        }
        if bytes.len() > self.max_upload_bytes {
            return Err(ApiError::bad_request(format!(
                "image is larger than the {} MB limit",
                self.max_upload_bytes / (1024 * 1024)
            )));
        }

        // Decoding is CPU-bound and can take tens of milliseconds on a large
        // photo, which would stall other requests on this worker thread.
        let encoded = tokio::task::spawn_blocking(move || transcode(&bytes))
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!("image task failed: {e}")))??;

        // Shard by user and month so no single directory accumulates every
        // photo ever uploaded.
        let now = chrono::Utc::now();
        let dir = format!("{}/{}", user_id, now.format("%Y-%m"));
        let name = format!("{}.jpg", Uuid::new_v4());
        let relative_path = format!("{dir}/{name}");

        let abs_dir = self.root.join(&dir);
        tokio::fs::create_dir_all(&abs_dir)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!("creating photo dir: {e}")))?;
        tokio::fs::write(abs_dir.join(&name), &encoded.bytes)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!("writing photo: {e}")))?;

        Ok(StoredPhoto {
            relative_path,
            content_type: "image/jpeg",
            byte_size: encoded.bytes.len() as i64,
            width: encoded.width as i32,
            height: encoded.height as i32,
        })
    }

    pub async fn read(&self, relative_path: &str) -> Result<Vec<u8>, ApiError> {
        let path = self.resolve(relative_path)?;
        tokio::fs::read(&path).await.map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => ApiError::NotFound("photo"),
            _ => ApiError::Internal(anyhow::anyhow!("reading photo: {e}")),
        })
    }

    pub async fn remove(&self, relative_path: &str) {
        if let Ok(path) = self.resolve(relative_path) {
            // A missing file is the desired end state either way, so a failure
            // here is logged rather than surfaced.
            if let Err(e) = tokio::fs::remove_file(&path).await {
                if e.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!(error = %e, path = %path.display(), "could not delete photo file");
                }
            }
        }
    }

    /// Join a stored path to the root, refusing anything that escapes it.
    ///
    /// These paths are generated by `store` and never come from a client, so
    /// this is belt and braces — but a traversal here would read arbitrary
    /// files off the host, so it is worth the six lines.
    fn resolve(&self, relative_path: &str) -> Result<PathBuf, ApiError> {
        let candidate = Path::new(relative_path);
        if candidate.is_absolute()
            || candidate
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(ApiError::bad_request("invalid photo path"));
        }
        Ok(self.root.join(candidate))
    }
}

#[cfg_attr(test, derive(Debug))]
struct Encoded {
    bytes: Vec<u8>,
    width: u32,
    height: u32,
}

fn transcode(bytes: &[u8]) -> Result<Encoded, ApiError> {
    // Guess the format from the content, not from a filename or a client's
    // claimed content type.
    let reader = ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| ApiError::bad_request(format!("could not read the image: {e}")))?;

    let image = reader
        .decode()
        .map_err(|_| ApiError::bad_request("that file is not an image we can read"))?;

    // `thumbnail` preserves the aspect ratio and only ever shrinks, so a small
    // photo is not upscaled into a bigger file than it arrived as.
    let resized = if image.width() > MAX_EDGE || image.height() > MAX_EDGE {
        image.resize(MAX_EDGE, MAX_EDGE, FilterType::Lanczos3)
    } else {
        image
    };

    let rgb = resized.to_rgb8();
    let (width, height) = (rgb.width(), rgb.height());

    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY)
        .encode(rgb.as_raw(), width, height, image::ExtendedColorType::Rgb8)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("encoding photo: {e}")))?;

    Ok(Encoded {
        bytes: out,
        width,
        height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png(width: u32, height: u32) -> Vec<u8> {
        let img = image::RgbImage::from_fn(width, height, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 128])
        });
        let mut out = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
            .unwrap();
        out
    }

    #[test]
    fn oversized_images_are_downscaled_to_the_long_edge() {
        let encoded = transcode(&png(4000, 3000)).unwrap();
        assert_eq!(encoded.width, MAX_EDGE);
        assert_eq!(encoded.height, 1200);
    }

    #[test]
    fn small_images_are_not_upscaled() {
        let encoded = transcode(&png(320, 240)).unwrap();
        assert_eq!((encoded.width, encoded.height), (320, 240));
    }

    #[test]
    fn a_non_image_is_rejected_rather_than_stored() {
        let err = transcode(b"#!/bin/sh\necho not a photo\n").unwrap_err();
        assert!(matches!(err, ApiError::BadRequest(_)), "got {err:?}");
    }

    /// Re-encoding is what drops EXIF, so the output must not carry the marker.
    #[test]
    fn output_is_jpeg_without_an_exif_segment() {
        let encoded = transcode(&png(800, 600)).unwrap();
        assert_eq!(&encoded.bytes[0..2], &[0xFF, 0xD8], "not a JPEG");
        assert!(
            !encoded.bytes.windows(4).any(|w| w == b"Exif"),
            "EXIF survived re-encoding",
        );
    }

    /// The boot check has to fail loudly on a storage root it cannot use.
    /// This is what stops the service coming up and then rejecting the first
    /// upload — and it is what caught a Docker volume being created root-owned
    /// under a non-root runtime user.
    ///
    /// The unusable case here is a FILE where the directory should be, not a
    /// permission bit: root ignores permission bits, so a chmod-based test
    /// would pass in a root container and prove nothing.
    #[tokio::test]
    async fn ensure_ready_fails_when_the_root_cannot_be_used() {
        let file = std::env::temp_dir().join(format!("nom-inal-probe-{}", uuid::Uuid::new_v4()));
        tokio::fs::write(&file, b"not a directory").await.unwrap();

        let store = PhotoStore::new(file.join("photos"), 1024);
        assert!(
            store.ensure_ready().await.is_err(),
            "a storage root that cannot be created must fail at boot",
        );

        tokio::fs::remove_file(&file).await.ok();
    }

    #[tokio::test]
    async fn ensure_ready_creates_a_usable_root() {
        let dir = std::env::temp_dir().join(format!("nom-inal-ok-{}", uuid::Uuid::new_v4()));
        let store = PhotoStore::new(&dir, 1024);

        store.ensure_ready().await.expect("should create the root");
        assert!(dir.is_dir(), "the root should exist after the check");
        // The probe must not be left behind.
        assert!(
            !dir.join(".write-probe").exists(),
            "probe file was not cleaned up"
        );

        tokio::fs::remove_dir_all(&dir).await.ok();
    }

    #[test]
    fn paths_cannot_escape_the_storage_root() {
        let store = PhotoStore::new("/var/lib/nom-inal/photos", 1024);
        assert!(store.resolve("../../etc/passwd").is_err());
        assert!(store.resolve("/etc/passwd").is_err());
        assert!(store.resolve("user/2026-03/photo.jpg").is_ok());
    }
}
