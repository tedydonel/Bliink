use base64::Engine;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// Generate a JPEG thumbnail for any file the OS can preview (videos get a
/// poster frame via the Windows Shell, same as Explorer). Falls back to
/// decoding common image formats directly. None when no preview exists.
pub async fn thumbnail_jpeg(path: PathBuf, max_px: u32, quality: u8) -> Option<Vec<u8>> {
    tokio::task::spawn_blocking(move || {
        #[cfg(windows)]
        if let Some(jpeg) = shell_thumbnail(&path, max_px, quality) {
            return Some(jpeg);
        }
        image_thumbnail(&path, max_px, quality)
    })
    .await
    .ok()
    .flatten()
}

pub fn to_data_url(jpeg: &[u8]) -> String {
    format!(
        "data:image/jpeg;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(jpeg)
    )
}

/// Disk-cached thumbnail as a data URL, keyed by path + mtime + size.
pub async fn cached_thumbnail_data_url(
    cache_dir: &Path,
    path: &Path,
    max_px: u32,
    quality: u8,
) -> Option<String> {
    let meta = tokio::fs::metadata(path).await.ok()?;
    if !meta.is_file() {
        return None;
    }
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let key = hex::encode(Sha256::digest(format!(
        "{}|{}|{}|{}",
        path.display(),
        mtime,
        meta.len(),
        max_px
    )));
    let cache_path = cache_dir.join(format!("{}.jpg", key));

    if let Ok(bytes) = tokio::fs::read(&cache_path).await {
        return Some(to_data_url(&bytes));
    }

    let jpeg = thumbnail_jpeg(path.to_path_buf(), max_px, quality).await?;
    let _ = tokio::fs::create_dir_all(cache_dir).await;
    let _ = tokio::fs::write(&cache_path, &jpeg).await;
    Some(to_data_url(&jpeg))
}

/// Pure-Rust fallback for common image formats (also the only path on
/// non-Windows platforms).
fn image_thumbnail(path: &Path, max_px: u32, quality: u8) -> Option<Vec<u8>> {
    let ext = path.extension()?.to_str()?.to_lowercase();
    if !matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp"
    ) {
        return None;
    }
    let img = image::open(path).ok()?;
    let thumb = img.thumbnail(max_px, max_px).to_rgb8();
    encode_jpeg(&thumb, quality)
}

fn encode_jpeg(img: &image::RgbImage, quality: u8) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality);
    encoder
        .encode(
            img.as_raw(),
            img.width(),
            img.height(),
            image::ExtendedColorType::Rgb8,
        )
        .ok()?;
    Some(out)
}

/// Ask the Windows Shell for the file's thumbnail — the same engine
/// Explorer uses, so videos, images, PDFs etc. work with installed codecs.
#[cfg(windows)]
fn shell_thumbnail(path: &Path, max_px: u32, quality: u8) -> Option<Vec<u8>> {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{
        DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{
        IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK,
        SIIGBF_THUMBNAILONLY,
    };

    let abs = path.canonicalize().ok()?;
    let path_str = abs.to_string_lossy().to_string();

    unsafe {
        // Ignore failure — the thread may already be initialized.
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        let factory: IShellItemImageFactory =
            SHCreateItemFromParsingName(&HSTRING::from(path_str.as_str()), None).ok()?;

        let hbitmap = factory
            .GetImage(
                SIZE {
                    cx: max_px as i32,
                    cy: max_px as i32,
                },
                SIIGBF_THUMBNAILONLY | SIIGBF_BIGGERSIZEOK,
            )
            .ok()?;

        let mut bmp = BITMAP::default();
        let got = GetObjectW(
            hbitmap.into(),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bmp as *mut BITMAP as *mut core::ffi::c_void),
        );
        if got == 0 || bmp.bmWidth <= 0 || bmp.bmHeight <= 0 {
            let _ = DeleteObject(hbitmap.into());
            return None;
        }
        let (w, h) = (bmp.bmWidth, bmp.bmHeight);

        let mut info = BITMAPINFO::default();
        info.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h, // top-down rows
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        };

        let mut pixels = vec![0u8; (w as usize) * (h as usize) * 4];
        let hdc = GetDC(None);
        let lines = GetDIBits(
            hdc,
            hbitmap,
            0,
            h as u32,
            Some(pixels.as_mut_ptr() as *mut core::ffi::c_void),
            &mut info,
            DIB_RGB_COLORS,
        );
        ReleaseDC(None, hdc);
        let _ = DeleteObject(hbitmap.into());

        if lines == 0 {
            return None;
        }

        // BGRA -> RGB
        let mut img = image::RgbImage::new(w as u32, h as u32);
        for (i, px) in pixels.chunks_exact(4).enumerate() {
            let x = (i % w as usize) as u32;
            let y = (i / w as usize) as u32;
            img.put_pixel(x, y, image::Rgb([px[2], px[1], px[0]]));
        }
        encode_jpeg(&img, quality)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn generates_thumbnail_for_png() {
        let dir = std::env::temp_dir().join("bliink-thumb-test");
        std::fs::create_dir_all(&dir).unwrap();
        let png_path = dir.join("test.png");
        let img = image::RgbImage::from_fn(64, 64, |x, y| {
            image::Rgb([(x * 4) as u8, (y * 4) as u8, 128])
        });
        img.save(&png_path).unwrap();

        let jpeg = thumbnail_jpeg(png_path.clone(), 96, 60).await;
        assert!(jpeg.is_some(), "expected a thumbnail for a PNG file");
        let jpeg = jpeg.unwrap();
        assert!(!jpeg.is_empty());
        // JPEG magic bytes
        assert_eq!(&jpeg[..2], &[0xFF, 0xD8]);

        let _ = std::fs::remove_file(&png_path);
    }

    #[tokio::test]
    async fn no_thumbnail_for_unknown_type() {
        let dir = std::env::temp_dir().join("bliink-thumb-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("test.xyz123");
        std::fs::write(&path, b"not an image").unwrap();

        let jpeg = thumbnail_jpeg(path.clone(), 96, 60).await;
        assert!(jpeg.is_none());

        let _ = std::fs::remove_file(&path);
    }
}
